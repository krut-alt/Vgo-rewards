// Site statements: who owes whom for the rewards program, per site, for any period.
//
// The jobber runs one points pool. A site pays into it for the points it issues from store-funded earn
// rules, and is credited when a member redeems a jobber-funded reward or offer there, wherever the points
// were earned. Dealer sites also pay a monthly network fee. Each month closes on its own (the 2nd of the
// next month, a day's grace for late POS data) and its statement is frozen, so later rate changes don't
// rewrite what was billed. Corporate sites get the same lines for their P&L, but nothing is billed.
import { addDays, localParts } from './dates.js';
import type { ConsoleData, ConsoleRule, ConsoleStore, LedgerEntry, SiteType } from './model.js';

export type PeriodKind = 'day' | 'week' | 'month' | 'quarter' | 'year';
export const PERIOD_KINDS: PeriodKind[] = ['day', 'week', 'month', 'quarter', 'year'];

export interface Period {
  kind: PeriodKind;
  /** First and last store-local day, YYYY-MM-DD, both included. */
  start: string;
  end: string;
  label: string;
}

export interface SiteStatement {
  storeId: string;
  storeName: string;
  siteType: SiteType | 'unset';
  /** Dealers are billed and credited; corporate sites are tracked only. */
  billed: boolean;
  memberVisits: number;
  networkFeeCents: number;
  /** Points issued here from store-funded earn rules (half for split rules), and what they cost the site. */
  pointsCharged: number;
  pointsChargeCents: number;
  /** Points issued here that the jobber pays for, e.g. points on fuel. */
  pointsJobberFunded: number;
  pointsRedeemed: number;
  /** The jobber's share of points rewards redeemed here. */
  redemptionCreditCents: number;
  /** The jobber's share of other jobber-funded or split offers given here. */
  offerCreditCents: number;
  /** Paid by the site itself at the register; shown, not settled. */
  storeFundedCents: number;
  /** Paid to the site by the brand through Skupos; shown, not settled. */
  manufacturerCents: number;
  /** Fee plus points charge, less credits. Positive: the site owes the jobber. Negative: the jobber owes the site. Zero at corporate sites. */
  netCents: number;
  /** Corporate sites: everything the program gave away here, which comes out of our own margin. */
  rewardCostCents: number;
}

export interface ClosedMonth {
  /** YYYY-MM */
  month: string;
  closedAt: string;
  pointChargeCents: number;
  sample?: boolean;
  sites: SiteStatement[];
}

export interface Statement {
  period: Period;
  pointChargeCents: number;
  defaultNetworkFeeCents: number;
  sample: boolean;
  /** Set when this is a closed month: the frozen statement, as billed. */
  closedAt?: string;
  /** Closed months only: sites whose numbers changed after closing (late POS data), and by how much. */
  changedSinceClose: { storeId: string; storeName: string; netCents: number }[];
  sites: SiteStatement[];
  totals: {
    /** Dealer sites that owe the jobber, and dealer sites the jobber owes. */
    dealersOweCents: number;
    owedToDealersCents: number;
    corporateRewardCostCents: number;
  };
  /** Admins only: points members hold right now, and what they're worth. */
  liability?: { points: number; cents: number };
  /** Sites still without a site type, treated as corporate. */
  unsetSites: string[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayLabel = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]!.slice(0, 3)} ${d}, ${y}`;
};

/** The period of this kind that contains `ymd`. Weeks run Monday to Sunday. */
export function periodOf(kind: PeriodKind, ymd: string): Period {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error('Dates look like 2026-10-01.');
  const [y, m] = ymd.split('-').map(Number) as [number, number];
  switch (kind) {
    case 'day':
      return { kind, start: ymd, end: ymd, label: dayLabel(ymd) };
    case 'week': {
      const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
      const start = addDays(ymd, -((dow + 6) % 7));
      return { kind, start, end: addDays(start, 6), label: `Week of ${dayLabel(start)}` };
    }
    case 'month':
      return { kind, start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay(y, m))}`, label: `${MONTHS[m - 1]} ${y}` };
    case 'quarter': {
      const q = Math.floor((m - 1) / 3);
      return { kind, start: `${y}-${pad(q * 3 + 1)}-01`, end: `${y}-${pad(q * 3 + 3)}-${pad(lastDay(y, q * 3 + 3))}`, label: `Q${q + 1} ${y}` };
    }
    case 'year':
      return { kind, start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
  }
}

export function pointChargeCents(data: ConsoleData): number {
  return data.settings.pointChargeCents ?? 1;
}

/** The jobber's and the site's share of a cost paid by `fundedBy`. Split rounds the same way as Results. */
function shares(cents: number, fundedBy: ConsoleRule['fundedBy'] | undefined): { jobber: number; site: number; brand: number } {
  if (fundedBy === 'store') return { jobber: 0, site: cents, brand: 0 };
  if (fundedBy === 'manufacturer') return { jobber: 0, site: 0, brand: cents };
  if (fundedBy === 'split') {
    const site = Math.round(cents / 2);
    return { jobber: cents - site, site, brand: 0 };
  }
  return { jobber: cents, site: 0, brand: 0 };
}

/** Points earned on an entry, by earn rule. Entries from before rules were recorded are worked out from the rules. */
export function earnedByRule(e: LedgerEntry, rules: Map<string, ConsoleRule>): { ruleId: string; points: number }[] {
  if (e.earned) return e.earned;
  if (!e.pointsEarned) return [];
  const earnIds = e.appliedRuleIds.filter((id) => rules.get(id)?.section === 'earn');
  let left = e.pointsEarned;
  const out: { ruleId: string; points: number }[] = [];
  let perDollar: string | undefined;
  for (const id of earnIds) {
    const effect = rules.get(id)!.effect;
    if (effect.type === 'pointsPerDollar') {
      perDollar ??= id;
      continue;
    }
    const pts = effect.type === 'pointsPerGallon' ? Math.floor((e.tx.fuel?.gallons ?? 0) * effect.points) : effect.type === 'pointsFlat' ? effect.points : 0;
    const take = Math.min(left, pts);
    if (take > 0) out.push({ ruleId: id, points: take });
    left -= take;
  }
  if (left > 0) out.push({ ruleId: perDollar ?? earnIds[0] ?? '', points: left });
  return out;
}

function siteStatement(store: ConsoleStore, entries: LedgerEntry[], data: ConsoleData, rules: Map<string, ConsoleRule>, rate: number): SiteStatement {
  const siteType = store.siteType ?? 'unset';
  const billed = siteType === 'dealer';
  const s: SiteStatement = {
    storeId: store.id,
    storeName: store.name,
    siteType,
    billed,
    memberVisits: entries.filter((e) => e.memberId).length,
    networkFeeCents: 0,
    pointsCharged: 0,
    pointsChargeCents: 0,
    pointsJobberFunded: 0,
    pointsRedeemed: 0,
    redemptionCreditCents: 0,
    offerCreditCents: 0,
    storeFundedCents: 0,
    manufacturerCents: 0,
    netCents: 0,
    rewardCostCents: 0,
  };
  let sitePoints = 0;
  for (const e of entries) {
    s.pointsRedeemed += e.pointsSpent;
    for (const { ruleId, points } of earnedByRule(e, rules)) {
      const fundedBy = rules.get(ruleId)?.fundedBy;
      if (fundedBy === 'store') sitePoints += points;
      else if (fundedBy === 'split') {
        sitePoints += points / 2;
        s.pointsJobberFunded += points / 2;
      } else s.pointsJobberFunded += points;
    }
    for (const d of e.discounts) {
      const rule = rules.get(d.ruleId);
      const sh = shares(d.centsOff, rule?.fundedBy);
      if (rule?.section === 'redeem') s.redemptionCreditCents += sh.jobber;
      else s.offerCreditCents += sh.jobber;
      s.storeFundedCents += sh.site;
      s.manufacturerCents += sh.brand;
    }
  }
  s.pointsCharged = Math.round(sitePoints);
  s.pointsJobberFunded = Math.round(s.pointsJobberFunded);
  s.pointsChargeCents = Math.round(sitePoints * rate);
  if (billed) {
    // One fee for each month the site sent the network transactions.
    const months = new Set(entries.map((e) => e.ymd.slice(0, 7)));
    s.networkFeeCents = months.size * (store.networkFeeCents ?? data.settings.networkFeeCents ?? 0);
    s.netCents = s.networkFeeCents + s.pointsChargeCents - s.redemptionCreditCents - s.offerCreditCents;
  } else {
    s.rewardCostCents = s.redemptionCreditCents + s.offerCreditCents + s.storeFundedCents;
  }
  return s;
}

function liveSites(data: ConsoleData, period: Period, storeIds?: string[]): { sites: SiteStatement[]; sample: boolean } {
  const rules = new Map(data.rules.map((r) => [r.id, r]));
  const rate = pointChargeCents(data);
  const entries = data.ledger.filter((e) => e.ymd >= period.start && e.ymd <= period.end);
  const byStore = new Map<string, LedgerEntry[]>();
  for (const e of entries) byStore.set(e.tx.storeId, [...(byStore.get(e.tx.storeId) ?? []), e]);
  const stores = data.stores.filter((s) => !storeIds || storeIds.includes(s.id));
  return {
    sites: stores.map((st) => siteStatement(st, byStore.get(st.id) ?? [], data, rules, rate)),
    sample: entries.some((e) => e.sample),
  };
}

/** The statement for the period of `kind` containing `ymd`. `storeIds` limits it to a store user's sites. */
export function statementFor(data: ConsoleData, kind: PeriodKind, ymd: string, storeIds?: string[]): Statement {
  const period = periodOf(kind, ymd);
  const live = liveSites(data, period, storeIds);
  const closed = kind === 'month' ? data.closedMonths?.find((c) => c.month === period.start.slice(0, 7)) : undefined;
  let sites = live.sites;
  const changedSinceClose: Statement['changedSinceClose'] = [];
  if (closed) {
    const frozen = new Map(closed.sites.map((s) => [s.storeId, s]));
    sites = live.sites.map((s) => frozen.get(s.storeId) ?? s);
    for (const s of live.sites) {
      const f = frozen.get(s.storeId);
      const diff = s.netCents - (f?.netCents ?? 0);
      const costDiff = s.rewardCostCents - (f?.rewardCostCents ?? 0);
      if (diff || costDiff) changedSinceClose.push({ storeId: s.storeId, storeName: s.storeName, netCents: diff });
    }
  }
  const totals = { dealersOweCents: 0, owedToDealersCents: 0, corporateRewardCostCents: 0 };
  for (const s of sites) {
    if (s.netCents > 0) totals.dealersOweCents += s.netCents;
    else totals.owedToDealersCents -= s.netCents;
    totals.corporateRewardCostCents += s.rewardCostCents;
  }
  const rate = closed?.pointChargeCents ?? pointChargeCents(data);
  const points = data.members.reduce((t, m) => t + m.pointsBalance, 0);
  return {
    period,
    pointChargeCents: rate,
    defaultNetworkFeeCents: data.settings.networkFeeCents ?? 0,
    sample: closed?.sample ?? live.sample,
    ...(closed ? { closedAt: closed.closedAt } : {}),
    changedSinceClose,
    sites,
    totals,
    ...(storeIds ? {} : { liability: { points, cents: Math.round(points * pointChargeCents(data)) } }),
    unsetSites: data.stores.filter((s) => !s.siteType && (!storeIds || storeIds.includes(s.id))).map((s) => s.name),
  };
}

/**
 * Freezes the statement for every past month with activity that isn't closed yet. A month closes on the
 * 2nd of the next month. Months before statements started (`statementsSince`, set on the first run) are
 * left open, so turning statements on doesn't bill old visits. Returns the months it closed.
 */
export function closeMonths(data: ConsoleData, now: Date): string[] {
  const today = localParts(now).ymd;
  data.statementsSince ??= today.slice(0, 7);
  const closeBefore = addDays(today, -1).slice(0, 7);
  const done = new Set((data.closedMonths ?? []).map((c) => c.month));
  const months = [...new Set(data.ledger.map((e) => e.ymd.slice(0, 7)))]
    .filter((mo) => mo >= data.statementsSince! && mo < closeBefore && !done.has(mo))
    .sort();
  for (const month of months) freeze(data, month, now);
  return months;
}

/** Closes `month` again from the numbers as they stand now, e.g. after fixing a site type. Admins only. */
export function recloseMonth(data: ConsoleData, month: string, now: Date): ClosedMonth {
  const i = (data.closedMonths ?? []).findIndex((c) => c.month === month);
  if (i < 0) throw new Error(`${month} isn't closed.`);
  data.closedMonths!.splice(i, 1);
  return freeze(data, month, now);
}

function freeze(data: ConsoleData, month: string, now: Date): ClosedMonth {
  const { sites, sample } = liveSites(data, periodOf('month', `${month}-01`));
  const closed: ClosedMonth = { month, closedAt: now.toISOString(), pointChargeCents: pointChargeCents(data), ...(sample ? { sample: true } : {}), sites };
  (data.closedMonths ??= []).push(closed);
  data.closedMonths.sort((a, b) => a.month.localeCompare(b.month));
  return closed;
}

const dollars = (c: number) => (c / 100).toFixed(2);
// Text that starts like a formula is quoted so spreadsheets don't run it; amounts like -1.00 stay numbers.
const csvCell = (v: string | number) => {
  let t = String(v);
  if (/^[=+\-@]/.test(t) && Number.isNaN(Number(t))) t = `'${t}`;
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** One row per site, for accounting or the fuel invoice. */
export function statementCsv(st: Statement): string {
  const head = [
    'Period',
    'Site',
    'Site type',
    'Member visits',
    'Network fee',
    'Points charged',
    'Points charge',
    'Redemption credits',
    'Offer credits',
    'Net (site owes us if positive)',
    'Corporate reward cost',
    'Store-funded rewards',
    'Manufacturer rewards',
    'Points funded by jobber',
    'Points redeemed',
  ];
  const rows = st.sites.map((s) => [
    st.period.label,
    s.storeName,
    s.siteType === 'unset' ? 'Not set (corporate)' : s.siteType === 'dealer' ? 'Dealer' : 'Corporate',
    s.memberVisits,
    dollars(s.networkFeeCents),
    s.pointsCharged,
    dollars(s.pointsChargeCents),
    dollars(s.redemptionCreditCents),
    dollars(s.offerCreditCents),
    dollars(s.netCents),
    dollars(s.rewardCostCents),
    dollars(s.storeFundedCents),
    dollars(s.manufacturerCents),
    s.pointsJobberFunded,
    s.pointsRedeemed,
  ]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
