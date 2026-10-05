import { describe, expect, it } from 'vitest';
import { evaluate, ruleViolations, type Member, type Rule, type Store, type Transaction } from '../src/index.js';

const pilot: Store = { id: 'vgo-01', name: 'VGO 01', groupIds: ['pilot', 'sc'], pos: 'verifone-commander', loyaltyLive: true };
const other: Store = { id: 'vgo-02', name: 'VGO 02', groupIds: ['nc'], pos: 'gilbarco-passport', loyaltyLive: false };

const admin = { role: 'jobber-admin' as const, userId: 'krut' };

function rule(partial: Partial<Rule> & Pick<Rule, 'id' | 'effect'>): Rule {
  return {
    name: partial.id,
    status: 'active',
    scope: { kind: 'all' },
    conditions: [],
    fundedBy: 'jobber',
    createdBy: admin,
    ...partial,
  };
}

function member(partial: Partial<Member> = {}): Member {
  return { id: 'm1', tags: [], pointsBalance: 0, visitCount: 3, punches: {}, ...partial };
}

function tx(partial: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1',
    storeId: 'vgo-01',
    at: '2026-11-02T15:00:00Z',
    localHour: 10,
    localDayOfWeek: 1,
    items: [],
    ...partial,
  };
}

describe('scope', () => {
  const offer = rule({ id: 'sandwich', scope: { kind: 'stores', storeIds: ['vgo-01'] }, effect: { type: 'basketDiscount', centsOff: 100 } });
  const items = [{ sku: 's1', category: 'food', qty: 1, unitCents: 599 }];

  it('applies a store-specific offer only at that store', () => {
    expect(evaluate([offer], pilot, tx({ items }), member()).discounts).toHaveLength(1);
    expect(evaluate([offer], other, tx({ items, storeId: 'vgo-02' }), member()).discounts).toHaveLength(0);
  });

  it('targets store groups', () => {
    const groupOffer = { ...offer, scope: { kind: 'groups' as const, groupIds: ['nc'] } };
    expect(evaluate([groupOffer], pilot, tx({ items }), member()).discounts).toHaveLength(0);
    expect(evaluate([groupOffer], other, tx({ items }), member()).discounts).toHaveLength(1);
  });

  it('ignores paused, draft and retired rules', () => {
    for (const status of ['paused', 'draft', 'retired'] as const) {
      expect(evaluate([{ ...offer, status }], pilot, tx({ items }), member()).discounts).toHaveLength(0);
    }
  });
});

describe('earning', () => {
  it('earns points per dollar, excluding categories', () => {
    const r = rule({ id: 'earn', effect: { type: 'pointsPerDollar', points: 1, excludeCategories: ['tobacco'] } });
    const items = [
      { sku: 'c', category: 'coffee', qty: 2, unitCents: 249 },
      { sku: 't', category: 'tobacco', qty: 1, unitCents: 899 },
    ];
    expect(evaluate([r], pilot, tx({ items }), member()).pointsEarned).toBe(4);
  });

  it('earns points per gallon', () => {
    const r = rule({ id: 'gal', effect: { type: 'pointsPerGallon', points: 1 } });
    const fuel = { grade: 'regular', gallons: 12.4, pricePerGallonCents: 309 };
    expect(evaluate([r], pilot, tx({ fuel }), member()).pointsEarned).toBe(12);
  });
});

describe('fuel discounts', () => {
  const welcome = rule({
    id: 'welcome',
    conditions: [{ type: 'firstVisit' }],
    effect: { type: 'fuelDiscount', centsPerGallon: 25, maxGallons: 20 },
  });
  const redeem = rule({ id: 'redeem', effect: { type: 'fuelDiscount', centsPerGallon: 10, maxGallons: 20, costPoints: 100 } });
  const fuel = { grade: 'regular', gallons: 15, pricePerGallonCents: 309 };

  it('gives the welcome discount on the first visit', () => {
    const res = evaluate([welcome], pilot, tx({ fuel }), member({ visitCount: 0 }));
    expect(res.discounts[0]).toMatchObject({ kind: 'fuel', centsPerGallon: 25, centsOff: 375 });
  });

  it('applies only the best fuel discount', () => {
    const res = evaluate([welcome, redeem], pilot, tx({ fuel }), member({ visitCount: 0, pointsBalance: 500 }));
    expect(res.appliedRuleIds).toEqual(['welcome']);
    expect(res.pointsSpent).toBe(0);
  });

  it('spends points only when the member has enough', () => {
    expect(evaluate([redeem], pilot, tx({ fuel }), member({ pointsBalance: 99 })).discounts).toHaveLength(0);
    const res = evaluate([redeem], pilot, tx({ fuel }), member({ pointsBalance: 150 }));
    expect(res.pointsSpent).toBe(100);
    expect(res.discounts[0]?.centsOff).toBe(150);
  });

  it('authorizes a pump discount before gallons are known', () => {
    const res = evaluate([redeem], pilot, tx(), member({ pointsBalance: 150 }));
    expect(res.discounts[0]).toMatchObject({ centsPerGallon: 10, maxGallons: 20, centsOff: 0 });
  });
});

describe('limits and schedules', () => {
  const r = rule({
    id: 'happy-hour',
    perMemberLimit: { count: 1, period: 'day' },
    schedule: { hours: { from: 14, to: 17 } },
    effect: { type: 'basketDiscount', centsOff: 50 },
  });
  const items = [{ sku: 'x', category: 'snacks', qty: 1, unitCents: 199 }];

  it('respects the time window', () => {
    expect(evaluate([r], pilot, tx({ items, localHour: 10 }), member()).discounts).toHaveLength(0);
    expect(evaluate([r], pilot, tx({ items, localHour: 15 }), member()).discounts).toHaveLength(1);
  });

  it('respects per-member limits', () => {
    expect(evaluate([r], pilot, tx({ items, localHour: 15 }), member(), () => 1).discounts).toHaveLength(0);
  });
});

describe('punch cards', () => {
  const card = rule({ id: 'coffee-card', effect: { type: 'punchCard', cardId: 'coffee', categories: ['coffee'], every: 5 } });

  it('gives the 6th coffee free and resets the card', () => {
    const items = [{ sku: 'c', category: 'coffee', qty: 2, unitCents: 199 }];
    const res = evaluate([card], pilot, tx({ items }), member({ punches: { coffee: 4 } }));
    expect(res.discounts[0]?.centsOff).toBe(199);
    expect(res.punches.coffee).toBe(0);
  });
});

describe('permissions', () => {
  const policy = { maxStoreDiscountCents: 200, storeManagersCanCreate: true };
  const manager = { role: 'store-manager' as const, userId: 'mgr', storeId: 'vgo-01' };
  const ownStore = { kind: 'stores' as const, storeIds: ['vgo-01'] };

  it('lets a store manager create a small store-funded offer for their store', () => {
    const r = rule({ id: 'x', scope: ownStore, fundedBy: 'store', effect: { type: 'basketDiscount', centsOff: 100 } });
    expect(ruleViolations(r, manager, policy)).toEqual([]);
  });

  it('blocks store managers from fuel discounts, other stores and big discounts', () => {
    const r = rule({ id: 'x', scope: { kind: 'all' }, effect: { type: 'fuelDiscount', centsPerGallon: 10, maxGallons: 20 } });
    expect(ruleViolations(r, manager, policy).length).toBeGreaterThanOrEqual(3);
  });

  it('lets the jobber admin do anything', () => {
    const r = rule({ id: 'x', effect: { type: 'fuelDiscount', centsPerGallon: 50, maxGallons: 20 } });
    expect(ruleViolations(r, admin, policy)).toEqual([]);
  });
});
