// The POS link: how a rented, certified loyalty connection (Conexxus loyalty host) at the store
// talks to our offer engine. The flow follows the Conexxus loyalty exchange used by Verifone
// Commander and Gilbarco Passport:
//
//   identify  the cashier scans the app barcode or the customer types their phone on the PIN pad
//   rewards   before payment (or at pump authorization): what does this member get on this basket?
//   finalize  after payment: what the POS actually gave; we earn and spend points and record the sale
//   cancel    the sale was voided before payment
//
// Each vendor names these messages and fields its own way; an adapter (adapters.ts) translates
// their wire format to the plain messages below, so the vendor can change without touching this file.
// Nothing is held between `rewards` and `finalize`: finalize carries the final basket and is
// worked out again, so a server restart between the two loses nothing.
import { CATEGORIES, FUEL_GRADES } from '../catalog.js';
import { localParts } from '../dates.js';
import { noteFuelPrice } from '../fuel-prices.js';
import { catalogFor, categoryFor } from '../items.js';
import type { ConsoleMember, ConsoleStore } from '../model.js';
import { ConsoleError, type Repo } from '../repo.js';
import { inScope, type AppliedDiscount, type LineItem, type Transaction } from '../../../engine/src/index.js';

/** One rung-up line, as the POS sends it. */
export interface LinkLine {
  /** The POS's own line number, echoed back so item discounts land on the right line. */
  lineId: string;
  /** UPC or PLU. Matched to the items catalog for the category. */
  posCode?: string;
  /** POS department number or name, used when the catalog does not know the item. */
  department?: string;
  description?: string;
  qty: number;
  unitCents: number;
}

export interface LinkFuel {
  /** Grade as the POS names it, e.g. "UNL", "Premium", "2". */
  grade: string;
  /** Unknown at pump authorization; sent once fueling is done. */
  gallons?: number;
  /** To a tenth of a cent: $3.199 is 319.9. */
  pricePerGallonCents: number;
}

export interface LinkSale {
  /** The site ID the link uses for the store (Locations > POS site ID), or our store id. */
  siteId: string;
  /** The link's transaction id. Finalizing the same one twice is answered, not recorded twice. */
  linkTxId: string;
  /** ISO time of the sale. */
  at: string;
  /** Phone number typed on the PIN pad or the scanned app barcode. Empty for non-members. */
  loyaltyId?: string;
  lines: LinkLine[];
  fuel?: LinkFuel;
  /** Points rewards the member picked at the register, on top of any picked in the app. */
  redeem?: string[];
}

export interface LinkFinalize extends LinkSale {
  /** Rewards the POS applied, with the cents it actually took off. Ones it skipped are left out. */
  applied: { rewardId: string; centsOff?: number }[];
}

export type LinkRequest =
  | { op: 'identify'; siteId: string; loyaltyId: string }
  | { op: 'rewards'; sale: LinkSale }
  | { op: 'finalize'; sale: LinkFinalize }
  | { op: 'cancel'; siteId: string; linkTxId: string }
  /** Current pump prices, if the vendor or back office can push them. Sales report prices too. */
  | { op: 'prices'; siteId: string; prices: { grade: string; pricePerGallonCents: number; at?: string }[] };

export type LinkOp = LinkRequest['op'];

export interface LinkMember {
  firstName: string;
  pointsBalance: number;
}

/** A discount for the POS to apply. `rewardId` is our rule id; send it back in `applied`. */
export interface LinkReward {
  rewardId: string;
  kind: AppliedDiscount['kind'];
  /** Short text for the receipt and the cashier screen. */
  label: string;
  centsOff: number;
  /** Fuel: cents off each gallon, up to `maxGallons`, set at the pump before fueling. */
  centsPerGallon?: number;
  maxGallons?: number;
  /** Item discounts: the lines it applies to. */
  lineIds?: string[];
  pointsCost?: number;
  fundedBy: AppliedDiscount['fundedBy'];
}

export type LinkAnswer =
  | { op: 'identify'; status: 'ok'; member: LinkMember; redemptions: { rewardId: string; label: string; pointsCost: number; affordable: boolean; selected: boolean }[] }
  | { op: 'identify'; status: 'unknown-member'; message: string }
  | {
      op: 'rewards';
      status: 'ok' | 'unknown-member' | 'non-member' | 'not-live';
      linkTxId: string;
      member?: LinkMember;
      rewards: LinkReward[];
      /** Points this basket earns as it stands. */
      pointsToEarn: number;
      receipt: string[];
    }
  | {
      op: 'finalize';
      status: 'recorded' | 'duplicate' | 'non-member' | 'not-live';
      linkTxId: string;
      pointsEarned: number;
      pointsSpent: number;
      pointsBalance?: number;
      receipt: string[];
    }
  | { op: 'cancel'; status: 'ok'; linkTxId: string }
  | { op: 'prices'; status: 'ok'; updated: number };

const GRADE_CODES: Record<string, string> = { unl: 'regular', reg: 'regular', mid: 'midgrade', plus: 'midgrade', prem: 'premium', sup: 'premium', dsl: 'diesel' };

/** Our grade id for whatever the POS calls it. Numbered grades need the store's setup; unknown ones pass through. */
export function gradeFor(raw: string): string {
  const g = raw.trim().toLowerCase();
  return (
    FUEL_GRADES.find((x) => x.id === g || (x.words as readonly string[]).includes(g))?.id ??
    Object.entries(GRADE_CODES).find(([code]) => g.startsWith(code))?.[1] ??
    g
  );
}

const firstName = (m: ConsoleMember) => m.name.trim().split(/\s+/)[0] || 'Member';

export class PosLink {
  constructor(
    private repo: Repo,
    private clock: () => Date = () => new Date(),
  ) {}

  handle(req: LinkRequest): LinkAnswer {
    switch (req.op) {
      case 'identify':
        return this.identify(req.siteId, req.loyaltyId);
      case 'rewards':
        return this.rewards(req.sale);
      case 'finalize':
        return this.finalize(req.sale);
      case 'cancel':
        // Nothing is reserved between rewards and finalize, so a void needs no undo.
        this.storeFor(req.siteId);
        return { op: 'cancel', status: 'ok', linkTxId: req.linkTxId };
      case 'prices': {
        const store = this.storeFor(req.siteId);
        const at = this.clock().toISOString();
        const updated = req.prices.filter((p) => noteFuelPrice(store, gradeFor(p.grade), p.pricePerGallonCents, p.at ?? at, 'pos')).length;
        if (updated) this.repo.save();
        return { op: 'prices', status: 'ok', updated };
      }
    }
  }

  /** The store a link site ID points at: its POS site ID from Locations, or our own store id. */
  storeFor(siteId: string): ConsoleStore {
    const s = this.repo.data.stores.find((x) => x.posSiteId === siteId) ?? this.repo.data.stores.find((x) => x.id === siteId);
    if (!s) throw new ConsoleError(`No store has POS site ID ${siteId}. Add it on the Locations page.`, 404);
    return s;
  }

  private findMember(loyaltyId: string | undefined): ConsoleMember | undefined {
    if (!loyaltyId) return undefined;
    try {
      return this.repo.memberByLoyaltyId(loyaltyId);
    } catch (err) {
      if (err instanceof ConsoleError && err.status === 404) return undefined;
      throw err;
    }
  }

  identify(siteId: string, loyaltyId: string): LinkAnswer {
    const store = this.storeFor(siteId);
    const m = this.findMember(loyaltyId);
    if (!m) return { op: 'identify', status: 'unknown-member', message: 'No VGO Rewards member with that phone number.' };
    const ymd = localParts(this.clock()).ymd;
    const redemptions = this.repo.data.rules
      .filter((r) => r.section === 'redeem' && r.status === 'active' && inScope(r.scope, store) && (!r.schedule?.endsAt || r.schedule.endsAt.slice(0, 10) >= ymd))
      .flatMap((r) => {
        const e = r.effect;
        if ((e.type !== 'fuelDiscount' && e.type !== 'itemDiscount') || !e.costPoints) return [];
        return [{ rewardId: r.id, label: r.memberText || r.name, pointsCost: e.costPoints, affordable: e.costPoints <= m.pointsBalance, selected: m.nextVisitRedeem?.includes(r.id) ?? false }];
      })
      .sort((a, b) => a.pointsCost - b.pointsCost);
    return { op: 'identify', status: 'ok', member: { firstName: firstName(m), pointsBalance: m.pointsBalance }, redemptions };
  }

  /** Our category for a POS line: the items catalog first, then the department map, then the department name. */
  categoryOf(line: LinkLine, storeId?: string): string {
    const code = line.posCode?.replace(/\s/g, '');
    if (code) {
      const digits = code.replace(/\D/g, '');
      const item = catalogFor(this.repo.data, storeId)?.items.find((i) => i.sku === code || (digits && i.upc === digits));
      if (item?.category) return item.category;
    }
    const dept = line.department?.trim() ?? '';
    const mapped = this.repo.data.settings.posDepartments?.[dept];
    if (mapped) return mapped;
    return categoryFor(dept) ?? (CATEGORIES.some((c) => c.id === dept) ? dept : 'other');
  }

  /** The engine's view of the sale. */
  transaction(sale: LinkSale, store: ConsoleStore): Transaction {
    if (!sale.linkTxId || Number.isNaN(Date.parse(sale.at))) throw new ConsoleError('The sale needs a linkTxId and a valid "at" time.');
    const p = localParts(sale.at);
    const items: LineItem[] = sale.lines.map((l) => ({ sku: l.posCode || `line-${l.lineId}`, category: this.categoryOf(l, store.id), qty: l.qty, unitCents: l.unitCents }));
    const fuel = sale.fuel && sale.fuel.gallons !== undefined && sale.fuel.gallons > 0
      ? { grade: gradeFor(sale.fuel.grade), gallons: sale.fuel.gallons, pricePerGallonCents: sale.fuel.pricePerGallonCents }
      : undefined;
    return {
      id: `${store.id}:${sale.linkTxId}`,
      storeId: store.id,
      at: sale.at,
      localHour: p.hour,
      localDayOfWeek: p.dayOfWeek,
      localDate: p.ymd,
      items,
      ...(fuel ? { fuel } : {}),
      ...(sale.redeem?.length ? { redeemRuleIds: sale.redeem } : {}),
    };
  }

  private linesFor(ruleId: string, sale: LinkSale): string[] | undefined {
    const e = this.repo.data.rules.find((r) => r.id === ruleId)?.effect;
    if (!e || (e.type !== 'itemDiscount' && e.type !== 'punchCard')) return undefined;
    if (!e.skus && !e.categories) return sale.lines.map((l) => l.lineId);
    return sale.lines.filter((l) => (e.skus?.includes(l.posCode ?? '') ?? false) || (e.categories?.includes(this.categoryOf(l, this.storeFor(sale.siteId).id)) ?? false)).map((l) => l.lineId);
  }

  private label(ruleId: string, d: AppliedDiscount): string {
    const r = this.repo.data.rules.find((x) => x.id === ruleId);
    if (d.kind === 'fuel') return `VGO Rewards ${d.centsPerGallon}¢/gal off`;
    return `VGO Rewards: ${(r?.headline || r?.name || 'reward').slice(0, 30)}`;
  }

  /** Every fuel sale carries the pump price, which keeps the app's gas prices current. */
  private notePrice(sale: LinkSale, store: ConsoleStore): boolean {
    return !!sale.fuel && noteFuelPrice(store, gradeFor(sale.fuel.grade), sale.fuel.pricePerGallonCents, sale.at, 'pos');
  }

  rewards(sale: LinkSale): LinkAnswer {
    const store = this.storeFor(sale.siteId);
    const tx = this.transaction(sale, store);
    if (this.notePrice(sale, store)) this.repo.save();
    const none = { op: 'rewards' as const, linkTxId: sale.linkTxId, rewards: [], pointsToEarn: 0, receipt: [] };
    if (!sale.loyaltyId) return { ...none, status: 'non-member' };
    if (!store.loyaltyLive) return { ...none, status: 'not-live' };
    const m = this.findMember(sale.loyaltyId);
    if (!m) return { ...none, status: 'unknown-member', receipt: ['Join VGO Rewards in the VGO app'] };
    const result = this.repo.preview(tx, m.id);
    const rewards: LinkReward[] = result.discounts.map((d) => ({
      rewardId: d.ruleId,
      kind: d.kind,
      label: this.label(d.ruleId, d),
      centsOff: d.centsOff,
      ...(d.centsPerGallon !== undefined ? { centsPerGallon: d.centsPerGallon, maxGallons: d.maxGallons } : {}),
      ...(this.linesFor(d.ruleId, sale) ? { lineIds: this.linesFor(d.ruleId, sale) } : {}),
      ...(d.pointsSpent ? { pointsCost: d.pointsSpent } : {}),
      fundedBy: d.fundedBy,
    }));
    return {
      ...none,
      status: 'ok',
      member: { firstName: firstName(m), pointsBalance: m.pointsBalance },
      rewards,
      pointsToEarn: result.pointsEarned,
      receipt: [`VGO Rewards: ${firstName(m)}`, `Points before this visit: ${m.pointsBalance.toLocaleString('en-US')}`],
    };
  }

  finalize(sale: LinkFinalize): LinkAnswer {
    const store = this.storeFor(sale.siteId);
    const tx = this.transaction(sale, store);
    if (this.notePrice(sale, store)) this.repo.save();
    const base = { op: 'finalize' as const, linkTxId: sale.linkTxId };
    const done = this.repo.data.ledger.find((e) => e.tx.id === tx.id);
    if (done) {
      const m = done.memberId ? this.repo.data.members.find((x) => x.id === done.memberId) : undefined;
      return { ...base, status: 'duplicate', pointsEarned: done.pointsEarned, pointsSpent: done.pointsSpent, pointsBalance: m?.pointsBalance, receipt: [] };
    }
    const m = this.findMember(sale.loyaltyId);
    // Sales from non-members, and from stores not live yet, are still recorded for Results.
    if (!m || !store.loyaltyLive) {
      this.repo.recordTransaction(tx, undefined);
      return { ...base, status: m ? 'not-live' : 'non-member', pointsEarned: 0, pointsSpent: 0, receipt: [] };
    }
    const applied = (sale.applied ?? []).map((a) => ({ ruleId: a.rewardId, centsOff: a.centsOff }));
    const result = this.repo.recordTransaction(tx, m.id, { applied });
    const saved = result.discounts.reduce((s, d) => s + d.centsOff, 0);
    return {
      ...base,
      status: 'recorded',
      pointsEarned: result.pointsEarned,
      pointsSpent: result.pointsSpent,
      pointsBalance: m.pointsBalance,
      receipt: [
        `VGO Rewards: ${firstName(m)}`,
        ...(saved ? [`You saved $${(saved / 100).toFixed(2)}`] : []),
        `Points earned: ${result.pointsEarned.toLocaleString('en-US')}`,
        ...(result.pointsSpent ? [`Points used: ${result.pointsSpent.toLocaleString('en-US')}`] : []),
        `Balance: ${m.pointsBalance.toLocaleString('en-US')} points`,
      ],
    };
  }

  /**
   * The transaction feed: recorded sales after a cursor, oldest first, for the link vendor's
   * reconciliation and back-office exports. Sample visits are left out.
   */
  feed(opts: { after?: string; siteId?: string; limit?: number } = {}) {
    const storeId = opts.siteId ? this.storeFor(opts.siteId).id : undefined;
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    const key = (at: string, id: string) => `${at}|${id}`;
    const rows = this.repo.data.ledger
      .filter((e) => !e.sample && (!storeId || e.tx.storeId === storeId))
      .filter((e) => !opts.after || key(e.tx.at, e.tx.id) > opts.after)
      .sort((a, b) => (key(a.tx.at, a.tx.id) < key(b.tx.at, b.tx.id) ? -1 : 1))
      .slice(0, limit);
    const transactions = rows.map((e) => {
      const store = this.repo.data.stores.find((s) => s.id === e.tx.storeId);
      return {
        linkTxId: e.tx.id.slice(e.tx.storeId.length + 1) || e.tx.id,
        storeId: e.tx.storeId,
        siteId: store?.posSiteId ?? e.tx.storeId,
        at: e.tx.at,
        memberId: e.memberId ?? null,
        insideCents: e.tx.items.reduce((s, i) => s + i.qty * i.unitCents, 0),
        gallons: e.tx.fuel?.gallons ?? 0,
        pointsEarned: e.pointsEarned,
        pointsSpent: e.pointsSpent,
        discounts: e.discounts.map((d) => ({ rewardId: d.ruleId, centsOff: d.centsOff })),
      };
    });
    const last = rows[rows.length - 1];
    return { transactions, next: last ? key(last.tx.at, last.tx.id) : opts.after ?? null };
  }
}
