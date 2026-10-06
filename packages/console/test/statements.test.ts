import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';
import { closeMonths, earnedByRule, periodOf, recloseMonth, statementCsv, statementFor } from '../src/statements.js';
import type { Transaction } from '../../engine/src/index.js';

const now = new Date('2026-10-20T16:00:00Z');
let seq = 0;

function tx(storeId: string, at: string, extra: Partial<Transaction> = {}): Transaction {
  return { id: `t-${++seq}`, storeId, at, localHour: 12, localDayOfWeek: 2, items: [], ...extra };
}
const inside = (cents: number) => [{ sku: 'snack', category: 'snacks', qty: 1, unitCents: cents }];
const fuel = (gallons: number) => ({ grade: 'regular', gallons, pricePerGallonCents: 300 });

/** No sample visits; VGO 01 corporate, VGO 02 a live dealer with a $150 fee; one member with 500 points. */
function setup() {
  const repo = new Repo(seedData(now), () => {}, () => now);
  repo.clearSampleData(ADMIN);
  const d = repo.data;
  d.rules = d.rules.filter((r) => r.id !== 'welcome'); // keep the numbers simple
  d.stores.find((s) => s.id === 'vgo-01')!.siteType = 'corporate';
  const dealer = d.stores.find((s) => s.id === 'vgo-02')!;
  dealer.siteType = 'dealer';
  dealer.loyaltyLive = true;
  d.settings.networkFeeCents = 15_000;
  const member = repo.createMember({ name: 'Pat', phone: '8645551234', homeStoreId: 'vgo-01' }, ADMIN);
  repo.adjustPoints(member.id, 500, 'test', ADMIN);
  return { repo, d, member };
}

describe('periods', () => {
  it('finds the day, week, month, quarter and year around a date', () => {
    expect(periodOf('day', '2026-10-06')).toMatchObject({ start: '2026-10-06', end: '2026-10-06', label: 'Oct 6, 2026' });
    expect(periodOf('week', '2026-10-08')).toMatchObject({ start: '2026-10-05', end: '2026-10-11', label: 'Week of Oct 5, 2026' });
    expect(periodOf('week', '2026-10-11')).toMatchObject({ start: '2026-10-05' });
    expect(periodOf('month', '2026-02-14')).toMatchObject({ start: '2026-02-01', end: '2026-02-28', label: 'February 2026' });
    expect(periodOf('quarter', '2026-11-30')).toMatchObject({ start: '2026-10-01', end: '2026-12-31', label: 'Q4 2026' });
    expect(periodOf('year', '2026-06-01')).toMatchObject({ start: '2026-01-01', end: '2026-12-31', label: '2026' });
  });
});

describe('site statements', () => {
  it('charges a dealer for inside points and credits it for rewards redeemed there, wherever points were earned', () => {
    const { repo, member } = setup();
    // Earned at the dealer: $20 inside (20 store-funded points) and 10 gallons (10 jobber-funded points).
    repo.recordTransaction(tx('vgo-02', '2026-10-06T15:00:00Z', { items: inside(2000), fuel: fuel(10) }), member.id);
    // Redeemed at the dealer: 100 points for 10¢/gal on 15 gallons = $1.50, which the jobber pays.
    repo.recordTransaction(tx('vgo-02', '2026-10-07T15:00:00Z', { fuel: fuel(15), redeemRuleIds: ['redeem-fuel'] }), member.id);
    // Earned at the corporate store: tracked, never billed.
    repo.recordTransaction(tx('vgo-01', '2026-10-08T15:00:00Z', { items: inside(1000) }), member.id);

    const st = statementFor(repo.data, 'month', '2026-10-15');
    const dealer = st.sites.find((s) => s.storeId === 'vgo-02')!;
    expect(dealer).toMatchObject({
      siteType: 'dealer',
      billed: true,
      memberVisits: 2,
      networkFeeCents: 15_000,
      pointsCharged: 20,
      pointsChargeCents: 20,
      redemptionCreditCents: 150,
      pointsRedeemed: 100,
    });
    expect(dealer.pointsJobberFunded).toBe(25); // 10 + 15 gallons
    expect(dealer.netCents).toBe(15_000 + 20 - 150 - dealer.offerCreditCents);
    const corp = st.sites.find((s) => s.storeId === 'vgo-01')!;
    expect(corp).toMatchObject({ billed: false, pointsCharged: 10, netCents: 0 });
    expect(st.totals.dealersOweCents).toBe(dealer.netCents);
    expect(st.liability!.points).toBe(repo.member(member.id).pointsBalance);

    // A store user sees only their site and no portfolio liability.
    const mine = statementFor(repo.data, 'month', '2026-10-15', ['vgo-02']);
    expect(mine.sites.map((s) => s.storeId)).toEqual(['vgo-02']);
    expect(mine.liability).toBeUndefined();

    const csv = statementCsv(st);
    expect(csv.split('\n')[0]).toContain('Net (site owes us if positive)');
    expect(csv).toContain(`October 2026,VGO 02,Dealer,2,150.00,20,0.20,1.50`);
  });

  it('splits the charge for split-funded earn rules and bills the fee once per active month', () => {
    const { repo, d, member } = setup();
    d.rules.find((r) => r.id === 'earn-inside')!.fundedBy = 'split';
    d.settings.pointChargeCents = 2;
    repo.recordTransaction(tx('vgo-02', '2026-07-06T15:00:00Z', { items: inside(4000) }), member.id);
    repo.recordTransaction(tx('vgo-02', '2026-09-06T15:00:00Z', { items: inside(1000) }), member.id);
    const q = statementFor(repo.data, 'quarter', '2026-08-01').sites.find((s) => s.storeId === 'vgo-02')!;
    expect(q).toMatchObject({ pointsCharged: 25, pointsChargeCents: 50, pointsJobberFunded: 25, networkFeeCents: 30_000 });
    expect(statementFor(repo.data, 'month', '2026-08-01').sites.find((s) => s.storeId === 'vgo-02')!.networkFeeCents).toBe(0);
  });

  it('closes each past month on the 2nd and keeps it as billed', () => {
    const { repo, d, member } = setup();
    repo.recordTransaction(tx('vgo-02', '2026-09-30T15:00:00Z', { items: inside(3000) }), member.id);
    d.statementsSince = '2026-09';
    expect(closeMonths(d, new Date('2026-10-01T16:00:00Z'))).toEqual([]); // a day's grace for late POS data
    expect(closeMonths(d, new Date('2026-10-02T16:00:00Z'))).toEqual(['2026-09']);
    expect(closeMonths(d, new Date('2026-10-03T16:00:00Z'))).toEqual([]);

    d.settings.pointChargeCents = 5; // a later rate change doesn't rewrite September
    const sept = statementFor(d, 'month', '2026-09-10');
    expect(sept.closedAt).toBeTruthy();
    expect(sept.pointChargeCents).toBe(1);
    expect(sept.sites.find((s) => s.storeId === 'vgo-02')!.pointsChargeCents).toBe(30);
    expect(sept.changedSinceClose.map((c) => c.storeId)).toEqual(['vgo-02']); // live numbers moved with the rate

    // Fixing a site afterwards: close the month again from the numbers as they stand.
    d.stores.find((s) => s.id === 'vgo-02')!.siteType = 'corporate';
    expect(recloseMonth(d, '2026-09', now).sites.find((s) => s.storeId === 'vgo-02')).toMatchObject({ billed: false, pointsChargeCents: 150 });
    expect(statementFor(d, 'month', '2026-09-10').changedSinceClose).toEqual([]);

    // Clearing sample data drops statements closed from sample visits only.
    d.closedMonths!.push({ month: '2026-08', closedAt: now.toISOString(), pointChargeCents: 1, sample: true, sites: [] });
    repo.clearSampleData(ADMIN);
    expect(d.closedMonths!.map((c) => c.month)).toEqual(['2026-09']);
  });

  it('leaves months before statements started open', () => {
    const { repo, d, member } = setup();
    repo.recordTransaction(tx('vgo-02', '2026-08-30T15:00:00Z', { items: inside(3000) }), member.id);
    expect(closeMonths(d, new Date('2026-10-06T16:00:00Z'))).toEqual([]);
    expect(d.statementsSince).toBe('2026-10');
    repo.recordTransaction(tx('vgo-02', '2026-10-30T15:00:00Z', { items: inside(3000) }), member.id);
    expect(closeMonths(d, new Date('2026-11-02T16:00:00Z'))).toEqual(['2026-10']);
  });

  it('works out points by rule for visits recorded before rules were kept', () => {
    const { repo, member } = setup();
    repo.recordTransaction(tx('vgo-02', '2026-10-06T15:00:00Z', { items: inside(2000), fuel: fuel(10) }), member.id);
    const entry = repo.data.ledger.at(-1)!;
    expect(entry.earned).toEqual([
      { ruleId: 'earn-inside', points: 20 },
      { ruleId: 'earn-fuel', points: 10 },
    ]);
    const old = { ...entry, earned: undefined };
    const rules = new Map(repo.data.rules.map((r) => [r.id, r]));
    expect(earnedByRule(old, rules).sort((a, b) => a.ruleId.localeCompare(b.ruleId))).toEqual([
      { ruleId: 'earn-fuel', points: 10 },
      { ruleId: 'earn-inside', points: 20 },
    ]);
  });

  it('makes inside points store-funded on saved data', () => {
    const data = seedData(now);
    data.rules.find((r) => r.id === 'earn-inside')!.fundedBy = 'jobber';
    data.migrations = data.migrations!.filter((m) => m !== '2026-10-dealers-fund-inside-points');
    migrate(data);
    expect(data.rules.find((r) => r.id === 'earn-inside')!.fundedBy).toBe('store');
  });

  it('validates site types, fees and the point rate', () => {
    const { repo } = setup();
    const store = repo.data.stores.find((s) => s.id === 'vgo-03')!;
    expect(() => repo.upsertStore({ ...store, siteType: 'franchise' as never }, ADMIN)).toThrow(/corporate or dealer/);
    expect(() => repo.upsertStore({ ...store, networkFeeCents: -1 }, ADMIN)).toThrow(/network fee/);
    expect(repo.upsertStore({ ...store, siteType: 'dealer', networkFeeCents: 9900 }, ADMIN)).toMatchObject({ siteType: 'dealer', networkFeeCents: 9900 });
    expect(() => repo.updateSettings({ pointChargeCents: -1 }, ADMIN)).toThrow(/per point/);
    expect(repo.updateSettings({ pointChargeCents: 0.5, networkFeeCents: 15_000 }, ADMIN)).toMatchObject({ pointChargeCents: 0.5 });
  });
});
