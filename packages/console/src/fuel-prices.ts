// Pump prices for the app's store list. The POS link reports the price on every fuel sale (and can
// push a price list); the portal can set or correct them by hand. The newest price for a grade wins.
import { FUEL_GRADES } from './catalog.js';
import type { ConsoleStore, FuelPrice } from './model.js';
import { ConsoleError } from './repo.js';

/** Prices older than this are not shown to members. */
export const FUEL_PRICE_MAX_AGE_DAYS = 7;

const isGrade = (g: string) => FUEL_GRADES.some((x) => x.id === g);

/** Records a price for one grade unless a newer one is already known. Returns true when it changed. */
export function noteFuelPrice(store: ConsoleStore, grade: string, cents: number, at: string, source: FuelPrice['source']): boolean {
  if (!isGrade(grade) || !Number.isFinite(cents) || cents <= 0 || cents > 2000 || Number.isNaN(Date.parse(at))) return false;
  const was = store.fuelPrices?.[grade];
  if (was && Date.parse(was.at) > Date.parse(at)) return false;
  const price = { cents: Math.round(cents * 10) / 10, at, source };
  if (was && was.cents === price.cents && was.source === source) return false;
  store.fuelPrices = { ...store.fuelPrices, [grade]: price };
  return true;
}

/**
 * Prices typed in the portal, in dollars per gallon by grade, e.g. { regular: 3.199 }.
 * A blank (null) grade is removed so the app stops showing it.
 */
export function setFuelPricesByHand(store: ConsoleStore, dollars: Record<string, unknown>, at: string): void {
  for (const [grade, raw] of Object.entries(dollars)) {
    if (!isGrade(grade)) throw new ConsoleError(`Unknown fuel grade ${grade}.`);
    if (raw === null || raw === '') {
      if (store.fuelPrices) delete store.fuelPrices[grade];
      continue;
    }
    const value = Number(String(raw).replace(/[$\s]/g, ''));
    if (!Number.isFinite(value) || value <= 0 || value >= 20) throw new ConsoleError('Enter gas prices in dollars per gallon, like 3.199.');
    store.fuelPrices = { ...store.fuelPrices, [grade]: { cents: Math.round(value * 1000) / 10, at, source: 'manual' } };
  }
  if (store.fuelPrices && !Object.keys(store.fuelPrices).length) delete store.fuelPrices;
}

/** What the app shows: current prices in grade order, as dollars to three places. */
export function fuelPricesForApp(store: ConsoleStore, now: Date) {
  const oldest = now.getTime() - FUEL_PRICE_MAX_AGE_DAYS * 86_400_000;
  return FUEL_GRADES.flatMap((g) => {
    const p = store.fuelPrices?.[g.id];
    if (!p || Date.parse(p.at) < oldest) return [];
    return [{ grade: g.id, label: g.label, price: (p.cents / 100).toFixed(3), updatedAt: p.at }];
  });
}
