import { describe, expect, it } from 'vitest';
import { MemberApi } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { seedData } from '../src/seed.js';

const now = new Date('2026-10-05T16:00:00Z');

function setup() {
  const repo = new Repo(seedData(now), () => {}, () => now);
  const texts: string[] = [];
  const api = new MemberApi(repo, (_phone, text) => void texts.push(text), () => now);
  const codeFrom = () => /^(\d{6})/.exec(texts[texts.length - 1]!)![1]!;
  return { repo, api, texts, codeFrom };
}

async function join(api: MemberApi, codeFrom: () => string, phone = '8035550199') {
  await api.requestCode(phone);
  const res = api.verify(phone, codeFrom(), { firstName: 'Jordan', smsOptIn: true, homeStoreId: 'vgo-01' });
  if (!('token' in res)) throw new Error('expected a token');
  return api.memberFor(`Bearer ${res.token}`);
}

describe('member sign-in', () => {
  it('texts a code and joins a new member with it', async () => {
    const { api, texts, codeFrom } = setup();
    const m = await join(api, codeFrom);
    expect(texts[0]).toMatch(/^\d{6} is your VGO Rewards code/);
    expect(m).toMatchObject({ name: 'Jordan', phone: '8035550199', smsOptIn: true, homeStoreId: 'vgo-01' });
  });

  it('asks a new number for a name instead of creating a blank member', async () => {
    const { api, codeFrom } = setup();
    await api.requestCode('(803) 555-0100');
    expect(api.verify('8035550100', codeFrom())).toEqual({ needsSignup: true });
  });

  it('rejects wrong codes and locks after five tries', async () => {
    const { api, codeFrom } = setup();
    await api.requestCode('8035550101');
    const right = codeFrom();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(() => api.verify('8035550101', wrong)).toThrow(/does not match/);
    expect(() => api.verify('8035550101', right)).toThrow(/Too many tries/);
  });

  it('limits how many codes one number can request', async () => {
    const { api } = setup();
    for (let i = 0; i < 5; i++) await api.requestCode('8035550102');
    await expect(api.requestCode('8035550102')).rejects.toThrow(/Too many codes/);
  });

  it('refuses unknown or signed-out tokens', async () => {
    const { api, codeFrom } = setup();
    await api.requestCode('8035550103');
    const res = api.verify('8035550103', codeFrom(), { firstName: 'Sam' }) as { token: string };
    expect(() => api.memberFor('Bearer nope')).toThrow(/sign in/);
    api.signOut(`Bearer ${res.token}`);
    expect(() => api.memberFor(`Bearer ${res.token}`)).toThrow(/sign in/);
  });
});

describe('member home and offers', () => {
  it('shows the welcome reward, punch card and next points reward', async () => {
    const { api, codeFrom } = setup();
    const home = api.home(await join(api, codeFrom));
    expect(home.freeFuel[0]).toMatchObject({ ruleId: 'welcome', title: '25¢ off per gallon' });
    expect(home.nextReward).toEqual({ title: '10¢ off per gallon', costPoints: 100, pointsNeeded: 100 });
    expect(home.earnSummary).toBe('1 point per $1 inside · 1 point per gallon');
    expect(home.punchCards[0]).toMatchObject({ count: 0, every: 5 });
    expect(home.offers.map((o) => o.ruleId)).not.toContain('welcome');
  });

  it('applies an add-to-card offer only after the member adds it', async () => {
    const { repo, api, codeFrom } = setup();
    const m = await join(api, codeFrom);
    const tx = {
      id: 't-clip',
      storeId: 'vgo-01',
      at: now.toISOString(),
      localHour: 12,
      localDayOfWeek: 1,
      items: [{ sku: 's', category: 'sandwiches', qty: 1, unitCents: 599 }],
      fuel: { grade: 'regular', gallons: 10, pricePerGallonCents: 309 },
    };
    expect(repo.preview(tx, m.id).appliedRuleIds).not.toContain('sandwich-fillup');
    api.setClip(m, 'sandwich-fillup', true);
    expect(api.offers(m).offers.find((o) => o.ruleId === 'sandwich-fillup')).toMatchObject({ how: 'clip', clipped: true });
    expect(repo.preview(tx, m.id).appliedRuleIds).toContain('sandwich-fillup');
  });

  it('uses a points reward picked in the app on the next visit, then clears it', async () => {
    const { repo, api, codeFrom } = setup();
    const m = await join(api, codeFrom);
    m.visitCount = 3; // past the welcome reward
    m.pointsBalance = 150;
    expect(() => api.setRedeem(m, ['redeem-fuel', 'redeem-fountain'])).toThrow(/needs 400 points/);
    api.setRedeem(m, ['redeem-fuel']);
    const tx = { id: 't-redeem', storeId: 'vgo-01', at: now.toISOString(), localHour: 12, localDayOfWeek: 1, items: [], fuel: { grade: 'regular', gallons: 12, pricePerGallonCents: 309 } };
    const res = repo.recordTransaction(tx, m.id);
    expect(res.pointsSpent).toBe(100);
    expect(res.discounts[0]).toMatchObject({ centsPerGallon: 10, centsOff: 120 });
    expect(m.nextVisitRedeem).toEqual([]);
    expect(m.pointsBalance).toBe(150 - 100 + 12);
  });
});
