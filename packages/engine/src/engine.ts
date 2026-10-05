import type {
  AppliedDiscount,
  Condition,
  Effect,
  EvaluationResult,
  LineItem,
  Member,
  Rule,
  Scope,
  Store,
  Transaction,
  UsageLookup,
} from './types.js';

export function inScope(scope: Scope, store: Store): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'stores':
      return scope.storeIds.includes(store.id);
    case 'groups':
      return scope.groupIds.some((g) => store.groupIds.includes(g));
  }
}

export function inSchedule(rule: Rule, tx: Transaction): boolean {
  const s = rule.schedule;
  if (!s) return true;
  const at = Date.parse(tx.at);
  if (s.startsAt && at < Date.parse(s.startsAt)) return false;
  if (s.endsAt && at >= Date.parse(s.endsAt)) return false;
  if (s.daysOfWeek && !s.daysOfWeek.includes(tx.localDayOfWeek)) return false;
  if (s.hours && (tx.localHour < s.hours.from || tx.localHour >= s.hours.to)) return false;
  return true;
}

function matches(item: LineItem, skus?: string[], categories?: string[]): boolean {
  if (!skus && !categories) return true;
  return (skus?.includes(item.sku) ?? false) || (categories?.includes(item.category) ?? false);
}

function insideSpend(tx: Transaction, exclude: string[] = []): number {
  return tx.items
    .filter((i) => !exclude.includes(i.category))
    .reduce((sum, i) => sum + i.qty * i.unitCents, 0);
}

export function conditionPasses(c: Condition, tx: Transaction, member: Member): boolean {
  switch (c.type) {
    case 'minInsideSpend':
      return insideSpend(tx, c.excludeCategories) >= c.cents;
    case 'hasItem': {
      const qty = tx.items.filter((i) => matches(i, c.skus, c.categories)).reduce((n, i) => n + i.qty, 0);
      return qty >= (c.minQty ?? 1);
    }
    case 'minGallons':
      return (tx.fuel?.gallons ?? 0) >= c.gallons;
    case 'fuelGrade':
      return tx.fuel !== undefined && c.grades.includes(tx.fuel.grade);
    case 'memberTag':
      return c.tags.some((t) => member.tags.includes(t));
    case 'firstVisit':
      return member.visitCount === 0;
  }
}

function underLimit(rule: Rule, usage: UsageLookup): boolean {
  if (!rule.perMemberLimit) return true;
  return usage(rule.id, rule.perMemberLimit.period) < rule.perMemberLimit.count;
}

/** Rules that can apply to this transaction, before stacking and point checks. */
export function eligibleRules(
  rules: Rule[],
  store: Store,
  tx: Transaction,
  member: Member,
  usage: UsageLookup,
): Rule[] {
  return rules.filter(
    (r) =>
      r.status === 'active' &&
      inScope(r.scope, store) &&
      inSchedule(r, tx) &&
      r.conditions.every((c) => conditionPasses(c, tx, member)) &&
      underLimit(r, usage),
  );
}

function stackingGroupOf(rule: Rule): string {
  if (rule.stackingGroup) return rule.stackingGroup;
  return rule.effect.type === 'fuelDiscount' ? 'fuel' : `rule:${rule.id}`;
}

function unitsOf(tx: Transaction, skus?: string[], categories?: string[]): number[] {
  return tx.items
    .filter((i) => matches(i, skus, categories))
    .flatMap((i) => Array<number>(i.qty).fill(i.unitCents));
}

interface Outcome {
  rule: Rule;
  /** Estimated customer value in cents, used to pick the best rule in a stacking group. */
  value: number;
  points: number;
  pointsCost: number;
  discount?: AppliedDiscount;
  punch?: { cardId: string; count: number };
}

function outcomeOf(rule: Rule, tx: Transaction, member: Member): Outcome {
  const e: Effect = rule.effect;
  const base = { rule, value: 0, points: 0, pointsCost: 0 };
  switch (e.type) {
    case 'pointsPerDollar': {
      const spend = tx.items
        .filter((i) => (e.categories ? e.categories.includes(i.category) : true))
        .filter((i) => !(e.excludeCategories ?? []).includes(i.category))
        .reduce((s, i) => s + i.qty * i.unitCents, 0);
      const points = Math.floor(spend / 100) * e.points;
      return { ...base, points, value: points };
    }
    case 'pointsPerGallon': {
      const gallons = Math.min(tx.fuel?.gallons ?? 0, e.maxGallons ?? Infinity);
      const points = Math.floor(gallons * e.points);
      return { ...base, points, value: points };
    }
    case 'pointsFlat':
      return { ...base, points: e.points, value: e.points };
    case 'fuelDiscount': {
      // Before fueling, gallons are unknown: value the discount at its cap.
      const gallons = Math.min(tx.fuel?.gallons ?? e.maxGallons, e.maxGallons);
      const centsOff = Math.round(gallons * e.centsPerGallon);
      return {
        ...base,
        value: centsOff,
        pointsCost: e.costPoints ?? 0,
        discount: {
          ruleId: rule.id,
          kind: 'fuel',
          centsOff: tx.fuel ? centsOff : 0,
          centsPerGallon: e.centsPerGallon,
          maxGallons: e.maxGallons,
          pointsSpent: e.costPoints,
          fundedBy: rule.fundedBy,
        },
      };
    }
    case 'itemDiscount': {
      const units = unitsOf(tx, e.skus, e.categories)
        .sort((a, b) => b - a)
        .slice(0, e.maxQty);
      const centsOff = units.reduce((s, unit) => {
        const off = e.percentOff !== undefined ? Math.round((unit * e.percentOff) / 100) : (e.centsOff ?? 0);
        return s + Math.min(off, unit);
      }, 0);
      return {
        ...base,
        value: centsOff,
        discount: { ruleId: rule.id, kind: 'item', centsOff, fundedBy: rule.fundedBy },
      };
    }
    case 'basketDiscount': {
      const centsOff = Math.min(e.centsOff, insideSpend(tx));
      return {
        ...base,
        value: centsOff,
        discount: { ruleId: rule.id, kind: 'basket', centsOff, fundedBy: rule.fundedBy },
      };
    }
    case 'punchCard': {
      // Each matching unit adds a punch; once a card holds `every` punches,
      // the next matching unit is free and the card resets. Cheapest units go free first.
      let count = member.punches[e.cardId] ?? 0;
      let centsOff = 0;
      for (const unit of unitsOf(tx, e.skus, e.categories).sort((a, b) => a - b)) {
        if (count >= e.every) {
          centsOff += unit;
          count = 0;
        } else {
          count += 1;
        }
      }
      return {
        ...base,
        value: centsOff,
        punch: { cardId: e.cardId, count },
        discount: centsOff > 0 ? { ruleId: rule.id, kind: 'punch', centsOff, fundedBy: rule.fundedBy } : undefined,
      };
    }
  }
}

/**
 * Evaluate one transaction for one member at one store.
 * Pure function: callers persist points, punches and usage from the result.
 */
export function evaluate(
  rules: Rule[],
  store: Store,
  tx: Transaction,
  member: Member,
  usage: UsageLookup = () => 0,
): EvaluationResult {
  // Rules the member cannot afford with points are dropped before stacking,
  // so they never crowd out a rule the member can use.
  const outcomes = eligibleRules(rules, store, tx, member, usage)
    .map((r) => outcomeOf(r, tx, member))
    .filter((o) => o.pointsCost <= member.pointsBalance);

  // Best outcome per stacking group: highest value, then fewest points spent, then priority.
  const better = (a: Outcome, b: Outcome): boolean =>
    a.value !== b.value
      ? a.value > b.value
      : a.pointsCost !== b.pointsCost
        ? a.pointsCost < b.pointsCost
        : (a.rule.priority ?? 0) > (b.rule.priority ?? 0);
  const best = new Map<string, Outcome>();
  for (const o of outcomes) {
    const group = stackingGroupOf(o.rule);
    const current = best.get(group);
    if (!current || better(o, current)) best.set(group, o);
  }

  const result: EvaluationResult = {
    pointsEarned: 0,
    pointsSpent: 0,
    discounts: [],
    punches: {},
    appliedRuleIds: [],
  };
  let balance = member.pointsBalance;
  for (const o of best.values()) {
    if (o.pointsCost > balance) continue;
    balance -= o.pointsCost;
    result.pointsSpent += o.pointsCost;
    result.pointsEarned += o.points;
    if (o.discount) result.discounts.push(o.discount);
    if (o.punch) result.punches[o.punch.cardId] = o.punch.count;
    result.appliedRuleIds.push(o.rule.id);
  }
  return result;
}
