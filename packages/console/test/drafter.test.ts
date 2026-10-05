import { describe, expect, it } from 'vitest';
import { draftRule } from '../src/drafter.js';
import { seedData } from '../src/seed.js';

const now = new Date('2026-10-05T16:00:00Z');
const data = seedData(now);
const ctx = { stores: data.stores, groups: data.groups, now };

function draft(text: string) {
  const d = draftRule(text, ctx);
  if (!d.ok) throw new Error(d.error);
  return d;
}

describe('rule drafter', () => {
  it('drafts the example from the design as a paused rule', () => {
    const d = draft('Earn 2x points on premium fuel on weekends at SC stores until Dec 31');
    expect(d.rule).toMatchObject({
      status: 'paused',
      section: 'earn',
      scope: { kind: 'groups', groupIds: ['sc'] },
      effect: { type: 'pointsPerGallon', points: 2 },
      conditions: [{ type: 'fuelGrade', grades: ['premium'] }],
      schedule: { daysOfWeek: [0, 6] },
      stackingGroup: 'earn-gallon',
    });
    expect(d.rule.schedule?.endsAt).toBe('2027-01-01T05:00:00.000Z');
    expect(d.chips).toEqual(['Earn 2x points', 'Premium fuel', 'Sat and Sun', 'Ends Dec 31', 'Group: SC stores']);
  });

  it('drafts a fuel discount on a day at the pilot store', () => {
    const d = draft('10 cents off per gallon on Tuesdays at the pilot store');
    expect(d.rule).toMatchObject({
      section: 'offer',
      scope: { kind: 'groups', groupIds: ['pilot'] },
      effect: { type: 'fuelDiscount', centsPerGallon: 10, maxGallons: 20 },
      schedule: { daysOfWeek: [2] },
    });
    expect(d.notes.join(' ')).toContain('capped at 20 gallons');
  });

  it('drafts an item discount with a fill-up at one store', () => {
    const d = draft('$1 off any sandwich with a fill-up at VGO 01, once a day');
    expect(d.rule).toMatchObject({
      scope: { kind: 'stores', storeIds: ['vgo-01'] },
      effect: { type: 'itemDiscount', categories: ['sandwiches'], centsOff: 100, maxQty: 1 },
      perMemberLimit: { count: 1, period: 'day' },
    });
    expect(d.rule.conditions).toContainEqual({ type: 'minGallons', gallons: 8 });
  });

  it('drafts a punch card', () => {
    const d = draft('Buy 5 coffees, get the 6th free at store 1');
    expect(d.rule.name).toBe('Buy 5 coffee, 6th free');
    expect(d.rule.effect).toMatchObject({ type: 'punchCard', categories: ['coffee'], every: 5 });
  });

  it('drafts points redemptions', () => {
    expect(draft('200 points for a free fountain drink').rule).toMatchObject({
      section: 'redeem',
      effect: { type: 'itemDiscount', categories: ['fountain'], percentOff: 100, costPoints: 200 },
    });
    expect(draft('100 points = 15 cents a gallon up to 25 gallons in Georgia').rule).toMatchObject({
      section: 'redeem',
      scope: { kind: 'groups', groupIds: ['ga'] },
      effect: { type: 'fuelDiscount', centsPerGallon: 15, maxGallons: 25, costPoints: 100 },
    });
  });

  it('drafts hours, spend thresholds and funding', () => {
    const d = draft('Free coffee when you spend $10 between 6am and 10am, store funded, at VGO 03');
    expect(d.rule).toMatchObject({
      fundedBy: 'store',
      effect: { type: 'itemDiscount', categories: ['coffee'], percentOff: 100 },
      schedule: { hours: { from: 6, to: 10 } },
    });
    expect(d.rule.conditions).toContainEqual(expect.objectContaining({ type: 'minInsideSpend', cents: 1000 }));
  });

  it('says what it could not read instead of guessing', () => {
    expect(draftRule('make customers happy', ctx)).toMatchObject({ ok: false });
    expect(draft('5 cents off per gallon').notes.join(' ')).toContain('targets all stores');
  });
});
