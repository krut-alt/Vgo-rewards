// What the customer app needs: phone sign-in, the member's home screen, offers, add-to-card and
// picking a points reward for the next visit. Members only ever see their own data.
import { stockArtFor, stockArtUrl } from './stock-art.js';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ageOn, conditionPasses, inSchedule, inScope, type Actor, type Rule, type Transaction } from '../../engine/src/index.js';
import { localParts } from './dates.js';
import { fuelPricesForApp } from './fuel-prices.js';
import { everyItem } from './items.js';
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
/** Members must be at least this old to join. */
export const MIN_JOIN_AGE = 18;
/** Bump when the wording of the terms or privacy pages changes. */
export const PROGRAM_TERMS_UPDATED = '2026-10-06';
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
  /** Built-in picture shown on the banner when there is no uploaded artwork. */
  stockArtUrl?: string;
  headline: string;
  featured: boolean;
  /** A brand promotion that came in through Skupos; the app tags it. */
  skupos?: boolean;
}

export interface RedeemOption {
  ruleId: string;
  kind: 'fuel' | 'item';
  title: string;
  detail: string;
  costPoints: number;
  affordable: boolean;
  imageUrl?: string;
  /** Built-in picture shown on the banner when there is no uploaded artwork. */
  stockArtUrl?: string;
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
/**
 * A date of birth as YYYY-MM-DD, from the app's date picker (YYYY-MM-DD) or typed as M/D/YYYY.
 * Throws when it isn't a real past date.
 */
export function parseBirthDate(raw: unknown, todayYmd: string): string {
  const s = String(raw ?? '').trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const [y, mo, d] = iso ? [+iso[1]!, +iso[2]!, +iso[3]!] : us ? [+us[3]!, +us[1]!, +us[2]!] : [0, 0, 0];
  const ymd = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const real = y >= 1900 && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (!real || ymd > todayYmd) throw new ConsoleError('Enter your date of birth, like 04/15/1990.');
  return ymd;
}

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
    signup?: { firstName?: string; smsOptIn?: boolean; homeStoreId?: string; email?: string; emailOptIn?: boolean; birthDate?: string },
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
      const birthDate = this.adultBirthDate(signup?.birthDate);
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
      member.birthDate = birthDate;
      member.birthday = birthDate.slice(5);
      isNew = true;
    }
    delete this.auth.codes[phone];
    const token = randomBytes(32).toString('base64url');
    this.auth.sessions[sha(token)] = { memberId: member.id, expiresAt: new Date(now + SESSION_DAYS * 86_400_000).toISOString() };
    this.repo.save();
    return { token, isNew };
  }

  /** A date of birth for someone old enough to join, or an error saying why not. */
  private adultBirthDate(raw: unknown): string {
    const today = localParts(this.clock()).ymd;
    if (raw === undefined || raw === null || String(raw).trim() === '') throw new ConsoleError('Enter your date of birth. VGO Rewards is for ages 18 and up.');
    const birthDate = parseBirthDate(raw, today);
    if (ageOn(birthDate, today) < MIN_JOIN_AGE) throw new ConsoleError(`Sorry, you must be ${MIN_JOIN_AGE} or older to join VGO Rewards.`);
    return birthDate;
  }

  /** Back office: fix a member's date of birth (members can't change it once set). */
  setBirthDate(m: ConsoleMember, raw: unknown): void {
    const birthDate = this.adultBirthDate(raw);
    m.birthDate = birthDate;
    m.birthday = birthDate.slice(5);
    this.repo.save();
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
    return r.conditions.every((c) => (c.type === 'firstVisit' || c.type === 'memberTag' || c.type === 'birthday' || c.type === 'minAge' ? conditionPasses(c, emptyTx, m) : true));
  }

  private artFields(r: ConsoleRule): { imageUrl?: string; stockArtUrl?: string } {
    if (r.artwork) return { imageUrl: mediaUrl(r.artwork.mediaId) };
    const stock = stockArtFor(r, everyItem(this.repo.data));
    return stock ? { stockArtUrl: stockArtUrl(stock.id) } : {};
  }

  private offerView(r: ConsoleRule, m: ConsoleMember): AppOffer {
    const { stores, groups } = this.repo.data;
    const e = r.effect;
    const kind = offerKind(r);
    const where =
      r.scope.kind === 'all' ? 'all stores' : r.scope.kind === 'stores' && r.scope.storeIds.length === 1 ? 'this store only' : targetLabel(r.scope, stores, groups);
    const label = r.skupos ? 'Skupos brand offer' : { fuel: 'Fuel', food: 'Food and drink', brand: 'Brand offer', other: 'Offer' }[kind];
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
      ...this.artFields(r),
      headline: promoHeadline(r),
      featured: Boolean(r.featured),
      ...(r.skupos ? { skupos: true } : {}),
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

  /** Every location for the app's store locator, with how many offers the member can use there. */
  storeLocator(m: ConsoleMember) {
    const home = this.homeStore(m);
    return {
      homeStoreId: home.id,
      stores: this.repo.data.stores.map((s) => ({
        id: s.id,
        name: s.name,
        address: s.address ?? '',
        city: s.city,
        state: s.state,
        zip: s.zip ?? '',
        phone: s.phone ?? '',
        lat: s.lat ?? null,
        lng: s.lng ?? null,
        tagline: s.tagline ?? '',
        hours: s.hours ?? '',
        photoUrl: s.photoMediaId ? mediaUrl(s.photoMediaId) : null,
        loyaltyLive: s.loyaltyLive,
        fuelPrices: fuelPricesForApp(s, this.clock()),
        offers: s.loyaltyLive ? this.offers(m, s.id).offers.length : 0,
      })),
    };
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
            ...this.artFields(r),
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
        birthDate: m.birthDate ?? '',
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
    patch: { firstName?: unknown; smsOptIn?: unknown; homeStoreId?: unknown; email?: unknown; emailOptIn?: unknown; birthDate?: unknown; zip?: unknown },
  ): void {
    const now = this.clock().toISOString();
    // Date of birth: added once (members from before it was asked at sign-up), then only the store can change it.
    if (patch.birthDate !== undefined && String(patch.birthDate ?? '').trim() !== (m.birthDate ?? '')) {
      if (m.birthDate) throw new ConsoleError('Your date of birth is set. Ask the store if it needs fixing.');
      const birthDate = this.adultBirthDate(patch.birthDate);
      m.birthDate = birthDate;
      m.birthday = birthDate.slice(5);
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

  /**
   * The member's full transaction history, newest first, a page at a time (`before` is the id
   * of the last entry already shown), with lifetime totals across every visit.
   */
  history(m: ConsoleMember, before?: string, limit = 25) {
    const stores = this.repo.data.stores;
    const name = (id: string) => this.repo.data.rules.find((r) => r.id === id)?.name ?? 'Reward';
    const mine = this.repo.data.ledger.filter((e) => e.memberId === m.id).reverse();
    const view = (e: (typeof mine)[number]) => {
      const insideCents = e.tx.items.reduce((s, i) => s + i.qty * i.unitCents, 0);
      const fuelCents = e.tx.fuel ? Math.round(e.tx.fuel.gallons * e.tx.fuel.pricePerGallonCents) : 0;
      const savedCents = e.discounts.reduce((s, d) => s + d.centsOff, 0);
      const store = stores.find((s) => s.id === e.tx.storeId);
      return {
        id: e.tx.id,
        at: e.tx.at,
        store: store?.name ?? e.tx.storeId,
        storePlace: store?.city ? `${store.city}, ${store.state}` : (store?.state ?? ''),
        insideCents,
        fuelCents,
        gallons: e.tx.fuel?.gallons ?? null,
        grade: e.tx.fuel?.grade ?? null,
        items: e.tx.items.reduce((s, i) => s + i.qty, 0),
        savedCents,
        paidCents: Math.max(0, insideCents + fuelCents - savedCents),
        pointsEarned: e.pointsEarned,
        pointsSpent: e.pointsSpent,
        rewards: [...new Set([...e.discounts.filter((d) => d.centsOff > 0).map((d) => name(d.ruleId)), ...(e.pointsSpent > 0 ? (e.tx.redeemRuleIds ?? []).map(name) : [])])],
      };
    };
    const all = mine.map(view);
    const start = before ? all.findIndex((v) => v.id === before) + 1 : 0;
    const page = all.slice(start, start + limit);
    const sum = (k: 'paidCents' | 'savedCents' | 'pointsEarned' | 'pointsSpent') => all.reduce((s, v) => s + v[k], 0);
    return {
      totals: { visits: all.length, paidCents: sum('paidCents'), savedCents: sum('savedCents'), pointsEarned: sum('pointsEarned'), pointsSpent: sum('pointsSpent'), pointsBalance: m.pointsBalance },
      entries: page,
      more: start + limit < all.length,
    };
  }

  /** Public data the sign-up screen shows before anyone signs in. */
  /**
   * What the program terms and privacy pages say, taken from the live program: who runs it, the
   * earn and reward rules running at every store, and how long points last.
   */
  programFacts() {
    const d = this.repo.data;
    const now = this.clock();
    const everywhere = (r: ConsoleRule) => r.status === 'active' && r.scope.kind === 'all' && !(r.schedule?.endsAt && r.schedule.endsAt <= now.toISOString());
    const label = (r: ConsoleRule) => rewardLabel(r).replace(/^./, (c) => c.toUpperCase());
    return {
      updated: PROGRAM_TERMS_UPDATED,
      programName: d.branding.programName,
      company: d.settings.legal?.companyName || 'VGO',
      email: d.settings.legal?.email ?? '',
      phone: d.settings.legal?.phone ?? '',
      address: d.settings.legal?.address ?? '',
      governingState: d.settings.legal?.governingState || 'SC',
      minAge: MIN_JOIN_AGE,
      earn: d.rules.filter((r) => r.section === 'earn' && everywhere(r) && !r.conditions.length).map(label),
      redeem: d.rules.filter((r) => r.section === 'redeem' && everywhere(r)).map(label),
      pointsExpireMonths: d.settings.pointsExpireMonths,
      oneFuelDiscount: d.settings.fuelStacking.mode === 'best',
      states: [...new Set(d.stores.map((st) => st.state))].sort(),
      liveStores: d.stores.filter((st) => st.loyaltyLive).map((st) => st.name),
    };
  }

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
      minAge: MIN_JOIN_AGE,
    };
  }
}
