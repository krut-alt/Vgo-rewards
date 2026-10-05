// Preset choices for the Reward rules dropdowns. Every dropdown also offers "Custom…",
// so any value can be typed in; these are just the common ones.
import { CATEGORIES, FUEL_GRADES, NO_EARN_CATEGORIES } from './catalog.js';

export const PRESETS = {
  pointsPerDollar: [1, 2, 3, 5],
  pointsPerGallon: [1, 2, 3, 5],
  multiplier: [2, 3, 5],
  exclusions: [
    { label: 'Tobacco, lottery, gift cards', value: NO_EARN_CATEGORIES },
    { label: 'Tobacco and lottery', value: ['tobacco', 'lottery'] },
    { label: 'Nothing excluded', value: [] as string[] },
  ],
  fuelGrades: [{ label: 'Any fuel grade', value: [] as string[] }, ...FUEL_GRADES.map((g) => ({ label: g.label, value: [g.id] }))],
  days: [
    { label: 'Every day', value: [] as number[] },
    { label: 'Weekends', value: [0, 6] },
    { label: 'Weekdays', value: [1, 2, 3, 4, 5] },
    { label: 'Mondays', value: [1] },
    { label: 'Tuesdays', value: [2] },
    { label: 'Wednesdays', value: [3] },
    { label: 'Thursdays', value: [4] },
    { label: 'Fridays', value: [5] },
  ],
  redeemFuelPoints: [50, 100, 200, 500],
  redeemFuelCents: [5, 10, 15, 25],
  gallonCaps: [10, 15, 20, 25],
  redeemItemPoints: [100, 200, 300, 500],
  items: CATEGORIES.filter((c) => !NO_EARN_CATEGORIES.includes(c.id)).map((c) => ({ label: c.label, value: c.id })),
  welcome: [
    { label: '25¢/gal off, up to 20 gal', value: 'fuel-25' },
    { label: 'Bonus points', value: 'points' },
    { label: 'Free item', value: 'item' },
  ],
  expiry: [
    { label: '12 months without a visit', value: 12 },
    { label: '6 months without a visit', value: 6 },
    { label: 'Never', value: 0 },
  ],
};
