import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemberApi } from '../src/member-api.js';
import { addItemUpload, ALL_STORES, catalogFor, everyItem } from '../src/items.js';
import { PosLink } from '../src/pos/link.js';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';

const now = new Date('2026-10-05T16:00:00Z');
const csv = (rows: string[]) => ['SKU,UPC,Name,Department,Price', ...rows].join('\n');

describe('item lists by store', () => {
  it('keeps the old catalog as the all-stores list and lets a store have its own', () => {
    const repo = new Repo(seedData(now), () => {}, () => now);
    const d = repo.data;
    d.items = { uploadedAt: '2026-10-01T00:00:00Z', items: [{ sku: '1', name: 'Old coffee', category: 'coffee' }] };
    expect(catalogFor(d, 'vgo-01')?.items[0]!.name).toBe('Old coffee');

    addItemUpload(d, [{ sku: '2', name: 'Store sub', category: 'sandwiches' }], { id: 'u1', storeIds: ['vgo-01'], at: now.toISOString(), by: 'master', skipped: 0, fileKept: true });
    expect(d.items).toBeUndefined();
    expect(catalogFor(d, 'vgo-01')?.items.map((i) => i.sku)).toEqual(['2']);
    expect(catalogFor(d, 'vgo-02')?.items.map((i) => i.sku)).toEqual(['1']);
    expect(everyItem(d)?.items.map((i) => i.sku).sort()).toEqual(['1', '2']);

    // A new all-stores upload replaces the old one; the store keeps its own list.
    addItemUpload(d, [{ sku: '3', name: 'New coffee' }], { id: 'u2', storeIds: [], at: now.toISOString(), by: 'master', skipped: 0, fileKept: true });
    expect(d.currentItems).toEqual({ [ALL_STORES]: 'u2', 'vgo-01': 'u1' });
    expect(Object.keys(d.itemLists!).sort()).toEqual(['u1', 'u2']);
    expect(d.itemUploads!.map((u) => u.id)).toEqual(['u1', 'u2']);
    expect(() => addItemUpload(d, [], { id: 'u3', storeIds: ['nope'], at: now.toISOString(), by: 'master', skipped: 0, fileKept: false })).toThrow(/Unknown store/);
  });
});

describe('items and gas prices over HTTP', () => {
  let server: Server;
  let base = '';
  let repo: Repo;
  beforeAll(async () => {
    repo = new Repo(seedData(now), () => {}, () => now);
    server = createApp(repo, 'packages/console/public', { clock: () => now }).listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + '/api' + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as any };
  };

  it('uploads to chosen stores, keeps the history and the original file', async () => {
    const all = await call('POST', '/items/upload', { csv: csv(['100,,Coffee 16oz,Coffee,1.99']), fileName: 'all.csv' });
    expect(all.data.upload.storeIds).toEqual([]);
    const mine = await call('POST', '/items/upload', { csv: csv(['200,,Turkey sub,Sandwiches,5.99', '201,,Chips,Snacks,2.29']), fileName: 'vgo01.csv', storeIds: ['vgo-01'] });
    expect(mine.status).toBe(200);

    const forStore = await call('GET', '/items?store=vgo-01');
    expect(forStore.data).toMatchObject({ ownList: true, count: 2, fileName: 'vgo01.csv' });
    expect(forStore.data.uploads.map((u: any) => u.fileName)).toEqual(['vgo01.csv', 'all.csv']);
    const other = await call('GET', '/items?store=vgo-02');
    expect(other.data).toMatchObject({ ownList: false, count: 1 });
    expect(other.data.uploads.map((u: any) => u.fileName)).toEqual(['all.csv']);

    const file = await call('GET', `/items/uploads/${mine.data.upload.id}/file`);
    expect(file.data.csv).toContain('Turkey sub');

    await call('DELETE', '/items/stores/vgo-01');
    expect((await call('GET', '/items?store=vgo-01')).data).toMatchObject({ ownList: false, count: 1 });
    expect((await call('POST', '/items/upload', { csv: csv(['1,,X,Snacks,1']), storeIds: ['nope'] })).status).toBe(404);
  });

  it('shows gas prices from the POS and from the portal in the app', async () => {
    const store = repo.data.stores.find((s) => s.id === 'vgo-01')!;
    store.posSiteId = 'COMM-1';
    const link = new PosLink(repo, () => now);
    link.handle({ op: 'prices', siteId: 'COMM-1', prices: [{ grade: 'UNL', pricePerGallonCents: 319.9 }, { grade: 'DSL', pricePerGallonCents: 389.9 }] });
    // A fuel sale reports the pump price too; an older report never replaces a newer price.
    link.handle({ op: 'rewards', sale: { siteId: 'COMM-1', linkTxId: 'p1', at: now.toISOString(), lines: [], fuel: { grade: 'PREM', gallons: 5, pricePerGallonCents: 409.9 } } });
    link.handle({ op: 'prices', siteId: 'COMM-1', prices: [{ grade: 'UNL', pricePerGallonCents: 299.9, at: '2026-10-01T00:00:00Z' }] });
    expect(store.fuelPrices).toMatchObject({ regular: { cents: 319.9, source: 'pos' }, premium: { cents: 409.9 }, diesel: { cents: 389.9 } });

    // Typed in the portal: diesel corrected, premium cleared. Saving the location keeps prices.
    const set = await call('PUT', '/stores/vgo-01/fuel-prices', { prices: { diesel: '3.859', premium: null } });
    expect(set.status).toBe(200);
    await call('PUT', '/stores/vgo-01', { ...store, fuelPrices: undefined, tagline: 'Hot coffee' });
    expect(Object.keys(repo.data.stores.find((s) => s.id === 'vgo-01')!.fuelPrices!)).toEqual(['regular', 'diesel']);
    expect((await call('PUT', '/stores/vgo-01/fuel-prices', { prices: { regular: 'cheap' } })).status).toBe(400);

    const m = repo.createMember({ name: 'Ana', phone: '8645550111' }, ADMIN);
    const app = new MemberApi(repo, undefined, () => now).storeLocator(m);
    expect(app.stores.find((s) => s.id === 'vgo-01')!.fuelPrices).toEqual([
      { grade: 'regular', label: 'Regular', price: '3.199', updatedAt: now.toISOString() },
      { grade: 'diesel', label: 'Diesel', price: '3.859', updatedAt: now.toISOString() },
    ]);
    // A week-old price is no longer shown.
    const later = new MemberApi(repo, undefined, () => new Date('2026-10-13T16:00:01Z')).storeLocator(m);
    expect(later.stores.find((s) => s.id === 'vgo-01')!.fuelPrices).toEqual([]);
  });
});
