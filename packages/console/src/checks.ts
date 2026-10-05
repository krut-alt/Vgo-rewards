// The "Checks" panel on the create-offer screen: what will happen if this rule goes live.
import type { Actor } from '../../engine/src/index.js';
import { inScope } from '../../engine/src/index.js';
import { categoryLabel, listLabel } from './catalog.js';
import { money } from './labels.js';
import type { ConsoleRule } from './model.js';
import type { Repo } from './repo.js';

export interface Check {
  ok: boolean;
  text: string;
}

export function ruleChecks(repo: Repo, rule: ConsoleRule, actor: Actor): { blockers: string[]; checks: Check[] } {
  const { stores, settings, rules } = repo.data;
  const blockers = repo.ruleBlockers(rule, actor);
  const checks: Check[] = [];
  const e = rule.effect;
  if (!e || !rule.scope) return { blockers, checks };

  const targeted = stores.filter((s) => inScope(rule.scope, s));
  if (!targeted.length) checks.push({ ok: false, text: 'No stores are in this target yet.' });
  if (rule.geofence) {
    const unmapped = targeted.filter((s) => s.lat === undefined);
    checks.push(
      unmapped.length
        ? { ok: false, text: `Near-store offer: ${unmapped.map((s) => s.name).join(', ')} ${unmapped.length === 1 ? 'has' : 'have'} no map location, so members there won't see it. Add it on Locations.` }
        : { ok: true, text: `Near-store offer: shown in the app within ${rule.geofence.radiusMiles} mi of ${targeted.length === 1 ? targeted[0]!.name : `${targeted.length} stores`}` },
    );
  }

  if (rule.fundedBy === 'store' || rule.fundedBy === 'split') {
    const off = e.type === 'itemDiscount' ? (e.centsOff ?? 0) : e.type === 'basketDiscount' ? e.centsOff : 0;
    if (off && settings.maxStoreDiscountCents > 0)
      checks.push(
        off <= settings.maxStoreDiscountCents
          ? { ok: true, text: `Within the store's max discount of ${money(settings.maxStoreDiscountCents)}` }
          : { ok: false, text: `Above the store's max discount of ${money(settings.maxStoreDiscountCents)}` },
      );
  }

  if (e.type === 'fuelDiscount') {
    const others = rules.filter(
      (r) => r.id !== rule.id && r.status === 'active' && r.effect.type === 'fuelDiscount' && targeted.some((s) => inScope(r.scope, s)),
    );
    checks.push({
      ok: true,
      text:
        settings.fuelStacking.mode === 'best'
          ? `Fuel discount: only the largest one applies per fill-up${others.length ? ` (${others.length} other fuel ${others.length === 1 ? 'discount' : 'discounts'} in these stores)` : ''}`
          : `Fuel discounts stack up to ${settings.fuelStacking.maxCentsPerGallon}¢/gal per fill-up`,
    });
  } else if (e.type !== 'pointsPerDollar' && e.type !== 'pointsPerGallon' && e.type !== 'pointsFlat') {
    checks.push({ ok: true, text: 'No fuel discount, so no stacking conflict' });
  }

  const cats = new Set<string>([
    ...('categories' in e && e.categories ? e.categories : []),
    ...rule.conditions.flatMap((c) => (c.type === 'hasItem' ? (c.categories ?? []) : [])),
  ]);
  const live = targeted.filter((s) => s.loyaltyLive);
  for (const cat of cats) {
    const missing = live.filter((s) => !s.mappedCategories.includes(cat));
    checks.push(
      missing.length
        ? { ok: false, text: `${categoryLabel(cat)} not mapped in the POS at ${listLabel(missing.map((s) => s.name))}` }
        : live.length
          ? { ok: true, text: `${categoryLabel(cat)} items mapped in the POS at ${listLabel(live.map((s) => s.name))}` }
          : { ok: true, text: `${categoryLabel(cat)} items will need mapping when these stores go live` },
    );
  }

  const notLive = targeted.length - live.length;
  if (notLive > 0)
    checks.push({
      ok: true,
      text: `${notLive} of ${targeted.length} ${targeted.length === 1 ? 'store has' : 'stores have'} no loyalty yet; the offer starts there once the POS is connected`,
    });

  if (rule.monthlyBudgetCents) checks.push({ ok: true, text: `Stops giving discounts once it has cost ${money(rule.monthlyBudgetCents)} in a month` });

  return { blockers, checks };
}
