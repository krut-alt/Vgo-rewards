import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vgoAdapter } from '../src/pos/adapters.js';
import { gradeFor, PosLink, type LinkAnswer } from '../src/pos/link.js';
import { httpTransport, MockSale, type LinkTransport } from '../src/pos/mock-link.js';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';

const now = new Date('2026-10-05T16:00:00Z');

function setup() {
  const repo = new Repo(seedData(now), () => {}, () => now);
  repo.data.ledger = [];
  repo.data.stores.find((s) => s.id === 'vgo-01')!.posSiteId = 'COMM-0001';
  const link = new PosLink(repo, () => now);
  // In process, through the same adapter the server uses.
  const send: LinkTransport = async (op, body) => vgoAdapter.write(link.handle(vgoAdapter.read(op, JSON.parse(JSON.stringify(body))))) as LinkAnswer;
  const member = repo.createMember({ name: 'Jordan Smith', phone: '8645550101' }, ADMIN);
  let n = 0;
  const sale = () => new MockSale(send, 'COMM-0001', `T${++n}`, now.toISOString());
  return { repo, link, member, sale };
}

describe('POS link', () => {
  it('runs a member sale from scan to receipt', async () => {
    const { repo, member, sale } = setup();
    const s = sale();
    const id = await s.identify('(864) 555-0101');
    expect(id).toMatchObject({ status: 'ok', member: { firstName: 'Jordan', pointsBalance: 0 } });
    expect(id.op === 'identify' && id.status === 'ok' && id.redemptions.map((r) => r.rewardId)).toEqual(['redeem-fuel', 'redeem-fountain']);

    s.ring('coffee-16', 'Coffee', 199).ring('turkey-sub', 'Sandwiches', 599).ring('cigs', 'Tobacco', 899);
    // Pump authorization: gallons unknown, so the fuel discount comes as cents per gallon.
    const atPump = await s.getRewards();
    expect(atPump.rewards.find((r) => r.rewardId === 'welcome')).toMatchObject({ kind: 'fuel', centsPerGallon: 25, maxGallons: 20, centsOff: 0 });

    s.pump('UNL', 10, 319);
    const atRegister = await s.getRewards();
    expect(atRegister.rewards.find((r) => r.rewardId === 'welcome')!.centsOff).toBe(250);

    const done = await s.finalize();
    expect(done.status).toBe('recorded');
    // 7 points for $7.98 inside (tobacco earns nothing) and 10 for 10 gallons.
    expect(done.pointsEarned).toBe(17);
    expect(done.pointsBalance).toBe(17);
    expect(done.receipt).toContain('You saved $2.50');
    expect(repo.member(member.id).visitCount).toBe(1);
    expect(repo.data.ledger.at(-1)).toMatchObject({ memberId: member.id, discounts: [{ ruleId: 'welcome', centsOff: 250 }] });

    // The link retries a finalize: answered again, not counted twice.
    const again = await s.finalize();
    expect(again).toMatchObject({ status: 'duplicate', pointsEarned: 17, pointsBalance: 17 });
    expect(repo.data.ledger).toHaveLength(1);
  });

  it('records only what the POS applied, at the cents it took off', async () => {
    const { repo, member, sale } = setup();
    repo.member(member.id).pointsBalance = 500;
    repo.member(member.id).visitCount = 3;
    const s = sale();
    await s.identify('8645550101');
    s.redeem = ['redeem-fuel', 'redeem-fountain'];
    s.ring('fountain-32', 'Fountain drinks', 179).pump('Premium', 12, 359);
    const offered = await s.getRewards();
    expect(offered.rewards.map((r) => r.rewardId).sort()).toEqual(['redeem-fountain', 'redeem-fuel']);
    expect(offered.rewards.find((r) => r.rewardId === 'redeem-fountain')).toMatchObject({ lineIds: ['1'], pointsCost: 300 });

    // The cashier skipped the free drink; the fuel discount went through.
    const done = await s.finalize(['redeem-fountain']);
    expect(done.pointsSpent).toBe(100);
    expect(repo.member(member.id).pointsBalance).toBe(500 - 100 + done.pointsEarned);
    expect(repo.data.ledger.at(-1)!.discounts).toEqual([{ ruleId: 'redeem-fuel', centsOff: 120 }]);
  });

  it('lets non-members and unknown phones through without rewards', async () => {
    const { repo, sale } = setup();
    const guest = sale().ring('chips', 'Snacks', 229);
    expect((await guest.getRewards()).status).toBe('non-member');
    expect((await guest.finalize()).status).toBe('non-member');
    const stranger = sale();
    expect((await stranger.identify('8035559999')).status).toBe('unknown-member');
    expect((await stranger.ring('chips', 'Snacks', 229).getRewards()).status).toBe('unknown-member');
    expect(repo.data.ledger.map((e) => e.memberId)).toEqual([undefined]);
    expect((await stranger.cancel()).status).toBe('ok');
  });

  it('works out categories from the items catalog, the department map and department names', () => {
    const { repo, link } = setup();
    repo.data.items = { uploadedAt: now.toISOString(), items: [{ sku: '4401', upc: '012000001291', name: 'Coke 20oz', category: 'cold-drinks' }] };
    repo.data.settings.posDepartments = { '12': 'tobacco' };
    expect(link.categoryOf({ lineId: '1', posCode: '012000001291', department: '7', qty: 1, unitCents: 229 })).toBe('cold-drinks');
    expect(link.categoryOf({ lineId: '2', posCode: '999', department: '12', qty: 1, unitCents: 899 })).toBe('tobacco');
    expect(link.categoryOf({ lineId: '3', department: 'HOT DOGS', qty: 1, unitCents: 199 })).toBe('hot-food');
    expect(link.categoryOf({ lineId: '4', department: '99', qty: 1, unitCents: 100 })).toBe('other');
    expect(['UNL', 'Plus', 'PREM', 'DSL', 'super'].map(gradeFor)).toEqual(['regular', 'midgrade', 'premium', 'diesel', 'premium']);
  });

  it('feeds recorded sales in order with a cursor', async () => {
    const { link, sale } = setup();
    for (let i = 0; i < 3; i++) await sale().ring('chips', 'Snacks', 229).finalize();
    const first = link.feed({ limit: 2 });
    expect(first.transactions.map((t) => t.linkTxId)).toEqual(['T1', 'T2']);
    expect(first.transactions[0]).toMatchObject({ siteId: 'COMM-0001', storeId: 'vgo-01', insideCents: 229 });
    expect(link.feed({ after: first.next! }).transactions.map((t) => t.linkTxId)).toEqual(['T3']);
  });

  it('refuses bad requests and unknown sites', () => {
    const { link } = setup();
    expect(() => vgoAdapter.read('rewards', { siteId: 'COMM-0001', at: now.toISOString(), lines: [] })).toThrow(/linkTxId/);
    expect(() => vgoAdapter.read('rewards', { siteId: 'x', linkTxId: '1', at: 'x', lines: [{ qty: 1.5, unitCents: 1 }] })).toThrow(/whole number/);
    expect(() => link.handle({ op: 'identify', siteId: 'NOPE', loyaltyId: '8645550101' })).toThrow(/Locations page/);
  });
});

describe('POS link over HTTP', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const repo = new Repo(seedData(now), () => {}, () => now);
    repo.createMember({ name: 'Ana', phone: '8645550102' }, ADMIN);
    server = createApp(repo, 'packages/console/public', { clock: () => now, adminPassword: 'pump-4242', posKey: 'pos-secret' }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('needs the POS key', async () => {
    const res = await fetch(`${base}/api/pos/link/identify`, { method: 'POST', body: JSON.stringify({ siteId: 'vgo-01', loyaltyId: '8645550102' }) });
    expect(res.status).toBe(401);
    await expect(new MockSale(httpTransport(base, 'wrong'), 'vgo-01', 'h0', now.toISOString()).identify('8645550102')).rejects.toThrow(/401/);
  });

  it('runs a sale with the mock link and shows it in the feed', async () => {
    const s = new MockSale(httpTransport(base, 'pos-secret'), 'vgo-01', 'h1', now.toISOString());
    expect((await s.identify('8645550102')).status).toBe('ok');
    s.ring('coffee-16', 'Coffee', 199).pump('UNL', 5, 319);
    await s.getRewards();
    expect((await s.finalize()).status).toBe('recorded');
    const feed = (await (await fetch(`${base}/api/pos/feed?siteId=vgo-01`, { headers: { authorization: 'Bearer pos-secret' } })).json()) as any;
    expect(feed.transactions.map((t: any) => t.linkTxId)).toContain('h1');
    const bad = await fetch(`${base}/api/pos/link/finalize`, { method: 'POST', headers: { authorization: 'Bearer pos-secret' }, body: '{"siteId":"vgo-01"}' });
    expect(bad.status).toBe(400);
  });
});
