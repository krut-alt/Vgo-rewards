// Site statements: who owes whom for the rewards program, per site, for any period.
//
// The jobber runs one points pool. A site pays into it for the points it issues from store-funded earn
// rules, and is credited when a member redeems a jobber-funded reward or offer there, wherever the points
// were earned. Dealer sites also pay a monthly network fee. Each month closes on its own (the 2nd of the
// next month, a day's grace for late POS data) and its statement is frozen, so later rate changes don't
// rewrite what was billed. Corporate sites get the same lines for their P&L, but nothing is billed.
import { addDays, localParts } from './dates.js';
import type { ConsoleData, ConsoleRule, ConsoleStore, LedgerEntry, SiteType } from './model.js';
import { buildPdf, PAGE_H, PAGE_W, type PdfLine, type PdfPage, type PdfText } from './pdf.js';

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

const usd = (c: number) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One page per site: the statement a store can file or a dealer can be billed from. */
export function statementPdf(st: Statement, data: ConsoleData, now: Date): Uint8Array {
  const company = data.settings.legal?.companyName || data.branding.programName;
  const L = 56;
  const R = PAGE_W - 56;
  const pages: PdfPage[] = st.sites.map((s) => {
    const store = data.stores.find((x) => x.id === s.storeId);
    const texts: PdfText[] = [];
    const lines: PdfLine[] = [];
    let y = PAGE_H - 64;
    const put = (text: string, opts: Partial<PdfText> = {}) => texts.push({ x: L, y, text, ...opts });
    put(`${data.branding.programName} statement`, { size: 18, bold: true });
    texts.push({ x: R, y, text: st.period.label, size: 14, bold: true, align: 'right' });
    y -= 22;
    put(company, { grey: 0.35 });
    texts.push({
      x: R,
      y,
      text: st.closedAt ? `Closed ${localParts(st.closedAt).ymd}, as billed` : st.period.kind === 'month' ? 'Open month: preliminary' : 'Preliminary',
      grey: 0.35,
      align: 'right',
    });
    y -= 34;
    put(s.storeName, { size: 14, bold: true });
    y -= 16;
    const address = [store?.address, store?.city, [store?.state, store?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (address) (put(address, { grey: 0.35 }), (y -= 14));
    put(`${s.siteType === 'dealer' ? 'Dealer site' : s.siteType === 'corporate' ? 'Corporate site' : 'Site type not set (treated as corporate)'} · ${s.memberVisits.toLocaleString()} member visits · ${st.period.start} to ${st.period.end}`, { grey: 0.35 });
    y -= 30;

    const row = (label: string, amount: string, opts: { note?: string; bold?: boolean } = {}) => {
      texts.push({ x: L, y, text: label, size: 11, bold: opts.bold });
      texts.push({ x: R, y, text: amount, size: 11, bold: opts.bold, align: 'right' });
      if (opts.note) {
        y -= 13;
        texts.push({ x: L, y, text: opts.note, size: 9, grey: 0.45 });
      }
      y -= 10;
      lines.push({ x1: L, y1: y, x2: R, y2: y });
      y -= 16;
    };
    const heading = (text: string) => {
      texts.push({ x: L, y, text: text.toUpperCase(), size: 9, bold: true, grey: 0.4 });
      y -= 18;
    };
    heading(s.billed ? 'Settlement' : 'Program cost at this site (not billed)');
    if (s.billed) row('Network fee', usd(s.networkFeeCents), { note: 'One fee for each month the site sent transactions' });
    row(`Points issued inside: ${s.pointsCharged.toLocaleString()} at ${st.pointChargeCents}¢ a point`, usd(s.pointsChargeCents));
    row('Points rewards redeemed here', s.billed ? usd(-s.redemptionCreditCents) : usd(s.redemptionCreditCents), {
      note: `${s.pointsRedeemed.toLocaleString()} points, wherever they were earned`,
    });
    row('Jobber-funded offers given here', s.billed ? usd(-s.offerCreditCents) : usd(s.offerCreditCents));
    if (s.billed) row(s.netCents >= 0 ? `Amount due to ${company}` : `Credit due to ${s.storeName}`, usd(Math.abs(s.netCents)), { bold: true });
    else row('Rewards cost, from our own margin', usd(s.rewardCostCents), { bold: true });
    y -= 12;
    heading('For information, not settled');
    row('Store-funded offers', usd(s.storeFundedCents), { note: 'Given by the site at the register' });
    row('Manufacturer offers (Skupos)', usd(s.manufacturerCents), { note: 'Paid to the store by the brand' });
    row('Points on fuel and other jobber-funded points', s.pointsJobberFunded.toLocaleString());

    texts.push({ x: L, y: 56, text: `Generated ${localParts(now).ymd}${st.sample ? ' · includes sample data' : ''}`, size: 8, grey: 0.5 });
    texts.push({ x: R, y: 56, text: `${s.storeName} · ${st.period.label}`, size: 8, grey: 0.5, align: 'right' });
    return { texts, lines };
  });
  return buildPdf(pages.length ? pages : [{ texts: [{ x: L, y: PAGE_H - 64, text: 'No sites on this statement.', size: 12 }] }], `${data.branding.programName} statement, ${st.period.label}`);
}
