// What the customer app needs: phone sign-in, the member's home screen, offers, add-to-card and
// picking a points reward for the next visit. Members only ever see their own data.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { conditionPasses, inSchedule, inScope, type Actor, type Rule, type Transaction } from '../../engine/src/index.js';
import { localParts } from './dates.js';
import { lastDay, memberLine, rewardLabel, targetLabel } from './labels.js';
import { shortDate } from './dates.js';
import type { AppAuth, ConsoleMember, ConsoleRule, ConsoleStore } from './model.js';
import { ConsoleError, type Repo } from './repo.js';

/** Sends the sign-in code. See sms.ts for Twilio; without it, codes go to the server log. */
export type SmsSender = (phone: string, text: string) => void | Promise<void>;
export const logSender: SmsSender = (phone, text) => console.log(`[sms to ***${phone.slice(-4)}] ${text}`);

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;
const SESSION_DAYS = 90;
const FOOD_DRINK = ['coffee', 'fountain', 'sandwiches', 'hot-food', 'snacks', 'candy', 'energy', 'cold-drinks', 'beer', 'ice'];

import { nearestWithin, type Spot } from './geo.js';
import { mediaUrl } from './media.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const digits = (phone: unknown) => String(phone ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

export interface AppOffer {
  ruleId: string;
  name: string;
  kicker: string;
  kind: 'fuel' | 'food' | 'brand' | 'other';
  line: string;
  ends?: string;
  how: 'clip' | 'auto-pump' | 'auto-register' | 'punch';
  clipped: boolean;
  /** A near-store promo, unlocked because the member is close to a participating store. */
  nearby?: boolean;
  /** Uploaded artwork, always 16:9. Cards without it show `headline` on a colored panel. */
  imageUrl?: string;
  headline: string;
  featured: boolean;
}

export interface RedeemOption {
  ruleId: string;
  kind: 'fuel' | 'item';
  title: string;
  detail: string;
  costPoints: number;
  affordable: boolean;
  imageUrl?: string;
  headline: string;
  selected: boolean;
}


export function offerKind(r: ConsoleRule): AppOffer['kind'] {
  const e = r.effect;
  const cats = 'categories' in e ? (e.categories ?? []) : [];
  return r.fundedBy === 'manufacturer' ? 'brand' : e.type === 'fuelDiscount' ? 'fuel' : cats.some((c) => FOOD_DRINK.includes(c)) ? 'food' : 'other';
}

function birthdayLabel(mmdd: string, window: 'day' | 'week' | 'month'): string {
  const d = new Date(Date.UTC(2024, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3))));
  const month = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return window === 'month' ? `all of ${month}` : window === 'week' ? `the week of ${day}` : day;
}

/** The big text on a reward card without artwork, like "25¢ OFF" or "6TH FREE". */
export function promoHeadline(r: ConsoleRule): string {
  if (r.headline?.trim()) return r.headline.trim();
  const e = r.effect;
  const money = (c: number) => (c % 100 === 0 ? `$${c / 100}` : c < 100 ? `${c}¢` : `$${(c / 100).toFixed(2)}`);
  switch (e.type) {
    case 'fuelDiscount':
      return `${e.centsPerGallon}¢ OFF A GALLON`;
    case 'itemDiscount':
      return e.percentOff === 100 ? 'FREE' : e.percentOff !== undefined ? `${e.percentOff}% OFF` : `${money(e.centsOff ?? 0)} OFF`;
    case 'basketDiscount':
      return `${money(e.centsOff)} OFF`;
    case 'punchCard': {
      const n = e.every + 1;
      return `${n}${n % 10 === 2 && n !== 12 ? 'ND' : n % 10 === 3 && n !== 13 ? 'RD' : 'TH'} ONE FREE`;
    }
    case 'pointsFlat':
      return `+${e.points} POINTS`;
    case 'pointsPerDollar':
      return `${e.points}X POINTS`;
    case 'pointsPerGallon':
      return `${e.points} PTS A GALLON`;
  }
}

/** Empty means no email. Throws on something that is not an email address. */
function cleanEmail(raw: unknown): string | undefined {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new ConsoleError('Check the email address, or leave it blank.');
  return email;
}
export class MemberApi {
  constructor(
    private readonly repo: Repo,
    private readonly sendSms: SmsSender = logSender,
    private readonly clock: () => Date = () => new Date(),
    /** Returns the code in the API response; for local testing only, never in production. */
    private readonly exposeCodes = false,
  ) {}

  private get auth(): AppAuth {
    return (this.repo.data.auth ??= { codes: {}, sessions: {} });
  }

  private actor(m: ConsoleMember): Actor {
    return { role: 'jobber-admin', userId: `member:${m.id}` };
  }

  // ---- sign-in ----

  async requestCode(rawPhone: unknown): Promise<{ sent: true; devCode?: string }> {
    const phone = digits(rawPhone);
    if (phone.length !== 10) throw new ConsoleError('Enter your 10-digit mobile number.');
    const now = this.clock().getTime();
    const prev = this.auth.codes[phone];
    const recent = (prev?.sentAt ?? []).filter((t) => now - Date.parse(t) < 3_600_000);
    if (recent.length >= MAX_CODES_PER_HOUR) throw new ConsoleError('Too many codes sent. Try again in an hour.', 429);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.auth.codes[phone] = {
      hash: sha(`${phone}:${code}`),
      expiresAt: new Date(now + CODE_MINUTES * 60_000).toISOString(),
      attempts: 0,
      sentAt: [...recent, new Date(now).toISOString()],
    };
    this.repo.save();
    const name = this.repo.data.branding.programName;
    try {
      await this.sendSms(phone, `${code} is your ${name} code. It expires in ${CODE_MINUTES} minutes.`);
    } catch (err) {
      // A text that never went out shouldn't count toward the hourly limit or leave a usable code.
      if (prev) this.auth.codes[phone] = prev;
      else delete this.auth.codes[phone];
      this.repo.save();
      throw err;
    }
    return this.exposeCodes ? { sent: true, devCode: code } : { sent: true };
  }

  /**
   * Checks the code. A known phone signs in; a new phone joins when `signup` is given,
   * otherwise the app is told to ask for a first name first.
   */
  verify(
    rawPhone: unknown,
    code: unknown,
    signup?: { firstName?: string; smsOptIn?: boolean; homeStoreId?: string; email?: string; emailOptIn?: boolean },
  ): { token: string; isNew: boolean } | { needsSignup: true } {
    const phone = digits(rawPhone);
    const entry = this.auth.codes[phone];
    const now = this.clock().getTime();
    if (!entry || Date.parse(entry.expiresAt) < now) throw new ConsoleError('That code has expired. Send a new one.', 400);
    if (entry.attempts >= MAX_ATTEMPTS) throw new ConsoleError('Too many tries. Send a new code.', 429);
    if (sha(`${phone}:${String(code ?? '').trim()}`) !== entry.hash) {
      entry.attempts += 1;
      this.repo.save();
      throw new ConsoleError('That code does not match. Check the text and try again.', 400);
    }
    let member = this.repo.data.members.find((m) => m.phone === phone);
    let isNew = false;
    if (!member) {
      const firstName = String(signup?.firstName ?? '').trim();
      if (!firstName) return { needsSignup: true };
      const email = cleanEmail(signup?.email);
      const live = this.repo.data.stores.find((s) => s.id === signup?.homeStoreId) ?? this.repo.data.stores.find((s) => s.id === this.repo.data.pilot.storeId);
      member = this.repo.createMember(
        { name: firstName.slice(0, 40), phone, homeStoreId: live?.id, smsOptIn: Boolean(signup?.smsOptIn) },
        { role: 'jobber-admin', userId: 'app' },
      );
      if (email) {
        member.email = email;
        member.emailOptIn = Boolean(signup?.emailOptIn);
        if (member.emailOptIn) member.emailOptInAt = this.clock().toISOString();
      }
      if (member.smsOptIn) member.smsOptInAt = this.clock().toISOString();
      isNew = true;
    }
    delete this.auth.codes[phone];
    const token = randomBytes(32).toString('base64url');
    this.auth.sessions[sha(token)] = { memberId: member.id, expiresAt: new Date(now + SESSION_DAYS * 86_400_000).toISOString() };
    this.repo.save();
    return { token, isNew };
  }

  memberFor(authorization: string | undefined): ConsoleMember {
    const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    const session = token ? this.auth.sessions[sha(token)] : undefined;
    if (!session || Date.parse(session.expiresAt) < this.clock().getTime()) throw new ConsoleError('Please sign in again.', 401);
    return this.repo.member(session.memberId);
  }

  signOut(authorization: string | undefined): void {
    const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    if (token) delete this.auth.sessions[sha(token)];
    this.repo.save();
  }

  // ---- what the member sees ----

  /** Rules running now at this store, ignoring time-of-day so the app can show today's offers. */
  private runningAt(store: ConsoleStore): ConsoleRule[] {
    const now = this.clock();
    const probe: Transaction = { id: 'probe', storeId: store.id, at: now.toISOString(), localHour: 12, localDayOfWeek: -1, items: [] };
    return this.repo.data.rules.filter(
      (r) =>
        r.status === 'active' &&
        inScope(r.scope, store) &&
        inSchedule({ ...r, schedule: r.schedule ? { ...r.schedule, daysOfWeek: undefined, hours: undefined } : undefined } as Rule, probe),
    );
  }

  private homeStore(m: ConsoleMember): ConsoleStore {
    const id = m.homeStoreId ?? this.repo.data.pilot.storeId;
    return this.repo.data.stores.find((s) => s.id === id) ?? this.repo.data.stores[0]!;
  }

  /** Whether the member already meets the qualifiers that don't depend on what they buy. */
  private qualifiesNow(r: ConsoleRule, m: ConsoleMember): boolean {
    const emptyTx: Transaction = { id: 'probe', storeId: '', at: this.clock().toISOString(), localHour: 12, localDayOfWeek: 0, localDate: localParts(this.clock()).ymd, items: [] };
    return r.conditions.every((c) => (c.type === 'firstVisit' || c.type === 'memberTag' || c.type === 'birthday' ? conditionPasses(c, emptyTx, m) : true));
  }

  private offerView(r: ConsoleRule, m: ConsoleMember): AppOffer {
    const { stores, groups } = this.repo.data;
    const e = r.effect;
    const kind = offerKind(r);
    const where =
      r.scope.kind === 'all' ? 'all stores' : r.scope.kind === 'stores' && r.scope.storeIds.length === 1 ? 'this store only' : targetLabel(r.scope, stores, groups);
    const label = { fuel: 'Fuel', food: 'Food and drink', brand: 'Brand offer', other: 'Offer' }[kind];
    const days = r.schedule?.daysOfWeek;
    return {
      ruleId: r.id,
      name: r.name,
      kicker: `${label} · ${days?.length ? 'this week' : where}`,
      kind,
      line: memberLine(r),
      ends: r.schedule?.endsAt ? shortDate(lastDay(r.schedule.endsAt)) : undefined,
      how: r.requiresClip ? 'clip' : e.type === 'punchCard' ? 'punch' : e.type === 'fuelDiscount' ? 'auto-pump' : 'auto-register',
      clipped: m.clippedRuleIds?.includes(r.id) ?? false,
      ...(r.artwork ? { imageUrl: mediaUrl(r.artwork.mediaId) } : {}),
      headline: promoHeadline(r),
      featured: Boolean(r.featured),
    };
  }

  /**
   * Offers at one store. Near-store promos show only when the phone's location is close to a
   * store the promo targets (or once they're on the card); `nearbyOffers` says whether sharing
   * the location could unlock any.
   */
  offers(m: ConsoleMember, storeId?: string, at?: Spot): { store: ConsoleStore; offers: AppOffer[]; nearbyOffers: boolean } {
    const store = storeId ? this.repo.store(storeId) : this.homeStore(m);
    const running = this.runningAt(store).filter((r) => r.section === 'offer' && this.qualifiesNow(r, m));
    const near = new Set(running.filter((r) => r.geofence && at && this.nearRuleStore(r, at)).map((r) => r.id));
    const offers = running
      .filter((r) => !r.geofence || near.has(r.id) || m.clippedRuleIds?.includes(r.id))
      .map((r) => ({ ...this.offerView(r, m), ...(r.geofence ? { nearby: true, kicker: `Near you · ${this.offerView(r, m).kicker.split(' · ')[0]}` } : {}) }))
      .sort((a, b) => Number(Boolean(b.nearby)) - Number(Boolean(a.nearby)) || Number(b.kind === 'fuel') - Number(a.kind === 'fuel'));
    const nearbyOffers = this.repo.data.rules.some((r) => r.geofence && r.status === 'active' && r.section === 'offer');
    return { store, offers, nearbyOffers };
  }

  private nearRuleStore(r: ConsoleRule, at: Spot): ConsoleStore | undefined {
    const targeted = this.repo.data.stores.filter((s) => inScope(r.scope, s));
    return nearestWithin(targeted, at, r.geofence!.radiusMiles);
  }

  redeemOptions(m: ConsoleMember, store = this.homeStore(m)): RedeemOption[] {
    return this.runningAt(store)
      .filter((r) => r.section === 'redeem')
      .flatMap((r) => {
        const e = r.effect;
        if (e.type !== 'fuelDiscount' && e.type !== 'itemDiscount') return [];
        const costPoints = e.costPoints ?? 0;
        return [
          {
            ruleId: r.id,
            kind: e.type === 'fuelDiscount' ? ('fuel' as const) : ('item' as const),
            title: e.type === 'fuelDiscount' ? `${e.centsPerGallon}¢ off per gallon` : rewardLabel(r).replace(/^\d+ points = /, '').replace(/^./, (c) => c.toUpperCase()),
            detail:
              e.type === 'fuelDiscount'
                ? `Uses ${costPoints} of your ${m.pointsBalance} points · up to ${e.maxGallons} gallons`
                : `Uses ${costPoints} of your ${m.pointsBalance} points`,
            costPoints,
            affordable: costPoints <= m.pointsBalance,
            ...(r.artwork ? { imageUrl: mediaUrl(r.artwork.mediaId) } : {}),
            headline: promoHeadline(r),
            selected: m.nextVisitRedeem?.includes(r.id) ?? false,
          },
        ];
      })
      .sort((a, b) => a.costPoints - b.costPoints);
  }

  home(m: ConsoleMember) {
    const store = this.homeStore(m);
    const running = this.runningAt(store);
    const earn = running.filter((r) => r.section === 'earn' && r.conditions.length === 0 && !r.schedule?.daysOfWeek);
    const earnSummary = earn
      .map((r) => r.effect)
      .map((e) =>
        e.type === 'pointsPerDollar'
          ? `${e.points} ${e.points === 1 ? 'point' : 'points'} per $1 inside`
          : e.type === 'pointsPerGallon'
            ? `${e.points} ${e.points === 1 ? 'point' : 'points'} per gallon`
            : '',
      )
      .filter(Boolean)
      .join(' · ');

    const redeem = this.redeemOptions(m, store);
    const nextFuel = redeem.filter((o) => o.kind === 'fuel').find((o) => o.costPoints > m.pointsBalance) ?? redeem.find((o) => o.costPoints > m.pointsBalance);
    const freeFuel = running
      .filter((r) => r.section === 'offer' && r.effect.type === 'fuelDiscount' && !r.effect.costPoints && !r.requiresClip && this.qualifiesNow(r, m))
      .filter((r) => r.conditions.some((c) => c.type === 'firstVisit' || c.type === 'memberTag'))
      .map((r) => {
        const e = r.effect as Extract<Rule['effect'], { type: 'fuelDiscount' }>;
        return { ruleId: r.id, title: `${e.centsPerGallon}¢ off per gallon`, detail: `${r.welcome ? 'Welcome reward' : r.name} · up to ${e.maxGallons} gallons`, centsPerGallon: e.centsPerGallon };
      })
      .sort((a, b) => b.centsPerGallon - a.centsPerGallon);

    const punchCards = running
      .filter((r) => r.effect.type === 'punchCard')
      .map((r) => {
        const e = r.effect as Extract<Rule['effect'], { type: 'punchCard' }>;
        return { ruleId: r.id, name: r.name, count: m.punches[e.cardId] ?? 0, every: e.every };
      });

    const allOffers = this.offers(m).offers;
    // Birthday rewards: ready now, coming up, or waiting for the member to add a birthday.
    const bdayRule = running.find((r) => r.section === 'offer' && r.conditions.some((c) => c.type === 'birthday'));
    const bdayWindow = bdayRule?.conditions.find((c) => c.type === 'birthday') as { window: 'day' | 'week' | 'month' } | undefined;
    const birthday = !bdayRule
      ? null
      : !m.birthday
        ? { state: 'add-birthday' as const, name: bdayRule.name }
        : this.qualifiesNow(bdayRule, m)
          ? { state: 'ready' as const, name: bdayRule.name, offer: this.offerView(bdayRule, m) }
          : { state: 'coming' as const, name: bdayRule.name, on: birthdayLabel(m.birthday, bdayWindow!.window) };
    const marked = allOffers.filter((o) => o.featured);
    const featured = (marked.length ? marked : allOffers.filter((o) => o.imageUrl)).slice(0, 6);

    const hour = localParts(this.clock()).hour;
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    return {
      member: {
        firstName: m.name.split(' ')[0] ?? '',
        phone: m.phone,
        points: m.pointsBalance,
        smsOptIn: m.smsOptIn ?? false,
        email: m.email ?? '',
        emailOptIn: m.emailOptIn ?? false,
        birthday: m.birthday ?? '',
        zip: m.zip ?? '',
        visitCount: m.visitCount,
        homeStore: { id: store.id, name: store.name, city: store.city, state: store.state, loyaltyLive: store.loyaltyLive },
      },
      greeting,
      earnSummary,
      nextReward: nextFuel ? { title: nextFuel.title, costPoints: nextFuel.costPoints, pointsNeeded: nextFuel.costPoints - m.pointsBalance } : null,
      freeFuel,
      redeem,
      punchCards,
      // The welcome reward and punch cards have their own cards above.
      offers: allOffers.filter((o) => o.how !== 'punch' && !freeFuel.some((f) => f.ruleId === o.ruleId)).slice(0, 6),
      // The slider at the top of home: offers marked "feature", else the ones with artwork.
      featured,
      birthday,
    };
  }

  // ---- member actions ----

  setClip(m: ConsoleMember, ruleId: string, on: boolean, at?: Spot): string[] {
    const rule = this.repo.rule(ruleId);
    if (!rule.requiresClip || rule.status !== 'active') throw new ConsoleError('This offer cannot be added to your card.', 400);
    if (on && rule.geofence && !(at && this.nearRuleStore(rule, at)))
      throw new ConsoleError('This deal is for members near the store. Add it when you are there, with location turned on.', 400);
    const set = new Set(m.clippedRuleIds ?? []);
    if (on) set.add(ruleId);
    else set.delete(ruleId);
    m.clippedRuleIds = [...set];
    this.repo.save();
    return m.clippedRuleIds;
  }

  setRedeem(m: ConsoleMember, ruleIds: unknown): RedeemOption[] {
    if (!Array.isArray(ruleIds) || !ruleIds.every((x) => typeof x === 'string')) throw new ConsoleError('Pick rewards from the list.');
    const options = this.redeemOptions(m);
    const chosen = options.filter((o) => ruleIds.includes(o.ruleId));
    if (chosen.length !== ruleIds.length) throw new ConsoleError('That reward is not available at your store right now.');
    if (chosen.filter((o) => o.kind === 'fuel').length > 1) throw new ConsoleError('Pick one fuel reward per fill-up.');
    const total = chosen.reduce((s, o) => s + o.costPoints, 0);
    if (total > m.pointsBalance) throw new ConsoleError(`That needs ${total} points and you have ${m.pointsBalance}.`);
    m.nextVisitRedeem = chosen.map((o) => o.ruleId);
    this.repo.save();
    return this.redeemOptions(m);
  }

  updateAccount(
    m: ConsoleMember,
    patch: { firstName?: unknown; smsOptIn?: unknown; homeStoreId?: unknown; email?: unknown; emailOptIn?: unknown; birthday?: unknown; zip?: unknown },
  ): void {
    const now = this.clock().toISOString();
    if (patch.birthday !== undefined) {
      const b = String(patch.birthday ?? '').trim();
      const md = /^(\d{1,2})[-/](\d{1,2})$/.exec(b);
      if (!b) delete m.birthday;
      else if (!md || +md[1]! < 1 || +md[1]! > 12 || +md[2]! < 1 || +md[2]! > new Date(2024, +md[1]!, 0).getDate())
        throw new ConsoleError('Pick the month and day of your birthday.');
      else m.birthday = `${md[1]!.padStart(2, '0')}-${md[2]!.padStart(2, '0')}`;
    }
    if (patch.zip !== undefined) {
      const z = String(patch.zip ?? '').trim();
      if (!z) delete m.zip;
      else if (!/^\d{5}$/.test(z)) throw new ConsoleError('Enter a 5-digit ZIP code.');
      else m.zip = z;
    }
    if (patch.smsOptIn !== undefined && Boolean(patch.smsOptIn) && !m.smsOptIn) m.smsOptInAt = now;
    if (patch.email !== undefined) {
      const email = cleanEmail(patch.email);
      if (email) m.email = email;
      else delete m.email;
    }
    if (patch.emailOptIn !== undefined) {
      const on = Boolean(patch.emailOptIn) && Boolean(m.email);
      if (on && !m.emailOptIn) m.emailOptInAt = now;
      m.emailOptIn = on;
    }
    if (patch.firstName !== undefined) {
      const name = String(patch.firstName).trim();
      if (!name) throw new ConsoleError('Enter your first name.');
      m.name = name.slice(0, 40);
    }
    if (patch.smsOptIn !== undefined) m.smsOptIn = Boolean(patch.smsOptIn);
    if (patch.homeStoreId !== undefined) m.homeStoreId = this.repo.store(String(patch.homeStoreId)).id;
    this.repo.note(this.actor(m), 'Member updated their account in the app');
    this.repo.save();
  }

  visits(m: ConsoleMember) {
    const name = (id: string) => this.repo.data.rules.find((r) => r.id === id)?.name ?? 'Reward';
    return this.repo.data.ledger
      .filter((e) => e.memberId === m.id)
      .slice(-30)
      .reverse()
      .map((e) => ({
        at: e.tx.at,
        store: this.repo.data.stores.find((s) => s.id === e.tx.storeId)?.name ?? e.tx.storeId,
        gallons: e.tx.fuel?.gallons ?? null,
        pointsEarned: e.pointsEarned,
        pointsSpent: e.pointsSpent,
        savedCents: e.discounts.reduce((s, d) => s + d.centsOff, 0),
        rewards: e.discounts.filter((d) => d.centsOff > 0).map((d) => name(d.ruleId)),
      }));
  }

  /** Public data the sign-up screen shows before anyone signs in. */
  config() {
    const d = this.repo.data;
    const welcome = d.rules.find((r) => r.welcome && r.status === 'active');
    const e = welcome?.effect;
    const headline =
      e?.type === 'fuelDiscount'
        ? `${e.centsPerGallon}¢ off every gallon of your next fill-up`
        : e?.type === 'pointsFlat'
          ? `${e.points} bonus points when you join`
          : welcome
            ? welcome.name.replace(/^Welcome:\s*/i, '')
            : 'Save on fuel every time you fill up';
    return {
      branding: d.branding,
      welcome: welcome
        ? {
            headline,
            cta: e?.type === 'fuelDiscount' ? `Join and get ${e.centsPerGallon}¢ off` : 'Join free',
            fine: e?.type === 'fuelDiscount' ? `Up to ${e.maxGallons} gallons.` : '',
            ...(welcome.artwork ? { imageUrl: mediaUrl(welcome.artwork.mediaId) } : {}),
          }
        : { headline, cta: 'Join free', fine: '' },
      stores: d.stores.map((s) => ({ id: s.id, name: s.name, city: s.city, state: s.state, loyaltyLive: s.loyaltyLive })),
      defaultStoreId: d.pilot.storeId,
    };
  }
}
