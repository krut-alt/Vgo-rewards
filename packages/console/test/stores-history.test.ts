import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemberApi } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';

const now = new Date('2026-10-05T16:00:00Z');

let repo: Repo;
let members: MemberApi;
let server: Server;
let base = '';
beforeAll(async () => {
  repo = new Repo(seedData(now), () => {}, () => now);
  members = new MemberApi(repo, () => {}, () => now, true);
  server = createApp(repo, 'packages/console/public', { clock: () => now, memberApi: members }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const addPhoto = (id: string) => (repo.data.media ??= []).push({ id, name: `${id}.jpg`, type: 'image/jpeg', width: 1200, height: 675, bytes: 1000, uploadedAt: now.toISOString(), uploadedBy: 'krut' } as never);

describe('store locator', () => {
  it('lists every location with its map spot, photo, promo line and offers', () => {
    addPhoto('photo1');
    const pilot = repo.data.stores.find((s) => s.id === 'vgo-01')!;
    repo.upsertStore({ ...pilot, lat: 34.85, lng: -82.39, photoMediaId: 'photo1', tagline: '  Hot food, cold drinks  ', hours: 'Open 24 hours' }, ADMIN);
    const m = repo.data.members.find((x) => x.homeStoreId === 'vgo-01')!;
    const { homeStoreId, stores } = members.storeLocator(m);
    expect(homeStoreId).toBe('vgo-01');
    expect(stores).toHaveLength(repo.data.stores.length);
    const s = stores.find((x) => x.id === 'vgo-01')!;
    expect(s).toMatchObject({ lat: 34.85, lng: -82.39, photoUrl: '/media/photo1', tagline: 'Hot food, cold drinks', hours: 'Open 24 hours', loyaltyLive: true });
    expect(s.offers).toBeGreaterThan(0);
    const later = stores.find((x) => !x.loyaltyLive)!;
    expect(later).toMatchObject({ lat: null, photoUrl: null, offers: 0 });
  });

  it('rejects a photo that is not in the library and overlong text', () => {
    const s = repo.data.stores[1]!;
    expect(() => repo.upsertStore({ ...s, photoMediaId: 'missing' }, ADMIN)).toThrow(/no longer in the artwork library/);
    expect(() => repo.upsertStore({ ...s, hours: 'x'.repeat(81) }, ADMIN)).toThrow(/under 80/);
  });

  it('keeps a store photo from being deleted while a store uses it', async () => {
    const res = await fetch(`${base}/api/media/photo1`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/store photo/);
  });
});

describe('transaction history', () => {
  it('pages through every visit, newest first, with lifetime totals', () => {
    const counts = new Map<string, number>();
    for (const e of repo.data.ledger) if (e.memberId) counts.set(e.memberId, (counts.get(e.memberId) ?? 0) + 1);
    const [id, visits] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
    const m = repo.member(id);
    const first = members.history(m, undefined, 3);
    expect(first.totals.visits).toBe(visits);
    expect(first.entries).toHaveLength(Math.min(3, visits));
    expect(first.entries[0]!.at >= first.entries.at(-1)!.at).toBe(true);
    const e = first.entries[0]!;
    expect(e.paidCents).toBe(Math.max(0, e.insideCents + e.fuelCents - e.savedCents));
    expect(e.store).toBe('VGO 01');
    if (visits > 3) {
      const next = members.history(m, first.entries.at(-1)!.id, 3);
      expect(next.entries[0]!.id).not.toBe(first.entries[0]!.id);
    }
    const all = members.history(m, undefined, 1000);
    expect(all.more).toBe(false);
    expect(all.totals.pointsEarned).toBe(all.entries.reduce((s, x) => s + x.pointsEarned, 0));
    expect(all.totals.pointsBalance).toBe(m.pointsBalance);
  });

  it('is empty for a new member', () => {
    const m = { ...repo.data.members[0]!, id: 'nobody' };
    expect(members.history(m)).toMatchObject({ entries: [], more: false, totals: { visits: 0, paidCents: 0 } });
  });
});
