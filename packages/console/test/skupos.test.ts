import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { MemberApi } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { applySkupos, parseSkuposCsv, parseSkuposJson, skuposFeedFromEnv, SkuposSync } from '../src/skupos.js';

// 2026-10-06, noon at the stores.
const at = (iso: string) => new Date(iso);
let now = at('2026-10-06T16:00:00Z');
const clock = () => now;

const LIST = [
  'Promotion ID,Brand,Offer,UPCs,Category,Discount,Limit,Start date,End date,21+,Stores',
  'ENG-1042,Marlboro,$1.00 off 2 packs,028200003577;028200003843,Tobacco,1.00,2,10/1/2026,10/31/2026,No,',
  'ENG-1077,Red Bull,50¢ off any 16 oz,611269991000,Energy drinks,50¢,1,10/6/2026,11/2/2026,No,VGO #2',
  'ENG-1100,Grizzly,$2 off a can,042400000123,,2,1,10/1/2026,10/3/2026,,',
  ',,,,,1.00,,,10/31/2026,,',
].join('\n');

function setup() {
  now = at('2026-10-06T16:00:00Z');
  const repo = new Repo(seedData(now), () => {}, clock);
  const live = repo.data.stores.find((s) => s.loyaltyLive)!;
  const offline = repo.data.stores.find((s) => !s.loyaltyLive)!;
  const texts: string[] = [];
  const api = new MemberApi(repo, (_p, t) => void texts.push(t), clock);
  const signUp = async (phone: string, birthDate: string) => {
    await api.requestCode(phone);
    const code = /^(\d{6})/.exec(texts[texts.length - 1]!)![1]!;
    await api.verify(phone, code, { firstName: 'Jo', homeStoreId: live.id, birthDate });
    return repo.data.members.find((m) => m.phone === phone)!;
  };
  const enroll = (id: string, on = true) => repo.upsertStore({ ...repo.store(id), skuposEnrolled: on }, ADMIN);
  return { repo, live, offline, api, signUp, enroll, sync: new SkuposSync(repo, clock) };
}

describe('reading a Skupos promotions list', () => {
  it('reads the columns Skupos uses, and says why rows were left out', () => {
    const { promos, skipped } = parseSkuposCsv(LIST, '2026-10-06');
    expect(promos.map((p) => p.id)).toEqual(['ENG-1042', 'ENG-1077', 'ENG-1100']);
    expect(promos[0]).toMatchObject({ brand: 'Marlboro', upcs: ['028200003577', '028200003843'], category: 'tobacco', centsOff: 100, maxQty: 2, startsOn: '2026-10-01', endsOn: '2026-10-31' });
    // Tobacco is always 21+, whatever the row says; an energy drink follows the row.
    expect(promos[0]!.ageRestricted).toBe(true);
    expect(promos[1]).toMatchObject({ centsOff: 50, ageRestricted: false, stores: ['VGO #2'] });
    // No category given: treated as 21+, since most Skupos promotions are tobacco.
    expect(promos[2]!.ageRestricted).toBe(true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/no brand or offer name/);
  });

  it('reads a feed answer in JSON', () => {
    const { promos } = parseSkuposJson(
      { promotions: [{ promotionId: 'P1', brand: 'Copenhagen', name: '$1 off', upcs: ['073100000106'], category: 'Tobacco', discount_amount: 1, start_date: '2026-10-01', end_date: '2026-10-20' }] },
      '2026-10-06',
    );
    expect(promos[0]).toMatchObject({ id: 'P1', brand: 'Copenhagen', centsOff: 100, ageRestricted: true, endsOn: '2026-10-20' });
    expect(() => parseSkuposJson({ nope: 1 }, '2026-10-06')).toThrow(/list of promotions/);
  });

  it('turns away a file that is not a promotions list', () => {
    expect(() => parseSkuposCsv('SKU,Name,Price\n1,Chips,2.29', '2026-10-06')).toThrow(/columns/);
  });
});

describe('Skupos promotions in the app', () => {
  it('only reach stores that are enrolled in Skupos and live, tagged as Skupos', async () => {
    const { repo, live, offline, api, signUp, enroll, sync } = setup();
    const run0 = sync.upload(LIST, 'engage.csv');
    // Nobody is enrolled yet: nothing goes into the app.
    expect(run0.created).toEqual([]);
    expect(repo.data.rules.some((r) => r.skupos)).toBe(false);

    enroll(live.id);
    enroll(offline.id);
    const run = applySkupos(repo, 'stores', now);
    expect(run.created).toEqual(['Marlboro: $1.00 off 2 packs']);
    // The Red Bull promo runs only at VGO 02, which is offline, and the Grizzly one ended on Oct 3.
    const marlboro = repo.data.rules.find((r) => r.skupos?.promoId === 'ENG-1042')!;
    expect(marlboro).toMatchObject({ status: 'active', section: 'offer', fundedBy: 'manufacturer', requiresClip: true, scope: { kind: 'stores', storeIds: [live.id] } });
    expect(marlboro.conditions).toEqual([{ type: 'minAge', years: 21 }]);
    expect(marlboro.effect).toMatchObject({ type: 'itemDiscount', skus: ['028200003577', '028200003843'], centsOff: 100, maxQty: 2 });

    const adult = await signUp('8035550801', '1990-01-01');
    const young = await signUp('8035550802', '2006-01-01');
    const offer = api.offers(adult, live.id).offers.find((o) => o.ruleId === marlboro.id)!;
    expect(offer).toMatchObject({ skupos: true, kind: 'brand', how: 'clip' });
    expect(offer.kicker).toMatch(/^Skupos brand offer/);
    expect(api.offers(young, live.id).offers.some((o) => o.ruleId === marlboro.id)).toBe(false);
    expect(api.offers(adult, offline.id).offers.some((o) => o.ruleId === marlboro.id)).toBe(false);

    // The register takes it off by UPC once it's on the card.
    api.setClip(adult, marlboro.id, true);
    const result = repo.preview(
      { id: 't1', storeId: live.id, at: now.toISOString(), localHour: 12, localDayOfWeek: 2, localDate: '2026-10-06', items: [{ sku: '028200003577', category: 'tobacco', qty: 2, unitCents: 999 }] },
      adult.id,
    );
    expect(result.discounts.filter((x) => x.fundedBy === 'manufacturer')).toEqual([expect.objectContaining({ ruleId: marlboro.id, centsOff: 200, fundedBy: 'manufacturer' })]);

    // The offline store goes live: it joins on the spot, and gets its own Red Bull promo.
    expect(offline.name).toBe('VGO 02');
    repo.setStoreLive(offline.id, true, ADMIN);
    sync.storesChanged();
    expect(repo.rule(marlboro.id).scope).toEqual({ kind: 'stores', storeIds: [live.id, offline.id] });
    expect(repo.data.rules.find((r) => r.skupos?.promoId === 'ENG-1077')!.scope).toEqual({ kind: 'stores', storeIds: [offline.id] });
  });

  it('runs once a day, ends promotions on time, and leaves hand-paused ones alone', async () => {
    const { repo, live, enroll, sync } = setup();
    enroll(live.id);
    sync.upload(LIST, 'engage.csv');
    const id = repo.data.rules.find((r) => r.skupos?.promoId === 'ENG-1042')!.id;

    expect(await sync.daily()).toBeDefined();
    expect(await sync.daily()).toBeUndefined(); // already ran today

    // Paused by hand: the daily update doesn't turn it back on.
    repo.setRuleStatus(id, 'paused', ADMIN);
    now = at('2026-10-07T16:00:00Z');
    const run = (await sync.daily())!;
    expect(run.active).toEqual([]);
    expect(repo.rule(id).status).toBe('paused');
    repo.setRuleStatus(id, 'active', ADMIN);

    // Gone from the next list: it comes out of the app.
    sync.upload(LIST.split('\n').filter((l) => !l.startsWith('ENG-1042')).join('\n'), 'engage-2.csv');
    expect(repo.rule(id).status).toBe('retired');

    // Back on a later list: it returns with the new end date.
    sync.upload(LIST.replace('10/31/2026', '11/15/2026'), 'engage-3.csv');
    const back = repo.rule(id);
    expect(back.status).toBe('active');
    expect(back.schedule!.endsAt).toBe('2026-11-16T05:00:00.000Z');

    // After its last day it is retired by the daily update.
    now = at('2026-11-16T16:00:00Z');
    const last = (await sync.daily())!;
    expect(last.ended).toContain('Marlboro: $1.00 off 2 packs');
    expect(repo.rule(id).status).toBe('retired');
    expect(repo.data.skupos!.runs[0]).toBe(last);
    expect(repo.data.history.some((h) => /Skupos promotions: .*ended/.test(h.what))).toBe(true);
  });

  it('reads the feed every day and keeps the last list when the feed is down', async () => {
    const { repo, live, enroll } = setup();
    enroll(live.id);
    let up = true;
    const feed = skuposFeedFromEnv({ SKUPOS_FEED_URL: 'https://feed.example/promos', SKUPOS_FEED_TOKEN: 'secret' }, (async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
      if (!up) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify([{ id: 'F1', brand: 'Zyn', offer: '$1 off', upc: '000000123456', category: 'tobacco', discount: '$1', end: '2026-10-30' }]), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch)!;
    const sync = new SkuposSync(repo, clock, feed);
    expect((await sync.daily())!.created).toEqual(['Zyn: $1 off']);
    up = false;
    now = at('2026-10-07T16:00:00Z');
    const run = (await sync.daily())!;
    expect(run.error).toMatch(/503/);
    expect(run.active.map((a) => a.name)).toEqual(['Zyn: $1 off']);
    expect(skuposFeedFromEnv({})).toBeUndefined();
  });
});

describe('Skupos in the portal', () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it('saves the enrolled box on a location, takes an upload and shows the log', async () => {
    now = at('2026-10-06T16:00:00Z');
    const repo = new Repo(seedData(now), () => {}, clock);
    const server = createApp(repo, 'packages/console/public', { clock });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: (await res.json()) as any };
    };
    const live = repo.data.stores.find((s) => s.loyaltyLive)!;
    const saved = await call('PUT', `/stores/${live.id}`, { ...live, skuposEnrolled: true, skuposStoreId: '  SK-881 ' });
    expect(saved.data).toMatchObject({ skuposEnrolled: true, skuposStoreId: 'SK-881' });

    const up = await call('POST', '/skupos/upload', { csv: LIST.replace(',VGO #2', ',SK-881'), fileName: 'engage.csv' });
    expect(up.status).toBe(200);
    expect(up.data.run.created).toEqual(['Marlboro: $1.00 off 2 packs', 'Red Bull: 50¢ off any 16 oz']);

    const { data } = await call('GET', '/skupos');
    expect(data.enrolledStores).toEqual([{ id: live.id, name: live.name, live: true, skuposStoreId: 'SK-881' }]);
    expect(data.promos.map((p: any) => p.state)).toEqual(['Live', 'Live', 'Ended']);
    expect(data.runs[0].source).toBe('upload');

    // Taking the store off Skupos pauses its promotions.
    await call('PUT', `/stores/${live.id}`, { ...repo.store(live.id), skuposEnrolled: false });
    expect(repo.data.rules.filter((r) => r.skupos).map((r) => r.status)).toEqual(['paused', 'paused']);
    const bad = await call('POST', '/skupos/upload', { csv: 'hello', fileName: 'x.csv' });
    expect(bad.status).toBe(400);
  });
});
