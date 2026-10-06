import { describe, expect, it } from 'vitest';
import { ageOn } from '../../engine/src/index.js';
import { MemberApi, parseBirthDate } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';
import { ruleProblems } from '../src/validate.js';
import type { ConsoleRule } from '../src/model.js';

// 2026-10-05, noon at the stores.
const now = new Date('2026-10-05T16:00:00Z');

function setup() {
  const repo = new Repo(seedData(now), () => {}, () => now);
  const texts: string[] = [];
  const api = new MemberApi(repo, (_phone, text) => void texts.push(text), () => now);
  const signUp = async (phone: string, birthDate?: string) => {
    await api.requestCode(phone);
    const code = /^(\d{6})/.exec(texts[texts.length - 1]!)![1]!;
    return api.verify(phone, code, { firstName: 'Jo', homeStoreId: 'vgo-01', ...(birthDate !== undefined ? { birthDate } : {}) });
  };
  return { repo, api, signUp };
}

/** A 21+ beer offer at every store, added to the card in the app. */
const beerOffer = (repo: Repo, conditions: ConsoleRule['conditions'] = [{ type: 'minAge', years: 21 }]) =>
  repo.createRule(
    {
      section: 'offer',
      status: 'active',
      name: '$2 off a 12-pack',
      fundedBy: 'store',
      scope: { kind: 'all' },
      conditions,
      effect: { type: 'itemDiscount', categories: ['beer'], centsOff: 200, maxQty: 1 },
    } as never,
    ADMIN,
  );

describe('ages', () => {
  it('counts whole years, turning a year older on the birthday', () => {
    expect(ageOn('2005-10-05', '2026-10-05')).toBe(21);
    expect(ageOn('2005-10-06', '2026-10-05')).toBe(20);
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17); // leap-day birthdays count from Mar 1
    expect(ageOn('2008-02-29', '2026-03-01')).toBe(18);
  });

  it('reads the date picker and typed dates, and rejects impossible or future ones', () => {
    expect(parseBirthDate('1990-04-15', '2026-10-05')).toBe('1990-04-15');
    expect(parseBirthDate('4/5/1990', '2026-10-05')).toBe('1990-04-05');
    for (const bad of ['1990-02-30', '04/15', '2027-01-01', '1850-01-01', 'soon']) expect(() => parseBirthDate(bad, '2026-10-05'), bad).toThrow(/date of birth/);
  });
});

describe('18+ to join', () => {
  it('needs a date of birth and turns away anyone under 18', async () => {
    const { repo, signUp } = setup();
    await expect(signUp('8035550700')).rejects.toThrow(/date of birth/);
    await expect(signUp('8035550701', '2008-10-06')).rejects.toThrow(/18 or older/); // 18 tomorrow
    expect(repo.data.members.some((m) => m.phone === '8035550701')).toBe(false);
    expect(await signUp('8035550702', '2008-10-05')).toHaveProperty('token'); // 18 today
    expect(repo.data.members.find((m) => m.phone === '8035550702')).toMatchObject({ birthDate: '2008-10-05', birthday: '10-05' });
  });

  it('lets older members add a date of birth once; only the store can change it after', () => {
    const { repo, api } = setup();
    const m = repo.createMember({ name: 'Old Member', phone: '8035550703', homeStoreId: 'vgo-01' }, ADMIN);
    expect(() => api.updateAccount(m, { birthDate: '2010-01-01' })).toThrow(/18 or older/);
    api.updateAccount(m, { birthDate: '1980-06-01' });
    expect(() => api.updateAccount(m, { birthDate: '1970-06-01' })).toThrow(/Ask the store/);
    api.setBirthDate(m, '1981-06-01');
    expect(m).toMatchObject({ birthDate: '1981-06-01', birthday: '06-01' });
  });
});

describe('21+ offers', () => {
  it('requires 21+ on alcohol and tobacco offers', () => {
    const { repo } = setup();
    expect(() => beerOffer(repo, [])).toThrow(/21\+/);
    const tobacco = { ...repo.rule('sandwich-fillup'), conditions: [{ type: 'hasItem', categories: ['tobacco'] }], effect: { type: 'basketDiscount', centsOff: 100 } } as ConsoleRule;
    expect(ruleProblems(tobacco, ['vgo-01'], [])).toContain('Alcohol and tobacco offers must be set to members 21+ only.');
    expect(ruleProblems({ ...tobacco, conditions: [...tobacco.conditions, { type: 'minAge', years: 21 }] }, ['vgo-01'], [])).not.toContain(
      'Alcohol and tobacco offers must be set to members 21+ only.',
    );
  });

  it('shows the offer only to members 21 and over, and the register only applies it for them', () => {
    const { repo, api } = setup();
    const rule = beerOffer(repo);
    const make = (phone: string, birthDate?: string) => Object.assign(repo.createMember({ name: 'M', phone, homeStoreId: 'vgo-01' }, ADMIN), birthDate ? { birthDate } : {});
    const adult = make('8035550710', '1990-01-01');
    const twenty = make('8035550711', '2005-10-06');
    const unknown = make('8035550712');
    const sees = (m: ReturnType<typeof make>) => api.offers(m).offers.some((o) => o.ruleId === rule.id);
    expect([sees(adult), sees(twenty), sees(unknown)]).toEqual([true, false, false]);
    expect(api.offers(adult).offers.find((o) => o.ruleId === rule.id)?.line).toMatch(/21\+ only\. ID checked at the register\./);

    const beer = (id: string) => ({ id, storeId: 'vgo-01', at: now.toISOString(), localHour: 12, localDayOfWeek: 1, localDate: '2026-10-05', items: [{ sku: 'b', category: 'beer', qty: 1, unitCents: 1499 }] });
    expect(repo.preview(beer('t1'), adult.id).appliedRuleIds).toContain(rule.id);
    expect(repo.preview(beer('t2'), twenty.id).appliedRuleIds).not.toContain(rule.id);
  });
});

describe('age checks over the app API', () => {
  it('passes the date of birth through sign-up and lets the store fix it', async () => {
    const { createApp } = await import('../src/server.js');
    const repo = new Repo(seedData(now), () => {}, () => now);
    const api = new MemberApi(repo, () => {}, () => now, true);
    const server = createApp(repo, 'packages/console/public', { clock: () => now, memberApi: api }).listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const post = async (path: string, body: unknown, method = 'POST') => (await fetch(base + path, { method, body: JSON.stringify(body) })).json() as Promise<any>;
    try {
      const { devCode } = await post('/api/app/code', { phone: '8035550720' });
      expect((await post('/api/app/verify', { phone: '8035550720', code: devCode, firstName: 'Kid', birthDate: '2010-01-01' })).error).toMatch(/18 or older/);
      expect(await post('/api/app/verify', { phone: '8035550720', code: devCode, firstName: 'Ana', birthDate: '1999-09-09' })).toHaveProperty('token');
      const m = repo.data.members.find((x) => x.phone === '8035550720')!;
      expect(m.birthDate).toBe('1999-09-09');
      expect(await post(`/api/members/${m.id}/birth-date`, { birthDate: '1999-09-19' }, 'PUT')).toMatchObject({ birthDate: '1999-09-19' });
    } finally {
      server.close();
    }
  });
});
