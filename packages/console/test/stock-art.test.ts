import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsoleRule } from '../src/model.js';
import { MemberApi } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { STOCK_ART, pickStockArt, stockArtFor } from '../src/stock-art.js';
import { existsSync } from 'node:fs';

const now = new Date('2026-10-05T16:00:00Z');
let repo: Repo;
let server: Server;
let base = '';
let members: MemberApi;
beforeAll(async () => {
  repo = new Repo(seedData(now), () => {}, () => now);
  members = new MemberApi(repo, () => {}, () => now, true);
  server = createApp(repo, 'packages/console/public', { clock: () => now, memberApi: members }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
};

/** A store offer with just a name and what it discounts. */
const offer = (name: string, effect: Partial<ConsoleRule['effect']> = {}, extra: Partial<ConsoleRule> = {}): ConsoleRule =>
  ({ ...repo.rule('sandwich-fillup'), name, memberText: undefined, conditions: [], effect: { type: 'itemDiscount', centsOff: 100, maxQty: 1, ...effect }, ...extra }) as ConsoleRule;

describe('stock pictures', () => {
  it('has a picture file for every catalog entry', () => {
    for (const a of STOCK_ART) expect(existsSync(`packages/console/public/stock/${a.id}.svg`), a.id).toBe(true);
  });

  it('picks a picture from the reward name, brand words included', () => {
    expect(pickStockArt(offer('2 Coca-Cola 20oz for $4')).id).toBe('soda');
    expect(pickStockArt(offer('Frito-Lay chips 2 for $3')).id).toBe('chips');
    expect(pickStockArt(offer("Lay's BBQ deal")).id).toBe('chips');
    expect(pickStockArt(offer('Hot dogs $1.29')).id).toBe('hotdog');
    expect(pickStockArt(offer('Red Bull 12oz $1 off')).id).toBe('energy');
    expect(pickStockArt(offer('Pizza slice and a drink')).id).toBe('pizza');
    expect(pickStockArt(offer('Mystery deal')).id).toBe('gift');
  });

  it('uses the kind of reward, its categories and item names when the name says little', () => {
    expect(pickStockArt(offer('Tuesday deal', { type: 'fuelDiscount', centsPerGallon: 5, maxGallons: 20 } as never)).id).toBe('pump');
    expect(pickStockArt(offer('Weekday deal', { categories: ['snacks'] })).id).toBe('chips');
    repo.data.items = { uploadedAt: now.toISOString(), items: [{ sku: '0281', name: 'DORITOS NACHO 9.25OZ' }] };
    expect(pickStockArt(offer('Weekday deal', { skus: ['0281'] }), repo.data.items).id).toBe('chips');
    const seeded = (id: string) => pickStockArt(repo.rule(id)).id;
    expect([seeded('welcome'), seeded('birthday-treat'), seeded('coffee-card'), seeded('sandwich-fillup'), seeded('manufacturer-energy')]).toEqual([
      'pump',
      'cake',
      'coffee',
      'sandwich',
      'energy',
    ]);
  });

  it('lets a reward pin a picture or turn it off, and uploaded artwork always wins', () => {
    const r = offer('Coke deal');
    expect(stockArtFor({ ...r, stockArt: 'candy' })?.id).toBe('candy');
    expect(stockArtFor({ ...r, stockArt: 'none' })).toBeUndefined();
    expect(stockArtFor({ ...r, artwork: { mediaId: 'x' } })).toBeUndefined();
  });

  it('shows the picture in the console and the app, and serves the file', async () => {
    const saved = await call('PUT', '/api/rules/sandwich-fillup', { stockArt: 'pizza' });
    expect(saved.data.display.stockArt).toMatchObject({ id: 'pizza', url: '/stock/pizza.svg' });
    expect(saved.data.display.autoStockArt).toBe('sandwich');
    expect((await call('PUT', '/api/rules/sandwich-fillup', { stockArt: 'unicorn' })).data.error).toMatch(/stock picture/);
    const boot = await call('GET', '/api/bootstrap');
    expect(boot.data.stockArt.length).toBe(STOCK_ART.length);

    const member = repo.createMember({ name: 'Pic Fan', phone: '8035550577', homeStoreId: 'vgo-01' }, { role: 'jobber-admin', userId: 't' });
    const sandwich = members.offers(member).offers.find((o) => o.ruleId === 'sandwich-fillup');
    expect(sandwich).toMatchObject({ stockArtUrl: '/stock/pizza.svg' });
    expect(sandwich?.imageUrl).toBeUndefined();
    const redeem = members.redeemOptions(member).find((o) => o.ruleId === 'redeem-fountain');
    expect(redeem).toMatchObject({ stockArtUrl: '/stock/fountain.svg' });

    const file = await fetch(`${base}/stock/pump.svg`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/svg+xml');
  });
});
