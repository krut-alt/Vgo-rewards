import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/repo.js';
import { seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';

const now = new Date('2026-10-05T16:00:00Z');
let server: Server;
let base = '';

beforeAll(async () => {
  const repo = new Repo(seedData(now), () => {}, () => now);
  server = createApp(repo, 'packages/console/public', { clock: () => now, appDir: 'packages/app/public', adminPassword: 'pump-4242', posKey: 'pos-secret' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function signIn(email: string, password: string) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { status: res.status, cookie, data: (await res.json()) as any };
}
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

describe('portal sign-in', () => {
  it('needs a sign-in for the portal API but not for the page or the member app', async () => {
    expect((await fetch(`${base}/api/bootstrap`)).status).toBe(401);
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/app/`)).status).toBe(200);
    expect((await fetch(`${base}/api/app/config`)).status).toBe(200);
  });

  it('signs the master admin in with "admin" and the password', async () => {
    expect((await signIn('admin', 'wrong')).status).toBe(401);
    const ok = await signIn('Admin', 'pump-4242');
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(/^vgo_portal=/);
    expect((await call(ok.cookie, 'GET', '/api/bootstrap')).data.stores).toHaveLength(13);
    await call(ok.cookie, 'POST', '/api/logout');
    expect((await call(ok.cookie, 'GET', '/api/bootstrap')).status).toBe(401);
  });

  it('lets the POS link in with its key only', async () => {
    const tx = { id: 'k1', storeId: 'vgo-01', at: '2026-10-05T15:00:00Z', items: [] };
    const post = (key: string) => fetch(`${base}/api/pos/preview`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ tx }) });
    expect((await post('nope')).status).toBe(401);
    expect((await post('pos-secret')).status).toBe(200);
    expect((await fetch(`${base}/api/bootstrap`, { headers: { authorization: 'Bearer pos-secret' } })).status).toBe(401);
  });
});

describe('store users', () => {
  it('see only their locations, and an admin can give one person several stores', async () => {
    const admin = (await signIn('admin', 'pump-4242')).cookie;
    const made = await call(admin, 'POST', '/api/users', { name: 'Pat Owner', email: 'Pat@Example.com', role: 'store', storeIds: ['vgo-01', 'vgo-02'], password: 'store-pass-1' });
    expect(made.status).toBe(201);
    expect(made.data).toMatchObject({ email: 'pat@example.com', storeIds: ['vgo-01', 'vgo-02'] });
    expect(made.data.passwordHash).toBeUndefined();

    const pat = (await signIn('pat@example.com', 'store-pass-1')).cookie;
    const boot = (await call(pat, 'GET', '/api/bootstrap')).data;
    expect(boot.stores.map((s: { id: string }) => s.id)).toEqual(['vgo-01', 'vgo-02']);
    expect(boot.me).toMatchObject({ role: 'store' });
    expect(boot.rules.some((r: { id: string }) => r.id === 'welcome')).toBe(true); // corporate rule, read-only for them
    expect(boot.rules.some((r: { id: string }) => r.id === 'tuesday-fuel')).toBe(true); // SC group, which includes their stores
    expect((await call(pat, 'PUT', '/api/rules/welcome', { name: 'Hacked' })).status).toBe(400);
    expect((await call(pat, 'GET', '/api/users')).status).toBe(403);
    expect((await call(pat, 'GET', '/api/history')).status).toBe(403);
    expect((await call(pat, 'PUT', '/api/settings', { pointsExpireMonths: 1 })).status).toBe(403);

    const offer = await call(pat, 'POST', '/api/rules', {
      name: 'Store special', section: 'offer', status: 'active', scope: { kind: 'stores', storeIds: ['vgo-02'] }, conditions: [],
      fundedBy: 'store', effect: { type: 'basketDiscount', centsOff: 1000 },
    });
    expect(offer.status).toBe(201); // no cap now
    const elsewhere = await call(pat, 'POST', '/api/rules', {
      name: 'Not mine', section: 'offer', status: 'active', scope: { kind: 'stores', storeIds: ['vgo-05'] }, conditions: [],
      fundedBy: 'store', effect: { type: 'basketDiscount', centsOff: 100 },
    });
    expect(elsewhere.status).toBe(400);

    const ga = (await call(admin, 'POST', '/api/users', { name: 'Gia', email: 'gia@example.com', role: 'store', storeIds: ['vgo-10'], password: 'store-pass-2' })).data;
    const gia = (await signIn('gia@example.com', 'store-pass-2')).cookie;
    const gaRules = (await call(gia, 'GET', '/api/bootstrap')).data.rules.map((r: { id: string }) => r.id);
    expect(gaRules).not.toContain('tuesday-fuel'); // SC-only offer
    expect(gaRules).not.toContain(offer.data.id); // another store's special
    expect(ga.storeIds).toEqual(['vgo-10']);
  });

  it('a new password signs the user out, and removing them ends access', async () => {
    const admin = (await signIn('admin', 'pump-4242')).cookie;
    const u = (await call(admin, 'POST', '/api/users', { name: 'Sam', email: 'sam@example.com', role: 'store', storeIds: ['vgo-03'], password: 'first-pass' })).data;
    const sam = (await signIn('sam@example.com', 'first-pass')).cookie;
    await call(admin, 'PUT', `/api/users/${u.id}`, { password: 'second-pass' });
    expect((await call(sam, 'GET', '/api/bootstrap')).status).toBe(401);
    const again = (await signIn('sam@example.com', 'second-pass')).cookie;
    await call(admin, 'DELETE', `/api/users/${u.id}`);
    expect((await call(again, 'GET', '/api/bootstrap')).status).toBe(401);
  });
});
