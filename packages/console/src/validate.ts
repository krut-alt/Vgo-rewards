// Runtime checks for rules arriving from the console or API, so a bad rule never reaches a POS.
import type { Condition, Effect, Scope } from '../../engine/src/index.js';
import type { ConsoleRule } from './model.js';

const isInt = (n: unknown, min = 0): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min;
const isNum = (n: unknown, min = 0): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min;
const isStrings = (a: unknown): a is string[] => Array.isArray(a) && a.every((s) => typeof s === 'string' && s.length > 0);

function scopeProblems(s: Scope | undefined, storeIds: string[], groupIds: string[]): string[] {
  if (!s) return ['Choose where the rule runs.'];
  switch (s.kind) {
    case 'all':
      return [];
    case 'stores':
      if (!isStrings(s.storeIds) || s.storeIds.length === 0) return ['Choose at least one store.'];
      return s.storeIds.filter((id) => !storeIds.includes(id)).map((id) => `Unknown store ${id}.`);
    case 'groups':
      if (!isStrings(s.groupIds) || s.groupIds.length === 0) return ['Choose at least one store group.'];
      return s.groupIds.filter((id) => !groupIds.includes(id)).map((id) => `Unknown store group ${id}.`);
    default:
      return ['Choose where the rule runs.'];
  }
}

function effectProblems(e: Effect | undefined): string[] {
  if (!e) return ['Choose a reward.'];
  const p: string[] = [];
  const items = (x: { skus?: unknown; categories?: unknown }) => {
    if (x.skus !== undefined && !isStrings(x.skus)) p.push('Item list is not valid.');
    if (x.categories !== undefined && !isStrings(x.categories)) p.push('Category list is not valid.');
  };
  switch (e.type) {
    case 'pointsPerDollar':
    case 'pointsPerGallon':
    case 'pointsFlat':
      if (!isInt(e.points, 1)) p.push('Points must be a whole number of at least 1.');
      if (e.type === 'pointsPerDollar') {
        items(e);
        if (e.excludeCategories !== undefined && !isStrings(e.excludeCategories)) p.push('Excluded categories are not valid.');
      }
      if (e.type === 'pointsPerGallon' && e.maxGallons !== undefined && !isNum(e.maxGallons, 1)) p.push('Gallon cap must be at least 1.');
      break;
    case 'fuelDiscount':
      if (!isInt(e.centsPerGallon, 1) || e.centsPerGallon > 200) p.push('Cents per gallon must be between 1 and 200.');
      if (!isNum(e.maxGallons, 1) || e.maxGallons > 100) p.push('Gallon cap must be between 1 and 100.');
      if (e.costPoints !== undefined && !isInt(e.costPoints, 1)) p.push('Points required must be at least 1.');
      break;
    case 'itemDiscount':
      items(e);
      if (!e.skus?.length && !e.categories?.length) p.push('Choose the items the discount applies to.');
      if ((e.centsOff === undefined) === (e.percentOff === undefined)) p.push('Set either an amount off or a percent off.');
      if (e.centsOff !== undefined && !isInt(e.centsOff, 1)) p.push('Amount off must be at least 1¢.');
      if (e.percentOff !== undefined && (!isInt(e.percentOff, 1) || e.percentOff > 100)) p.push('Percent off must be 1 to 100.');
      if (!isInt(e.maxQty, 1)) p.push('Max quantity must be at least 1.');
      if (e.costPoints !== undefined && !isInt(e.costPoints, 1)) p.push('Points required must be at least 1.');
      break;
    case 'basketDiscount':
      if (!isInt(e.centsOff, 1)) p.push('Amount off must be at least 1¢.');
      break;
    case 'punchCard':
      items(e);
      if (!e.skus?.length && !e.categories?.length) p.push('Choose the items that earn punches.');
      if (!isInt(e.every, 1) || e.every > 50) p.push('Punches needed must be between 1 and 50.');
      if (typeof e.cardId !== 'string' || !e.cardId) p.push('Punch card needs an id.');
      break;
    default:
      p.push('Unknown reward type.');
  }
  return p;
}

function conditionProblems(c: Condition): string[] {
  switch (c.type) {
    case 'minInsideSpend':
      return isInt(c.cents, 1) ? [] : ['Minimum spend must be at least 1¢.'];
    case 'hasItem':
      return c.skus?.length || c.categories?.length ? [] : ['Choose the item the member must buy.'];
    case 'minGallons':
      return isNum(c.gallons, 0.1) ? [] : ['Minimum gallons must be more than 0.'];
    case 'fuelGrade':
      return isStrings(c.grades) && c.grades.length ? [] : ['Choose a fuel grade.'];
    case 'memberTag':
      return isStrings(c.tags) && c.tags.length ? [] : ['Choose a member tag.'];
    case 'firstVisit':
      return [];
    default:
      return ['Unknown qualifier.'];
  }
}

/** Problems that make a rule unsavable; empty means it is well formed. */
export function ruleProblems(rule: Partial<ConsoleRule>, storeIds: string[], groupIds: string[]): string[] {
  const p: string[] = [];
  if (typeof rule.name !== 'string' || !rule.name.trim()) p.push('Give the rule a name.');
  if (!['draft', 'active', 'paused', 'retired'].includes(rule.status as string)) p.push('Status is not valid.');
  if (!['earn', 'redeem', 'offer'].includes(rule.section as string)) p.push('Section is not valid.');
  if (!['jobber', 'store', 'split', 'manufacturer'].includes(rule.fundedBy as string)) p.push('Choose who pays.');
  p.push(...scopeProblems(rule.scope, storeIds, groupIds));
  p.push(...effectProblems(rule.effect));
  if (!Array.isArray(rule.conditions)) p.push('Qualifiers are not valid.');
  else rule.conditions.forEach((c) => p.push(...conditionProblems(c)));
  const s = rule.schedule;
  if (s) {
    if (s.startsAt && Number.isNaN(Date.parse(s.startsAt))) p.push('Start date is not valid.');
    if (s.endsAt && Number.isNaN(Date.parse(s.endsAt))) p.push('End date is not valid.');
    if (s.startsAt && s.endsAt && Date.parse(s.endsAt) <= Date.parse(s.startsAt)) p.push('End date must be after the start date.');
    if (s.daysOfWeek && (!Array.isArray(s.daysOfWeek) || !s.daysOfWeek.every((d) => isInt(d) && d <= 6) || !s.daysOfWeek.length))
      p.push('Days of the week are not valid.');
    if (s.hours && (!isInt(s.hours.from) || !isInt(s.hours.to, 1) || s.hours.to > 24 || s.hours.from >= s.hours.to))
      p.push('Hours must run from earlier to later in the same day.');
  }
  const l = rule.perMemberLimit;
  if (l && (!isInt(l.count, 1) || !['day', 'week', 'month', 'lifetime'].includes(l.period))) p.push('Uses per member is not valid.');
  if (rule.requiresClip !== undefined && typeof rule.requiresClip !== 'boolean') p.push('Add-to-card setting is not valid.');
  if (rule.headline !== undefined && (typeof rule.headline !== 'string' || rule.headline.length > 28)) p.push('Keep the promo headline to 28 characters.');
  if (rule.artwork !== undefined && (!rule.artwork || typeof rule.artwork.mediaId !== 'string')) p.push('Artwork is not valid.');
  if (rule.featured !== undefined && typeof rule.featured !== 'boolean') p.push('Featured setting is not valid.');
  const g = rule.geofence;
  if (g !== undefined) {
    if (!g || !isNum(g.radiusMiles) || g.radiusMiles < 0.1 || g.radiusMiles > 25) p.push('Near-store distance must be between 0.1 and 25 miles.');
    if (!rule.requiresClip) p.push('Near-store offers are added to the card in the app, so turn on "Members add it to their card".');
  }
  if (rule.monthlyBudgetCents !== undefined && !isInt(rule.monthlyBudgetCents, 1)) p.push('Budget cap must be at least 1¢.');
  return p;
}
