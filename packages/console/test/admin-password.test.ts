import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Repo } from '../src/repo.js';
import { seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';

const now = new Date('2026-10-05T16:00:00Z');
let server: Server;
let base = '';
const basic = (pw: string) => ({ authorization: `Basic ${Buffer.from(`admin:${pw}`).toString('base64')}` });

beforeAll(async () => {
  const repo = new Repo(seedData(now), () => {}, () => now);
  server = createApp(repo, 'packages/console/public', { clock: () => now, appDir: 'packages/app/public', adminPassword: 'pump-42' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('console password', () => {
  it('asks for the password on the console and its API', async () => {
    for (const path of ['/', '/api/bootstrap', '/api/pos/preview']) {
      const res = await fetch(base + path);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic/);
    }
    expect((await fetch(`${base}/api/bootstrap`, { headers: basic('wrong') })).status).toBe(401);
  });

  it('lets the console in with the right password', async () => {
    expect((await fetch(`${base}/api/bootstrap`, { headers: basic('pump-42') })).status).toBe(200);
  });

  it('keeps the member app open', async () => {
    expect((await fetch(`${base}/app/`)).status).toBe(200);
    expect((await fetch(`${base}/app/vgo-logo.png`)).status).toBe(200);
    expect((await fetch(`${base}/api/app/config`)).status).toBe(200);
  });
});
