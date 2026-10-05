// Pilot KPIs for the Results screen, computed from the transaction ledger.
import { inScope } from '../../engine/src/index.js';
import { NO_EARN_CATEGORIES } from './catalog.js';
import { addDays, localParts } from './dates.js';
import { targetLabel } from './labels.js';
import type { ConsoleData, LedgerEntry } from './model.js';

export interface Results {
  view: 'pilot' | 'all';
  sample: boolean;
  pilot: { storeName: string; day: number; days: number };
  membersEnrolled: number;
  memberTxShare: { current: number; previous: number | null };
  gallonsPerVisit: { member: number; nonMember: number };
  insidePerVisitCents: { member: number; nonMember: number };
  visitsPerMemberPerMonth: { current: number; previous: number | null };
  rewardCostPerIncrementalGallonCents: number | null;
  budget: { monthlyCents: number; usedCents: number };
  /** Members with a visit in the last ACTIVE_DAYS days at the stores in view. */
  activeMembers: number;
  activeDays: number;
  /** Rewards cashed out this month, by who pays for them. */
  rewardsThisMonth: Funding;
  locations: { storeId: string; name: string; loyaltyLive: boolean; activeMembers: number; newMembers30: number; visits30: number; rewards: Funding }[];
  /** Rewards each member cashed out this month, biggest first. */
  cashOuts: { memberId: string; name: string; phoneLast4: string; visits: number; rewards: Funding }[];
  offers: { ruleId: string; name: string; target: string; redemptions: number; costCents: number; gallons: number | null }[];
  rollout: { live: number; total: number };
}

export const ACTIVE_DAYS = 90;

export interface Funding {
  corporateCents: number;
  storeCents: number;
  /** Paid by a brand or manufacturer. */
  otherCents: number;
}
const noFunding = (): Funding => ({ corporateCents: 0, storeCents: 0, otherCents: 0 });
const total = (f: Funding) => f.corporateCents + f.storeCents + f.otherCents;

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const inside = (e: LedgerEntry) =>
  e.tx.items.filter((i) => !NO_EARN_CATEGORIES.includes(i.category)).reduce((s, i) => s + i.qty * i.unitCents, 0);

function visitsPerMember(entries: LedgerEntry[]): number {
  const members = new Set(entries.map((e) => e.memberId).filter(Boolean));
  return members.size ? entries.filter((e) => e.memberId).length / members.size : 0;
}

/** `only` limits everything to a store user's locations. */
export function computeResults(data: ConsoleData, view: 'pilot' | 'all', now = new Date(), only?: string[]): Results {
  const visible = only ? data.stores.filter((s) => only.includes(s.id)) : data.stores;
  const storeIds = new Set(
    view === 'pilot' && !only ? visible.filter((s) => s.groupIds.includes('pilot')).map((s) => s.id) : visible.map((s) => s.id),
  );
  const ledger = data.ledger.filter((e) => storeIds.has(e.tx.storeId));
  const today = localParts(now).ymd;
  const last30 = ledger.filter((e) => e.ymd > addDays(today, -30));
  const prev30 = ledger.filter((e) => e.ymd > addDays(today, -60) && e.ymd <= addDays(today, -30));
  const share = (es: LedgerEntry[]) => (es.length ? es.filter((e) => e.memberId).length / es.length : 0);

  const fuel = ledger.filter((e) => e.tx.fuel);
  const memberFuel = fuel.filter((e) => e.memberId);
  const gallons = {
    member: avg(memberFuel.map((e) => e.tx.fuel!.gallons)),
    nonMember: avg(fuel.filter((e) => !e.memberId).map((e) => e.tx.fuel!.gallons)),
  };
  const discountCost = ledger.reduce((s, e) => s + e.discounts.reduce((t, d) => t + d.centsOff, 0), 0);
  const incremental = (gallons.member - gallons.nonMember) * memberFuel.length;

  const month = today.slice(0, 7);
  const thisMonth = ledger.filter((e) => e.ymd.startsWith(month));
  const payer = new Map(data.rules.map((r) => [r.id, r.fundedBy]));
  const addFunding = (into: Funding, e: LedgerEntry) => {
    for (const d of e.discounts) {
      const by = payer.get(d.ruleId) ?? 'jobber';
      if (by === 'store') into.storeCents += d.centsOff;
      else if (by === 'split') {
        const half = Math.round(d.centsOff / 2);
        into.storeCents += half;
        into.corporateCents += d.centsOff - half;
      } else if (by === 'manufacturer') into.otherCents += d.centsOff;
      else into.corporateCents += d.centsOff;
    }
    return into;
  };
  const rewardsThisMonth = thisMonth.reduce(addFunding, noFunding());
  const usedCents = only
    ? total(rewardsThisMonth)
    : data.ledger.filter((e) => e.ymd.startsWith(month)).reduce((s, e) => s + e.discounts.reduce((t, d) => t + d.centsOff, 0), 0);

  const activeSince = addDays(today, -ACTIVE_DAYS);
  const recent = ledger.filter((e) => e.memberId && e.ymd > activeSince);
  const distinctMembers = (es: LedgerEntry[]) => new Set(es.map((e) => e.memberId)).size;
  const since30 = addDays(today, -30);
  const locations = data.stores
    .filter((s) => storeIds.has(s.id))
    .map((s) => ({
      storeId: s.id,
      name: s.name,
      loyaltyLive: s.loyaltyLive,
      activeMembers: distinctMembers(recent.filter((e) => e.tx.storeId === s.id)),
      newMembers30: data.members.filter((m) => m.homeStoreId === s.id && localParts(new Date(m.joinedAt)).ymd > since30).length,
      visits30: last30.filter((e) => e.tx.storeId === s.id && e.memberId).length,
      rewards: thisMonth.filter((e) => e.tx.storeId === s.id).reduce(addFunding, noFunding()),
    }));

  const byMember = new Map<string, { visits: number; rewards: Funding }>();
  for (const e of thisMonth) {
    if (!e.memberId || !e.discounts.length) continue;
    const row = byMember.get(e.memberId) ?? { visits: 0, rewards: noFunding() };
    row.visits++;
    addFunding(row.rewards, e);
    byMember.set(e.memberId, row);
  }
  const memberById = new Map(data.members.map((m) => [m.id, m]));
  const cashOuts = [...byMember]
    .map(([memberId, row]) => {
      const m = memberById.get(memberId);
      return { memberId, name: m?.name ?? 'Removed member', phoneLast4: m?.phone.slice(-4) ?? '', ...row };
    })
    .filter((c) => total(c.rewards) > 0)
    .sort((a, b) => total(b.rewards) - total(a.rewards))
    .slice(0, 100);

  const offers = data.rules
    .filter((r) => r.section !== 'earn' && r.status !== 'draft' && (!only || visible.some((st) => inScope(r.scope, st))))
    .map((r) => {
      const hits = ledger.filter((e) => e.discounts.some((d) => d.ruleId === r.id && d.centsOff > 0));
      const fuelTied = r.effect.type === 'fuelDiscount' || r.conditions.some((c) => c.type === 'minGallons');
      return {
        ruleId: r.id,
        name: r.name,
        target: targetLabel(r.scope, data.stores, data.groups),
        redemptions: hits.length,
        costCents: hits.reduce((s, e) => s + e.discounts.filter((d) => d.ruleId === r.id).reduce((t, d) => t + d.centsOff, 0), 0),
        gallons: fuelTied ? Math.round(hits.reduce((s, e) => s + (e.tx.fuel?.gallons ?? 0), 0)) : null,
      };
    })
    .sort((a, b) => b.redemptions - a.redemptions);

  const pilotStore = data.stores.find((s) => s.id === data.pilot.storeId);
  const day = Math.max(1, Math.round((Date.parse(today) - Date.parse(data.pilot.startedOn)) / 86_400_000));
  return {
    view,
    sample: ledger.some((e) => e.sample),
    pilot: { storeName: pilotStore?.name ?? data.pilot.storeId, day: Math.min(day, data.pilot.days), days: data.pilot.days },
    membersEnrolled: data.members.filter((m) => (view === 'all' && !only) || (m.homeStoreId !== undefined && storeIds.has(m.homeStoreId))).length,
    memberTxShare: { current: share(last30), previous: prev30.length ? share(prev30) : null },
    gallonsPerVisit: gallons,
    insidePerVisitCents: {
      member: avg(ledger.filter((e) => e.memberId).map(inside)),
      nonMember: avg(ledger.filter((e) => !e.memberId).map(inside)),
    },
    visitsPerMemberPerMonth: { current: visitsPerMember(last30), previous: prev30.length ? visitsPerMember(prev30) : null },
    rewardCostPerIncrementalGallonCents: incremental > 0 ? discountCost / incremental : null,
    budget: { monthlyCents: data.settings.monthlyBudgetCents, usedCents },
    activeMembers: distinctMembers(recent),
    activeDays: ACTIVE_DAYS,
    rewardsThisMonth,
    locations,
    cashOuts,
    offers,
    rollout: { live: visible.filter((s) => s.loyaltyLive).length, total: visible.length },
  };
}
