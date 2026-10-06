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
  const data = seedData(now);
  data.stores.find((s) => s.id === 'vgo-01')!.siteType = 'dealer';
  const repo = new Repo(data, () => {}, () => now);
  server = createApp(repo, 'packages/console/public', { clock: () => now, adminPassword: 'pump-4242' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function signIn(email: string, password: string) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email, password }) });
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
}
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, { method, headers: { cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const pdfText = (b64: string) => Buffer.from(b64, 'base64').toString('latin1');
const pageCount = (pdf: string) => (pdf.match(/\/Type \/Page /g) ?? []).length;

describe('statement downloads', () => {
  it('give corporate users every site, and store users only their own', async () => {
    const admin = await signIn('admin', 'pump-4242');
    await call(admin, 'POST', '/api/users', { name: 'Sam Store', email: 'sam@example.com', role: 'store', storeIds: ['vgo-01', 'vgo-02'], password: 'store-pass-1' });
    const sam = await signIn('sam@example.com', 'store-pass-1');
    const q = 'period=month&date=2026-10-01';

    const all = await call(admin, 'GET', `/api/statements?${q}`);
    expect(all.data.sites).toHaveLength(13);
    expect(all.data.liability).toBeDefined();
    const allPdf = pdfText((await call(admin, 'GET', `/api/statements/pdf?${q}`)).data.pdfBase64);
    expect(allPdf.startsWith('%PDF-1.4')).toBe(true);
    expect(allPdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pageCount(allPdf)).toBe(13);

    const mine = await call(sam, 'GET', `/api/statements?${q}`);
    expect(mine.data.sites.map((s: { storeId: string }) => s.storeId)).toEqual(['vgo-01', 'vgo-02']);
    expect(mine.data.liability).toBeUndefined();
    const csv: string = (await call(sam, 'GET', `/api/statements/csv?${q}`)).data.csv;
    expect(csv.trim().split('\n')).toHaveLength(3); // header and their two sites
    expect(csv).not.toContain('VGO 03');

    const one = await call(sam, 'GET', `/api/statements/pdf?${q}&store=vgo-01`);
    expect(one.data.fileName).toBe('vgo-statement-month-2026-10-01-vgo-01.pdf');
    const pdf = pdfText(one.data.pdfBase64);
    expect(pageCount(pdf)).toBe(1);
    expect(pdf).toContain('(VGO 01) Tj');
    expect(pdf).toContain('Dealer site');
    expect(pdf).toMatch(/\((Amount due to|Credit due to) /);

    expect((await call(sam, 'GET', `/api/statements/pdf?${q}&store=vgo-03`)).status).toBe(404);
    expect((await call(sam, 'GET', `/api/statements/csv?${q}&store=vgo-03`)).status).toBe(404);
    expect((await call(sam, 'POST', '/api/statements/2026-09/reclose')).status).toBe(403);
  });

  it('keep xref offsets valid so PDF readers open the file', async () => {
    const admin = await signIn('admin', 'pump-4242');
    const pdf = pdfText((await call(admin, 'GET', '/api/statements/pdf?period=month&date=2026-10-01&store=vgo-01')).data.pdfBase64);
    const xrefAt = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xrefAt, xrefAt + 4)).toBe('xref');
    const offsets = [...pdf.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});
