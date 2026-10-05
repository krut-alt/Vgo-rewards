import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { computeResults } from '../src/results.js';

const now = new Date('2026-10-05T16:00:00Z');
let repo: Repo;
let server: Server;
let base: string;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
}

beforeAll(async () => {
  repo = new Repo(seedData(now), () => {}, () => now);
  server = createApp(repo, 'packages/console/public', () => now).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('console API', () => {
  it('labels rules the way the offers screen shows them', async () => {
    const { data } = await call('GET', '/bootstrap');
    const byId = Object.fromEntries(data.rules.map((r: any) => [r.id, r.display]));
    expect(byId.welcome).toMatchObject({ status: 'Live', type: 'Fuel discount', target: 'All 13 stores', runs: 'Always on' });
    expect(byId['tuesday-fuel']).toMatchObject({ status: 'Scheduled', target: 'Group: SC stores' });
    expect(byId['sandwich-fillup']).toMatchObject({ type: 'Item with fuel', target: 'VGO 01 only', funded: 'Store' });
    expect(byId['manufacturer-energy'].status).toBe('Draft');
  });

  it('drafts a rule from words and saves it paused', async () => {
    const { data: draft } = await call('POST', '/rules/draft', { text: 'Double points on snacks at the pilot store this weekend' });
    expect(draft.ok).toBe(true);
    const { status, data: saved } = await call('POST', '/rules', draft.rule);
    expect(status).toBe(201);
    expect(saved.status).toBe('paused');
    expect(saved.display.status).toBe('Paused');
  });

  it('rejects a broken rule with readable problems', async () => {
    const { status, data } = await call('POST', '/rules', { name: '', section: 'offer', status: 'active', scope: { kind: 'stores', storeIds: [] }, conditions: [], fundedBy: 'jobber', effect: { type: 'fuelDiscount', centsPerGallon: 0, maxGallons: 20 } });
    expect(status).toBe(400);
    expect(data.problems).toEqual(expect.arrayContaining(['Give the rule a name.', 'Choose at least one store.', 'Cents per gallon must be between 1 and 200.']));
  });

  it('clears optional fields sent as null', async () => {
    const { data } = await call('PUT', '/rules/sandwich-fillup', { schedule: null, perMemberLimit: null });
    expect(data.schedule).toBeUndefined();
    expect(data.perMemberLimit).toBeUndefined();
    expect(data.display.runs).toBe('Always on');
  });

  it('flags a store-funded discount above the store max in checks, when a max is set', async () => {
    const check = () => call('POST', '/rules/check', {
      name: 'Big deal',
      section: 'offer',
      status: 'draft',
      scope: { kind: 'stores', storeIds: ['vgo-01'] },
      conditions: [],
      fundedBy: 'store',
      effect: { type: 'basketDiscount', centsOff: 500 },
    });
    expect((await check()).data.checks.some((c: { text: string }) => /max discount/.test(c.text))).toBe(false); // no cap by default
    repo.data.settings.maxStoreDiscountCents = 200;
    expect((await check()).data.checks).toContainEqual({ ok: false, text: "Above the store's max discount of $2" });
    repo.data.settings.maxStoreDiscountCents = 0;
  });

  it('records a POS transaction and updates the member', async () => {
    const { data: m } = await call('POST', '/members', { name: 'Test Driver', phone: '(803) 555-0199' });
    const tx = { id: 'pos-1', storeId: 'vgo-01', at: '2026-10-05T15:00:00Z', items: [{ sku: 'c', category: 'coffee', qty: 1, unitCents: 199 }], fuel: { grade: 'regular', gallons: 12.5, pricePerGallonCents: 309 } };
    const { status, data } = await call('POST', '/pos/transactions', { tx, memberId: m.id });
    expect(status).toBe(201);
    expect(data.appliedRuleIds).toContain('welcome');
    expect(data.discounts[0]).toMatchObject({ centsPerGallon: 25, centsOff: 313 });
    const { data: after } = await call('GET', `/members/${m.id}`);
    expect(after.member).toMatchObject({ visitCount: 1, pointsBalance: 13, punches: { 'coffee-fountain': 1 } });
    expect((await call('POST', '/pos/transactions', { tx, memberId: m.id })).status).toBe(409);
  });

  it('finds the member from the phone number or barcode the POS sends', async () => {
    const { data: m } = await call('POST', '/members', { name: 'Pin Pad', phone: '803-555-0177' });
    const tx = { id: 'pos-3', storeId: 'vgo-01', at: '2026-10-05T16:00:00Z', items: [], fuel: { grade: 'regular', gallons: 10, pricePerGallonCents: 309 } };
    const preview = await call('POST', '/pos/preview', { tx, loyaltyId: '18035550177' });
    expect(preview.data.appliedRuleIds).toContain('welcome');
    const { status } = await call('POST', '/pos/transactions', { tx, loyaltyId: '8035550177' });
    expect(status).toBe(201);
    expect((await call('GET', `/members/${m.id}`)).data.member.visitCount).toBe(1);
    const unknown = await call('POST', '/pos/preview', { tx: { ...tx, id: 'pos-4' }, loyaltyId: '8035550000' });
    expect(unknown).toMatchObject({ status: 404, data: { error: 'No member with that phone number.' } });
  });

  it('refuses member transactions at stores without loyalty', async () => {
    const tx = { id: 'pos-2', storeId: 'vgo-02', at: '2026-10-05T15:00:00Z', items: [] };
    const { data: list } = await call('GET', '/members?q=test');
    expect((await call('POST', '/pos/transactions', { tx, memberId: list.members[0].id })).status).toBe(409);
  });

  it('validates branding', async () => {
    expect((await call('PUT', '/branding', { mainColor: 'navy' })).status).toBe(400);
    const { data } = await call('PUT', '/branding', { accentColor: '#AA0000' });
    expect(data.accentColor).toBe('#AA0000');
  });

  it('logs every change', async () => {
    const { data } = await call('GET', '/history');
    expect(data[0].what).toContain('branding');
  });
});

describe('results', () => {
  it('computes pilot KPIs from sample visits and clears them', () => {
    const r = new Repo(seedData(now), () => {}, () => now);
    const res = computeResults(r.data, 'pilot', now);
    expect(res.sample).toBe(true);
    expect(res.pilot).toEqual({ storeName: 'VGO 01', day: 45, days: 90 });
    expect(res.gallonsPerVisit.member).toBeGreaterThan(res.gallonsPerVisit.nonMember);
    r.clearSampleData(ADMIN);
    expect(computeResults(r.data, 'pilot', now)).toMatchObject({ sample: false, membersEnrolled: 0 });
  });
});

describe('data updates on load', () => {
  it('excludes alcohol from points and removes the store cap on older data, once', async () => {
    const { migrate } = await import('../src/migrate.js');
    const old = seedData(now);
    delete old.migrations;
    const earn = old.rules.find((r) => r.id === 'earn-inside')!;
    if (earn.effect.type === 'pointsPerDollar') earn.effect.excludeCategories = ['tobacco', 'lottery', 'gift-cards'];
    old.settings.maxStoreDiscountCents = 200;
    expect(migrate(old)).toBe(true);
    expect(earn.effect).toMatchObject({ excludeCategories: ['tobacco', 'lottery', 'gift-cards', 'beer'] });
    expect(old.settings.maxStoreDiscountCents).toBe(0);
    old.settings.maxStoreDiscountCents = 300; // changed in the portal later
    expect(migrate(old)).toBe(false);
    expect(old.settings.maxStoreDiscountCents).toBe(300);
  });
});
