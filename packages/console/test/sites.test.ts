import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { storeSpotFiller } from '../src/geocode.js';
import { MemberApi } from '../src/member-api.js';
import { PILOT_SITE, useRealSites, VGO_SITES } from '../src/migrate.js';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';
// @ts-expect-error untyped browser module
import { termsSections } from '../../app/public/legal.js';

const now = new Date('2026-10-06T16:00:00Z');
const fresh = () => new Repo(seedData(now), () => {}, () => now);

describe('real VGO sites', () => {
  it('turns the pilot into VGO #31 and adds the other sites as coming soon', () => {
    const repo = fresh();
    const d = repo.data;
    const member = d.members.find((m) => m.homeStoreId === 'vgo-01')!;
    d.members[1]!.homeStoreId = 'vgo-05';
    useRealSites(d);
    expect(d.stores).toHaveLength(VGO_SITES.length);
    const pilot = d.stores.find((s) => s.id === 'vgo-01')!;
    expect(pilot).toMatchObject({ name: `VGO #${PILOT_SITE}`, city: 'Greenville', state: 'SC', loyaltyLive: true, pos: 'verifone-commander' });
    expect(d.stores.filter((s) => s.loyaltyLive).map((s) => s.name)).toEqual(['VGO #31']);
    expect(d.stores.find((s) => s.name === 'VGO #28')).toMatchObject({ id: 'vgo-28', city: 'Fayetteville', state: 'NC', groupIds: ['nc'], loyaltyLive: false });
    expect(d.stores.find((s) => s.name === 'VGO #3')).toMatchObject({ zip: '29681' });
    // Nothing points at a removed placeholder.
    expect(member.homeStoreId).toBe('vgo-01');
    expect(d.members[1]!.homeStoreId).toBe('vgo-01');
    const ids = new Set(d.stores.map((s) => s.id));
    for (const r of d.rules) if (r.scope.kind === 'stores') for (const id of r.scope.storeIds) expect(ids.has(id)).toBe(true);
    // Running it again changes nothing.
    useRealSites(d);
    expect(d.stores).toHaveLength(VGO_SITES.length);
  });

  it('keeps placeholders the portal already edited', () => {
    const repo = fresh();
    repo.data.stores[4]!.city = 'Anderson';
    useRealSites(repo.data);
    expect(repo.data.stores.some((s) => s.id === 'vgo-05')).toBe(true);
  });

  it('only live stores take visits, and the switch is logged', () => {
    const repo = fresh();
    useRealSites(repo.data);
    const m = repo.data.members[0]!;
    const tx = { id: 't1', storeId: 'vgo-25', at: now.toISOString(), localHour: 12, localDayOfWeek: 2, items: [] };
    expect(() => repo.recordTransaction(tx, m.id)).toThrow(/not live/);
    expect(repo.setStoreLive('vgo-25', true, ADMIN).loyaltyLive).toBe(true);
    expect(repo.recordTransaction({ ...tx, id: 't2' }, m.id)).toBeTruthy();
    expect(repo.data.history[0]!.what).toMatch(/VGO #25 is now live/);
    expect(() => repo.setStoreLive('vgo-25', false, { role: 'store-manager', userId: 'x', storeIds: ['vgo-25'] } as never)).toThrow(/jobber admin/);
  });

  it('terms say rewards are valid only at participating locations', () => {
    const repo = fresh();
    useRealSites(repo.data);
    const terms = JSON.stringify(termsSections(new MemberApi(repo, () => {}, () => now).programFacts()));
    expect(terms).toMatch(/valid ONLY at participating locations/);
    expect(terms).toMatch(/no store is required to participate/);
    expect(terms).toMatch(/participating locations today are: VGO #31/);
    expect(terms).not.toMatch(/every live store/);
  });
});

describe('map spots from addresses', () => {
  it('fills missing spots, remembers misses, and retries when the address changes', async () => {
    const repo = fresh();
    useRealSites(repo.data);
    const asked: string[] = [];
    const fill = storeSpotFiller(
      repo,
      async (a) => {
        asked.push(a);
        return a.startsWith('Mauldin') ? undefined : { lat: 34.8, lng: -82.3 };
      },
      0,
    );
    await fill();
    const s25 = repo.data.stores.find((s) => s.name === 'VGO #25')!;
    expect(s25).toMatchObject({ lat: 34.8, lng: -82.3 });
    expect(asked).toContain('469 Roper Mountain Road, Greenville, SC');
    const s33 = repo.data.stores.find((s) => s.name === 'VGO #33')!;
    expect(s33.lat).toBeUndefined();
    expect(s33.mapLookupFailed).toBe('Mauldin Road & Fairforest Road, Greenville, SC');
    const before = asked.length;
    await fill();
    expect(asked).toHaveLength(before);
    repo.upsertStore({ ...s33, address: '100 Mauldin Road' }, ADMIN);
    await fill();
    expect(repo.data.stores.find((s) => s.name === 'VGO #33')).toMatchObject({ lat: 34.8 });
  });

  it('runs a lookup pass when the server starts and after a store is saved', async () => {
    const repo = fresh();
    useRealSites(repo.data);
    const asked: string[] = [];
    const server: Server = createApp(repo, 'packages/console/public', { clock: () => now, geocoder: async (a) => (asked.push(a), { lat: 34, lng: -82 }) }).listen(0);
    afterAll(() => server.close());
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/stores/vgo-25/live`, { method: 'POST', body: JSON.stringify({ live: true }) });
    expect(((await res.json()) as { loyaltyLive: boolean }).loyaltyLive).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(asked.length).toBeGreaterThan(0);
  });
});
