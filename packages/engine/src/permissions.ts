import type { Role, Rule } from './types.js';

/** Limits the jobber sets on what store managers may create. Editable in the console. */
export interface StorePolicy {
  maxStoreDiscountCents: number;
  storeManagersCanCreate: boolean;
}

export interface Actor {
  role: Role;
  userId: string;
  storeId?: string;
  /** Store groups a jobber marketer is assigned to. */
  groupIds?: string[];
  storeIds?: string[];
}

/** Returns the reasons a rule may not be saved by this actor; empty means allowed. */
export function ruleViolations(rule: Rule, actor: Actor, policy: StorePolicy): string[] {
  const problems: string[] = [];
  const e = rule.effect;

  if (actor.role === 'jobber-admin') return problems;

  if (actor.role === 'jobber-marketer') {
    const s = rule.scope;
    if (s.kind === 'all') problems.push('Only a jobber admin can target all stores.');
    if (s.kind === 'groups' && !s.groupIds.every((g) => actor.groupIds?.includes(g)))
      problems.push('Target includes a store group you are not assigned to.');
    if (s.kind === 'stores' && !s.storeIds.every((id) => actor.storeIds?.includes(id)))
      problems.push('Target includes a store you are not assigned to.');
    return problems;
  }

  // store-manager
  if (!policy.storeManagersCanCreate) problems.push('Store managers cannot create offers right now.');
  if (rule.scope.kind !== 'stores' || rule.scope.storeIds.length !== 1 || rule.scope.storeIds[0] !== actor.storeId)
    problems.push('Store managers can only target their own store.');
  if (e.type === 'fuelDiscount') problems.push('Fuel discounts are set by the jobber.');
  if (e.type.startsWith('points')) problems.push('Earn rules are set by the jobber.');
  if (e.type === 'itemDiscount' && (e.centsOff ?? 0) > policy.maxStoreDiscountCents)
    problems.push(`Discount is above the store limit of ${policy.maxStoreDiscountCents} cents.`);
  if (e.type === 'basketDiscount' && e.centsOff > policy.maxStoreDiscountCents)
    problems.push(`Discount is above the store limit of ${policy.maxStoreDiscountCents} cents.`);
  if (rule.fundedBy !== 'store') problems.push('Store-created offers must be store-funded.');
  return problems;
}
