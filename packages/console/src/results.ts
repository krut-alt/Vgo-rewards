// Pilot KPIs for the Results screen, computed from the transaction ledger.
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
  offers: { ruleId: string; name: string; target: string; redemptions: number; costCents: number; gallons: number | null }[];
  rollout: { live: number; total: number };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const inside = (e: LedgerEntry) =>
  e.tx.items.filter((i) => !NO_EARN_CATEGORIES.includes(i.category)).reduce((s, i) => s + i.qty * i.unitCents, 0);

function visitsPerMember(entries: LedgerEntry[]): number {
  const members = new Set(entries.map((e) => e.memberId).filter(Boolean));
  return members.size ? entries.filter((e) => e.memberId).length / members.size : 0;
}

export function computeResults(data: ConsoleData, view: 'pilot' | 'all', now = new Date()): Results {
  const storeIds = new Set(
    view === 'pilot' ? data.stores.filter((s) => s.groupIds.includes('pilot')).map((s) => s.id) : data.stores.map((s) => s.id),
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
  const usedCents = data.ledger
    .filter((e) => e.ymd.startsWith(month))
    .reduce((s, e) => s + e.discounts.reduce((t, d) => t + d.centsOff, 0), 0);

  const offers = data.rules
    .filter((r) => r.section !== 'earn' && r.status !== 'draft')
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
    membersEnrolled: data.members.filter((m) => view === 'all' || (m.homeStoreId !== undefined && storeIds.has(m.homeStoreId))).length,
    memberTxShare: { current: share(last30), previous: prev30.length ? share(prev30) : null },
    gallonsPerVisit: gallons,
    insidePerVisitCents: {
      member: avg(ledger.filter((e) => e.memberId).map(inside)),
      nonMember: avg(ledger.filter((e) => !e.memberId).map(inside)),
    },
    visitsPerMemberPerMonth: { current: visitsPerMember(last30), previous: prev30.length ? visitsPerMember(prev30) : null },
    rewardCostPerIncrementalGallonCents: incremental > 0 ? discountCost / incremental : null,
    budget: { monthlyCents: data.settings.monthlyBudgetCents, usedCents },
    offers,
    rollout: { live: data.stores.filter((s) => s.loyaltyLive).length, total: data.stores.length },
  };
}
