import { describe, expect, it } from 'vitest';
import { milesBetween } from '../src/geo.js';
import { parseItemsCsv, searchItems } from '../src/items.js';
import { MemberApi } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { computeResults } from '../src/results.js';
import { ADMIN, seedData } from '../src/seed.js';

const now = new Date('2026-10-05T16:00:00Z');

function setup() {
  const repo = new Repo(seedData(now), () => {}, () => now);
  const texts: string[] = [];
  const api = new MemberApi(repo, (_phone, text) => void texts.push(text), () => now);
  const join = async (phone: string, extra: Record<string, unknown> = {}) => {
    await api.requestCode(phone);
    const code = /^(\d{6})/.exec(texts[texts.length - 1]!)![1]!;
    const res = api.verify(phone, code, { firstName: 'Jordan', homeStoreId: 'vgo-01', ...extra }) as { token: string };
    return api.memberFor(`Bearer ${res.token}`);
  };
  return { repo, api, join };
}

describe('items catalog upload', () => {
  it('reads a pricebook export with its own column names', () => {
    const csv = 'Item Code,UPC,Description,Department,Retail Price\n1001,012000001291,"Coke 20oz, bottle",Cold Drinks,$2.29\n1002,,Hot dog,Hot Food,1.99\n,,No code,Snacks,1\n';
    const { items, skipped } = parseItemsCsv(csv);
    expect(skipped).toBe(1);
    expect(items[0]).toEqual({ sku: '1001', upc: '012000001291', name: 'Coke 20oz, bottle', department: 'Cold Drinks', category: 'cold-drinks', priceCents: 229 });
    expect(items[1]).toMatchObject({ sku: '1002', category: 'hot-food', priceCents: 199 });
    expect(searchItems({ items, uploadedAt: '' }, 'coke').total).toBe(1);
    expect(searchItems({ items, uploadedAt: '' }, '0120000').items[0]!.sku).toBe('1001');
  });

  it('explains a file it cannot use', () => {
    expect(() => parseItemsCsv('Name,Price\nChips,1')).toThrow(/SKU or UPC column/);
    expect(() => parseItemsCsv('SKU\n1')).toThrow(/Name or Description/);
  });
});

describe('location dashboards', () => {
  it('counts active members and splits rewards by who pays, per location and for the portfolio', () => {
    const repo = new Repo(seedData(now), () => {}, () => now);
    const all = computeResults(repo.data, 'all', now);
    expect(all.activeDays).toBe(90);
    expect(all.activeMembers).toBeGreaterThan(0);
    expect(all.locations).toHaveLength(13);
    const pilot = all.locations.find((l) => l.storeId === 'vgo-01')!;
    expect(pilot.activeMembers).toBe(all.activeMembers); // sample visits are all at the pilot
    const sum = (f: { corporateCents: number; storeCents: number; otherCents: number }) => f.corporateCents + f.storeCents + f.otherCents;
    expect(sum(pilot.rewards)).toBe(sum(all.rewardsThisMonth));
    expect(all.cashOuts.reduce((s, c) => s + sum(c.rewards), 0)).toBe(sum(all.rewardsThisMonth));

    const store2 = computeResults(repo.data, 'pilot', now, ['vgo-02']);
    expect(store2.locations.map((l) => l.storeId)).toEqual(['vgo-02']);
    expect(store2).toMatchObject({ activeMembers: 0, cashOuts: [], rollout: { total: 1 } });
  });
});

describe('customer email', () => {
  it('is optional at sign-up and editable later; phone stays the ID', async () => {
    const { api, join } = setup();
    const a = await join('8035550301');
    expect(a.email).toBeUndefined();
    const b = await join('8035550302', { email: ' Jo@Example.com ', emailOptIn: true });
    expect(b).toMatchObject({ email: 'jo@example.com', emailOptIn: true, phone: '8035550302' });
    expect(() => api.updateAccount(a, { email: 'not-an-email' })).toThrow(/email address/);
    api.updateAccount(b, { email: '' });
    expect(b.email).toBeUndefined();
  });
});

describe('near-store promos', () => {
  const vgo01 = { lat: 34.8526, lng: -82.394 };
  const nearby = { lat: 34.856, lng: -82.39 }; // about a third of a mile away
  const farAway = { lat: 33.749, lng: -84.388 }; // Atlanta

  it('only shows and adds the deal near a targeted store', async () => {
    const { repo, api, join } = setup();
    expect(milesBetween(vgo01, nearby)).toBeLessThan(0.5);
    const store = repo.store('vgo-01');
    repo.upsertStore({ ...store, ...vgo01 }, ADMIN);
    const rule = repo.createRule(
      {
        name: 'Stop in: $1 off',
        section: 'offer',
        status: 'active',
        scope: { kind: 'stores', storeIds: ['vgo-01'] },
        conditions: [],
        fundedBy: 'jobber',
        effect: { type: 'basketDiscount', centsOff: 100 },
        requiresClip: true,
        geofence: { radiusMiles: 1 },
      },
      ADMIN,
    );
    const m = await join('8035550303');
    const ids = (at?: { lat: number; lng: number }) => api.offers(m, 'vgo-01', at).offers.map((o) => o.ruleId);
    expect(api.offers(m, 'vgo-01').nearbyOffers).toBe(true);
    expect(ids()).not.toContain(rule.id);
    expect(ids(farAway)).not.toContain(rule.id);
    expect(ids(nearby)).toContain(rule.id);
    expect(() => api.setClip(m, rule.id, true, farAway)).toThrow(/near the store/);
    api.setClip(m, rule.id, true, nearby);
    expect(ids()).toContain(rule.id); // stays on the card after they drive off
  });

  it('must be an add-to-card offer with a sensible distance', () => {
    const { repo } = setup();
    const base = {
      name: 'Bad',
      section: 'offer' as const,
      status: 'draft' as const,
      scope: { kind: 'stores' as const, storeIds: ['vgo-01'] },
      conditions: [],
      fundedBy: 'jobber' as const,
      effect: { type: 'basketDiscount' as const, centsOff: 100 },
    };
    expect(() => repo.createRule({ ...base, geofence: { radiusMiles: 1 } }, ADMIN)).toThrow(/add it to their card/);
    expect(() => repo.createRule({ ...base, requiresClip: true, geofence: { radiusMiles: 100 } }, ADMIN)).toThrow(/between 0.1 and 25/);
  });
});
