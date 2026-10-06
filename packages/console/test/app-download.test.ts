import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/server.js';
import { Repo } from '../src/repo.js';
import { seedData } from '../src/seed.js';

const now = new Date('2026-10-06T12:00:00Z');
let server: Server;
let base = '';

beforeAll(async () => {
  const repo = new Repo(seedData(now), () => {}, () => now);
  // With a portal password set, the download page must still be open to customers.
  server = createApp(repo, 'packages/console/public', { clock: () => now, appDir: 'packages/app/public', adminPassword: 'pump-4242' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('phone app download page', () => {
  it('sends /download to the page', async () => {
    for (const path of ['/download', '/app/download']) {
      const res = await fetch(base + path, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/app/download/');
    }
  });

  it('serves the page without signing in', async () => {
    const res = await fetch(`${base}/app/download/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('vgo-rewards.apk');
  });

  it('still serves the member app at /app/', async () => {
    const res = await fetch(`${base}/app/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/app/app.js');
  });
});
