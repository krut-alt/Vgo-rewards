// Plain-language labels the console and app show for a rule.
import type { Condition, Scope } from '../../engine/src/index.js';
import { categoryLabel, gradeLabel, listLabel } from './catalog.js';
import { dayList, localParts, shortDate } from './dates.js';
import type { ConsoleRule, ConsoleStore, StoreGroup } from './model.js';

export type DisplayStatus = 'Live' | 'Scheduled' | 'Ended' | 'Paused' | 'Draft' | 'Retired';

export function displayStatus(rule: ConsoleRule, now = new Date()): DisplayStatus {
  switch (rule.status) {
    case 'draft':
      return 'Draft';
    case 'paused':
      return 'Paused';
    case 'retired':
      return 'Retired';
    case 'active': {
      const s = rule.schedule;
      if (s?.startsAt && Date.parse(s.startsAt) > now.getTime()) return 'Scheduled';
      if (s?.endsAt && Date.parse(s.endsAt) <= now.getTime()) return 'Ended';
      return 'Live';
    }
  }
}

export function typeLabel(rule: ConsoleRule): string {
  const e = rule.effect;
  const withFuel = rule.conditions.some((c) => c.type === 'minGallons');
  if (rule.fundedBy === 'manufacturer') return 'Brand-funded';
  switch (e.type) {
    case 'fuelDiscount':
      return e.costPoints ? 'Points to fuel' : 'Fuel discount';
    case 'itemDiscount':
      if (e.costPoints) return 'Points to item';
      return withFuel ? 'Item with fuel' : 'Item discount';
    case 'basketDiscount':
      return withFuel ? 'Basket with fuel' : 'Basket discount';
    case 'punchCard':
      return 'Punch card';
    case 'pointsPerDollar':
    case 'pointsPerGallon':
      return rule.section === 'earn' ? 'Earn rate' : 'Bonus points';
    case 'pointsFlat':
      return 'Bonus points';
  }
}

export function fundedLabel(rule: ConsoleRule): string {
  return { jobber: 'Jobber', store: 'Store', split: 'Split 50/50', manufacturer: 'Manufacturer' }[rule.fundedBy];
}

export function targetLabel(scope: Scope, stores: ConsoleStore[], groups: StoreGroup[]): string {
  switch (scope.kind) {
    case 'all':
      return `All ${stores.length} stores`;
    case 'stores': {
      if (scope.storeIds.length === 1) {
        const store = stores.find((s) => s.id === scope.storeIds[0]);
        return `${store?.name ?? scope.storeIds[0]} only`;
      }
      return `${scope.storeIds.length} stores`;
    }
    case 'groups': {
      const names = scope.groupIds.map((id) => groups.find((g) => g.id === id)?.name ?? id);
      return `Group: ${listLabel(names)}`;
    }
  }
}

/** Last store-local day a rule runs, from its exclusive end instant. */
export function lastDay(endsAt: string): string {
  return localParts(new Date(Date.parse(endsAt) - 1)).ymd;
}

export function runsLabel(rule: ConsoleRule): string {
  const s = rule.schedule;
  if (!s) return 'Always on';
  const parts: string[] = [];
  if (s.daysOfWeek?.length) parts.push(dayList(s.daysOfWeek));
  if (s.hours) parts.push(`${hourLabel(s.hours.from)} to ${hourLabel(s.hours.to)}`);
  const from = s.startsAt ? shortDate(localParts(s.startsAt).ymd) : undefined;
  const to = s.endsAt ? shortDate(lastDay(s.endsAt)) : undefined;
  if (from && to) parts.push(`${from} to ${to}`);
  else if (from) parts.push(`From ${from}`);
  else if (to) parts.push(`Until ${to}`);
  return parts.length ? parts.join(', ') : 'Always on';
}

export function hourLabel(h: number): string {
  if (h === 0 || h === 24) return 'midnight';
  if (h === 12) return 'noon';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function cents(c: number): string {
  return c >= 100 ? money(c) : `${c}¢`;
}

function itemsLabel(skus?: string[], categories?: string[]): string {
  const names = [...(categories ?? []).map(categoryLabel), ...(skus ?? [])];
  return names.length ? listLabel(names).toLowerCase() : 'any item';
}

/** One line describing the reward, e.g. "25¢/gal off, up to 20 gal". */
export function rewardLabel(rule: ConsoleRule): string {
  const e = rule.effect;
  switch (e.type) {
    case 'pointsPerDollar': {
      const on = e.categories?.length ? ` on ${itemsLabel(undefined, e.categories)}` : ' spent inside';
      const except = e.excludeCategories?.length ? `, except ${listLabel(e.excludeCategories.map(categoryLabel)).toLowerCase()}` : '';
      return `${e.points} ${e.points === 1 ? 'point' : 'points'} per $1${on}${except}`;
    }
    case 'pointsPerGallon':
      return `${e.points} ${e.points === 1 ? 'point' : 'points'} per gallon${e.maxGallons ? `, up to ${e.maxGallons} gal` : ''}`;
    case 'pointsFlat':
      return `${e.points} bonus points`;
    case 'fuelDiscount': {
      const d = `${e.centsPerGallon}¢/gal off, up to ${e.maxGallons} gal`;
      return e.costPoints ? `${e.costPoints} points = ${d}` : d;
    }
    case 'itemDiscount': {
      const what = itemsLabel(e.skus, e.categories);
      const d =
        e.percentOff === 100
          ? `Free ${what}`
          : e.percentOff !== undefined
            ? `${e.percentOff}% off ${what}`
            : `${cents(e.centsOff ?? 0)} off ${what}`;
      const qty = e.maxQty > 1 ? `, up to ${e.maxQty}` : '';
      return e.costPoints ? `${e.costPoints} points = ${d.charAt(0).toLowerCase()}${d.slice(1)}${qty}` : `${d}${qty}`;
    }
    case 'basketDiscount':
      return `${cents(e.centsOff)} off the purchase`;
    case 'punchCard':
      return `Buy ${e.every} ${itemsLabel(e.skus, e.categories)}, next one free`;
  }
}

export function conditionLabel(c: Condition): string {
  switch (c.type) {
    case 'minInsideSpend':
      return `Spend ${money(c.cents)}+ inside`;
    case 'hasItem':
      return `Buy ${c.minQty && c.minQty > 1 ? `${c.minQty} ` : ''}${itemsLabel(c.skus, c.categories)}`;
    case 'minGallons':
      return `Buy ${c.gallons}+ gallons`;
    case 'fuelGrade':
      return listLabel(c.grades.map(gradeLabel)) + ' fuel';
    case 'memberTag':
      return `Members tagged ${listLabel(c.tags)}`;
    case 'firstVisit':
      return 'First visit';
    case 'birthday':
      return c.window === 'day' ? 'On their birthday' : c.window === 'week' ? 'Birthday week' : 'Birthday month';
  }
}

/** The sentence under the offer name in the app, when the rule has none written. */
export function memberLine(rule: ConsoleRule): string {
  if (rule.memberText) return rule.memberText;
  const conds = rule.conditions.map(conditionLabel);
  const e = rule.effect;
  if (e.type === 'fuelDiscount' && e.costPoints) return `Use ${e.costPoints} points at the pump.`;
  if (e.type === 'itemDiscount' && e.costPoints) return `Use ${e.costPoints} points at the register.`;
  const bday = rule.conditions.find((c) => c.type === 'birthday');
  if (bday) {
    const others = rule.conditions.filter((c) => c !== bday).map(conditionLabel);
    const when = bday.window === 'day' ? 'on your birthday' : bday.window === 'week' ? 'any visit in your birthday week' : 'any visit in your birthday month';
    return `Happy birthday! Use it ${when}${others.length ? ` with ${listLabel(others).toLowerCase()}` : ''}.`;
  }
  return conds.length ? `${listLabel(conds)} in the same visit.` : 'Show your VGO Rewards at checkout.';
}
