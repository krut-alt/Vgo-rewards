import { describe, expect, it } from 'vitest';
import { MemberApi } from '../src/member-api.js';
import { Repo } from '../src/repo.js';
import { ADMIN, seedData } from '../src/seed.js';
// The app's page builder is plain browser JS with no DOM use until rendering.
// @ts-expect-error untyped browser module
import { privacySections, termsSections } from '../../app/public/legal.js';

const now = new Date('2026-10-06T16:00:00Z');
const setup = () => {
  const repo = new Repo(seedData(now), () => {}, () => now);
  return { repo, api: new MemberApi(repo, () => {}, () => now) };
};
const text = (sections: unknown[]) => JSON.stringify(sections);

describe('program terms and privacy', () => {
  it('states the live program: earn rates, rewards, expiry, age and states', () => {
    const { api } = setup();
    const p = api.programFacts();
    expect(p).toMatchObject({ company: 'VGO', minAge: 18, pointsExpireMonths: 12, oneFuelDiscount: true, states: ['GA', 'NC', 'SC'], liveStores: ['VGO 01'] });
    expect(p.earn).toEqual(['1 point per $1 spent inside, except tobacco, alcohol, lottery and gift cards', '1 point per gallon']);
    expect(p.redeem.some((r: string) => /10¢\/gal off/.test(r))).toBe(true);
    const terms = text(termsSections(p));
    expect(terms).toMatch(/at least 18 years old/);
    expect(terms).toMatch(/no qualifying purchase for 12 months/);
    expect(terms).toMatch(/Reply STOP to cancel or HELP for help/);
    expect(terms).toMatch(/laws of the State of South Carolina/);
    expect(terms).toMatch(/Georgia, North Carolina and South Carolina/);
    expect(text(privacySections(p))).toMatch(/do not sell your personal information/);
  });

  it('follows the settings when they change', () => {
    const { repo, api } = setup();
    repo.updateSettings({ pointsExpireMonths: 0, legal: { companyName: ' Acme Fuels LLC ', email: 'rewards@acme.com', governingState: 'nc' } }, ADMIN);
    const p = api.programFacts();
    expect(p).toMatchObject({ company: 'Acme Fuels LLC', email: 'rewards@acme.com', governingState: 'NC' });
    expect(text(termsSections(p))).toMatch(/Points do not expire/);
    expect(text(termsSections(p))).toMatch(/rewards@acme.com/);
    expect(() => repo.updateSettings({ legal: { email: 'nope' } }, ADMIN)).toThrow(/contact email/);
    expect(() => repo.updateSettings({ legal: { governingState: 'Carolina' } }, ADMIN)).toThrow(/two-letter/);
  });
});
