import { describe, expect, it } from 'vitest';
import { inBirthdayWindow } from '../../engine/src/index.js';
import { MemberApi } from '../src/member-api.js';
import { migrate } from '../src/migrate.js';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';

describe('birthday window', () => {
  it('covers the day, the 7 days from it, or the month', () => {
    expect(inBirthdayWindow('03-07', '2027-03-07', 'day')).toBe(true);
    expect(inBirthdayWindow('03-07', '2027-03-08', 'day')).toBe(false);
    expect(inBirthdayWindow('03-07', '2027-03-13', 'week')).toBe(true);
    expect(inBirthdayWindow('03-07', '2027-03-14', 'week')).toBe(false);
    expect(inBirthdayWindow('03-07', '2027-03-06', 'week')).toBe(false);
    expect(inBirthdayWindow('03-07', '2027-03-31', 'month')).toBe(true);
    expect(inBirthdayWindow('12-29', '2027-01-03', 'week')).toBe(true); // runs into the new year
    expect(inBirthdayWindow('02-29', '2027-02-28', 'day')).toBe(true); // not a leap year
  });
});

describe('birthday reward', () => {
  const now = new Date('2026-10-05T16:00:00Z');
  const setup = () => {
    const repo = new Repo(seedData(now), () => {}, () => now);
    const api = new MemberApi(repo, () => {}, () => now);
    const m = repo.createMember({ name: 'Bea', phone: '8035550601', homeStoreId: 'vgo-01' }, ADMIN);
    return { repo, api, m };
  };
  const coffee = (id: string) => ({ id, storeId: 'vgo-01', at: '2026-10-05T15:00:00Z', localHour: 11, localDayOfWeek: 1, localDate: '2026-10-05', items: [{ sku: 'c', category: 'coffee', qty: 1, unitCents: 199 }] });

  it('nudges for a birthday, then shows when it unlocks, then is ready in the window', () => {
    const { api, m } = setup();
    expect(api.home(m).birthday).toMatchObject({ state: 'add-birthday' });
    api.updateAccount(m, { birthDate: '1990-12-01' });
    expect(api.home(m).birthday).toMatchObject({ state: 'coming', on: 'the week of Dec 1' });
    api.setBirthDate(m, '1990-10-02');
    const ready = api.home(m).birthday as { state: string; offer: { ruleId: string; line: string } };
    expect(ready.state).toBe('ready');
    expect(ready.offer.line).toBe('Happy birthday! Use it any visit in your birthday week.');
  });

  it('gives a free coffee once a year in the birthday week', () => {
    const { repo, m } = setup();
    m.birthday = '10-02';
    const first = repo.recordTransaction(coffee('b1'), m.id);
    expect(first.appliedRuleIds).toContain('birthday-treat');
    expect(first.discounts.find((d) => d.ruleId === 'birthday-treat')).toMatchObject({ centsOff: 199 });
    expect(repo.recordTransaction(coffee('b2'), m.id).appliedRuleIds).not.toContain('birthday-treat');
    m.birthday = '06-01';
    const other = repo.createMember({ name: 'Cy', phone: '8035550602', homeStoreId: 'vgo-01' }, ADMIN);
    other.birthday = '06-01';
    expect(repo.recordTransaction(coffee('b3'), other.id).appliedRuleIds).not.toContain('birthday-treat');
  });

  it('is added once to data saved before it existed, and stays editable', () => {
    const old = seedData(new Date());
    old.rules = old.rules.filter((r) => r.id !== 'birthday-treat');
    old.migrations = (old.migrations ?? []).filter((x) => x !== '2026-10-birthday-treat');
    expect(migrate(old)).toBe(true);
    const rule = old.rules.find((r) => r.id === 'birthday-treat')!;
    rule.status = 'paused';
    expect(migrate(old)).toBe(false);
    expect(old.rules.filter((r) => r.id === 'birthday-treat')).toHaveLength(1);
    expect(rule.status).toBe('paused');
  });
});
