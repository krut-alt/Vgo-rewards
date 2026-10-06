import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageInfo } from '../src/media.js';
import { MemberApi, promoHeadline } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';

const now = new Date('2026-10-05T16:00:00Z');

/** Just enough of a PNG for the size check. */
function png(width: number, height: number): string {
  const b = Buffer.alloc(40);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return `data:image/png;base64,${b.toString('base64')}`;
}

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
  return { status: res.status, data: (await res.json().catch(() => null)) as any, res };
};

describe('reward artwork', () => {
  it('reads image sizes from the file itself', () => {
    expect(imageInfo(Buffer.from(png(1200, 675).split(',')[1]!, 'base64'))).toEqual({ type: 'image/png', width: 1200, height: 675 });
    expect(imageInfo(Buffer.from('not an image'))).toBeUndefined();
  });

  it('only takes the standard size, then serves it on the reward in the app', async () => {
    expect((await call('POST', '/api/media', { dataUrl: png(800, 800), name: 'flyer.png' })).data.error).toMatch(/1200×675/);
    expect((await call('POST', '/api/media', { dataUrl: 'data:text/html;base64,PGI+', name: 'x' })).status).toBe(400);

    const up = await call('POST', '/api/media', { dataUrl: png(1200, 675), name: 'Fall coffee flyer.png' });
    expect(up.status).toBe(201);
    const id = up.data.id as string;
    const img = await fetch(`${base}/media/${id}`);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toMatch(/immutable/);

    const saved = await call('PUT', '/api/rules/sandwich-fillup', { artwork: { mediaId: id }, featured: true });
    expect(saved.data.display.imageUrl).toBe(`/media/${id}`);
    expect((await call('PUT', '/api/rules/sandwich-fillup', { artwork: { mediaId: 'gone' } })).data.error).toMatch(/removed/);

    expect((await call('DELETE', `/api/media/${id}`)).status).toBe(409); // still in use
    const member = repo.createMember({ name: 'Art Fan', phone: '8035550555', homeStoreId: 'vgo-01' }, { role: 'jobber-admin', userId: 't' });
    const home = members.home(member);
    expect(home.featured.map((o) => o.ruleId)).toEqual(['sandwich-fillup']);
    expect(home.featured[0]).toMatchObject({ imageUrl: `/media/${id}`, headline: '$1 OFF' });

    await call('PUT', '/api/rules/sandwich-fillup', { artwork: null });
    expect((await call('DELETE', `/api/media/${id}`)).status).toBe(200);
    expect((await fetch(`${base}/media/${id}`)).status).toBe(404);
  });

  it('makes a banner headline from the reward when none is written', () => {
    const rule = (id: string) => repo.rule(id);
    expect(promoHeadline(rule('welcome'))).toBe('25¢ OFF A GALLON');
    expect(promoHeadline(rule('coffee-card'))).toBe('6TH ONE FREE');
    expect(promoHeadline({ ...rule('welcome'), headline: 'Fill up & save' })).toBe('Fill up & save');
  });
});

describe('member profile', () => {
  it('keeps date of birth, ZIP and when they agreed to offers', () => {
    const m = repo.createMember({ name: 'Bea', phone: '8035550556', homeStoreId: 'vgo-01' }, { role: 'jobber-admin', userId: 't' });
    members.updateAccount(m, { birthDate: '03/07/1992', zip: '29601', smsOptIn: true });
    expect(m).toMatchObject({ birthDate: '1992-03-07', birthday: '03-07', zip: '29601', smsOptIn: true, smsOptInAt: now.toISOString() });
    expect(() => members.updateAccount(m, { birthDate: '1992-03-08' })).toThrow(/Ask the store/);
    members.updateAccount(m, { birthDate: '1992-03-07' }); // unchanged is fine
    expect(() => members.updateAccount(m, { zip: '123' })).toThrow(/ZIP/);
    members.updateAccount(m, { zip: '' });
    expect(m.zip).toBeUndefined();
  });
});
