// Starting data for a new console: the 13 VGO stores, the pilot rules from the program design,
// and clearly marked sample activity so Results has something to show until real visits arrive.
import type { Actor } from '../../engine/src/index.js';
import { NO_EARN_CATEGORIES } from './catalog.js';
import { addDays, localMidnight, localParts } from './dates.js';
import type { ConsoleData, ConsoleRule, ConsoleStore } from './model.js';
import { Repo } from './repo.js';

export const ADMIN: Actor = { role: 'jobber-admin', userId: 'krut' };

function stores(): ConsoleStore[] {
  // Store-by-state split and POS for stores 02-13 are placeholders until confirmed.
  const state = (n: number): ConsoleStore['state'] => (n <= 5 ? 'SC' : n <= 9 ? 'NC' : 'GA');
  return Array.from({ length: 13 }, (_, i) => {
    const n = i + 1;
    const st = state(n);
    const pilot = n === 1;
    return {
      id: `vgo-${String(n).padStart(2, '0')}`,
      name: `VGO ${String(n).padStart(2, '0')}`,
      city: '',
      state: st,
      groupIds: [...(pilot ? ['pilot'] : []), st.toLowerCase()],
      pos: pilot ? 'verifone-commander' : 'other',
      loyaltyLive: pilot,
      mappedCategories: pilot ? ['coffee', 'fountain', 'sandwiches', 'hot-food', 'snacks', 'energy', 'cold-drinks', 'tobacco', 'lottery'] : [],
    };
  });
}

/** The starting birthday reward. Krut edits it in the portal like any offer. */
export function birthdayRule(at: string): ConsoleRule {
  return {
    id: 'birthday-treat',
    name: 'Birthday treat: free coffee or fountain drink',
    section: 'offer',
    status: 'active',
    scope: { kind: 'all' },
    conditions: [{ type: 'birthday', window: 'week' }],
    fundedBy: 'jobber',
    effect: { type: 'itemDiscount', categories: ['coffee', 'fountain'], percentOff: 100, maxQty: 1 },
    perMemberLimit: { count: 1, period: 'year' },
    headline: 'HAPPY BIRTHDAY',
    createdBy: ADMIN,
    createdAt: at,
    updatedAt: at,
  };
}

function rules(today: string, pilotStart: string): ConsoleRule[] {
  const at = new Date(localMidnight(pilotStart)).toISOString();
  const base = { conditions: [], fundedBy: 'jobber' as const, createdBy: ADMIN, createdAt: at, updatedAt: at };
  return [
    {
      ...base,
      id: 'earn-inside',
      name: 'Points on inside purchases',
      section: 'earn',
      status: 'active',
      scope: { kind: 'all' },
      effect: { type: 'pointsPerDollar', points: 1, excludeCategories: NO_EARN_CATEGORIES },
      stackingGroup: 'earn-dollar',
    },
    {
      ...base,
      id: 'earn-fuel',
      name: 'Points on fuel',
      section: 'earn',
      status: 'active',
      scope: { kind: 'all' },
      effect: { type: 'pointsPerGallon', points: 1 },
      stackingGroup: 'earn-gallon',
    },
    {
      ...base,
      id: 'earn-premium-weekends',
      name: '2x points on premium on weekends',
      section: 'earn',
      status: 'paused',
      scope: { kind: 'groups', groupIds: ['sc'] },
      schedule: { daysOfWeek: [0, 6] },
      conditions: [{ type: 'fuelGrade', grades: ['premium'] }],
      effect: { type: 'pointsPerGallon', points: 2 },
      stackingGroup: 'earn-gallon',
    },
    {
      ...base,
      id: 'redeem-fuel',
      name: '100 points = 10¢/gal',
      section: 'redeem',
      status: 'active',
      scope: { kind: 'all' },
      effect: { type: 'fuelDiscount', centsPerGallon: 10, maxGallons: 20, costPoints: 100 },
    },
    {
      ...base,
      id: 'redeem-fountain',
      name: 'Free fountain drink for points',
      section: 'redeem',
      status: 'active',
      scope: { kind: 'groups', groupIds: ['pilot'] },
      effect: { type: 'itemDiscount', categories: ['fountain'], percentOff: 100, maxQty: 1, costPoints: 300 },
    },
    {
      ...base,
      id: 'welcome',
      name: 'Welcome: 25¢/gal off next fill-up',
      section: 'offer',
      welcome: true,
      status: 'active',
      scope: { kind: 'all' },
      conditions: [{ type: 'firstVisit' }],
      effect: { type: 'fuelDiscount', centsPerGallon: 25, maxGallons: 20 },
      memberText: 'Your first fill-up as a member, up to 20 gallons.',
    },
    birthdayRule(at),
    {
      ...base,
      id: 'coffee-card',
      name: 'Buy 5 coffees or fountain drinks, 6th free',
      section: 'offer',
      status: 'active',
      scope: { kind: 'groups', groupIds: ['pilot'] },
      fundedBy: 'store',
      effect: { type: 'punchCard', cardId: 'coffee-fountain', categories: ['coffee', 'fountain'], every: 5 },
      memberText: 'Every coffee or fountain drink earns a punch.',
    },
    {
      ...base,
      id: 'sandwich-fillup',
      name: '$1 off any sandwich with a fill-up',
      section: 'offer',
      status: 'active',
      scope: { kind: 'stores', storeIds: ['vgo-01'] },
      fundedBy: 'store',
      schedule: { startsAt: localMidnight(pilotStart), endsAt: localMidnight(addDays(pilotStart, 90)) },
      conditions: [
        { type: 'minGallons', gallons: 8 },
        { type: 'hasItem', categories: ['sandwiches'] },
      ],
      effect: { type: 'itemDiscount', categories: ['sandwiches'], centsOff: 100, maxQty: 1 },
      perMemberLimit: { count: 1, period: 'day' },
      requiresClip: true,
      memberText: 'Buy 8+ gallons and a sandwich in the same visit.',
    },
    {
      ...base,
      id: 'tuesday-fuel',
      name: 'Extra 5¢/gal on Tuesdays',
      section: 'offer',
      status: 'active',
      scope: { kind: 'groups', groupIds: ['sc'] },
      schedule: { startsAt: localMidnight(addDays(today, 7)), endsAt: localMidnight(addDays(today, 67)), daysOfWeek: [2] },
      effect: { type: 'fuelDiscount', centsPerGallon: 5, maxGallons: 20 },
      monthlyBudgetCents: 50_000,
    },
    {
      ...base,
      id: 'manufacturer-energy',
      name: 'Manufacturer offer: 50¢ off energy drinks',
      section: 'offer',
      status: 'draft',
      scope: { kind: 'all' },
      fundedBy: 'manufacturer',
      effect: { type: 'itemDiscount', categories: ['energy'], centsOff: 50, maxQty: 2 },
      requiresClip: true,
      memberText: 'Paid for by the brand through Skupos.',
    },
  ];
}

/** Small deterministic random generator so sample data is the same on every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS = [
  { sku: 'coffee-16', category: 'coffee', unitCents: 199 },
  { sku: 'fountain-32', category: 'fountain', unitCents: 179 },
  { sku: 'turkey-sub', category: 'sandwiches', unitCents: 599 },
  { sku: 'pizza-slice', category: 'hot-food', unitCents: 349 },
  { sku: 'chips', category: 'snacks', unitCents: 229 },
  { sku: 'energy-16', category: 'energy', unitCents: 329 },
  { sku: 'water-20', category: 'cold-drinks', unitCents: 189 },
  { sku: 'cigs', category: 'tobacco', unitCents: 899 },
  { sku: 'scratch-5', category: 'lottery', unitCents: 500 },
];

/** Adds about 45 days of sample visits at the pilot store, run through the real rules. */
function addSampleActivity(repo: Repo, pilotStart: string, days: number): void {
  const rand = rng(7);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const memberIds: string[] = [];
  let seq = 0;
  for (let d = 0; d < days; d++) {
    const ymd = addDays(pilotStart, d);
    // Sign-ups and the share of visits with a member ID grow over the pilot.
    const share = 0.08 + (0.14 * d) / days;
    for (let i = 0; i < 1 + Math.floor(rand() * 2); i++) {
      seq++;
      const m = repo.data.members;
      m.push({
        id: `sample-${seq}`,
        name: `Sample member ${seq}`,
        phone: `555${String(1000000 + seq).slice(1)}`,
        homeStoreId: 'vgo-01',
        tags: ['sample'],
        pointsBalance: 0,
        visitCount: 0,
        punches: {},
        joinedAt: new Date(localMidnight(ymd)).toISOString(),
        smsOptIn: rand() < 0.7,
        clippedRuleIds: rand() < 0.6 ? ['sandwich-fillup'] : [],
      });
      memberIds.push(`sample-${seq}`);
    }
    for (let v = 0; v < 40; v++) {
      const hour = 6 + Math.floor(rand() * 16);
      const at = new Date(Date.parse(localMidnight(ymd)) + hour * 3_600_000 + Math.floor(rand() * 3_600_000)).toISOString();
      const isMember = memberIds.length > 0 && rand() < share;
      const memberId = isMember ? pick(memberIds) : undefined;
      const hasFuel = rand() < 0.7;
      const items = Array.from({ length: Math.floor(rand() * (isMember ? 4 : 3)) }, () => ({ ...pick(PRODUCTS), qty: 1 }));
      const gallons = Math.round((isMember ? 8 + rand() * 7 : 6 + rand() * 6.4) * 10) / 10;
      const tx = {
        id: `sample-tx-${ymd}-${v}`,
        storeId: 'vgo-01',
        at,
        localHour: localParts(at).hour,
        localDayOfWeek: localParts(at).dayOfWeek,
        items,
        fuel: hasFuel ? { grade: rand() < 0.85 ? 'regular' : 'premium', gallons, pricePerGallonCents: 309 } : undefined,
      };
      const member = memberId ? repo.member(memberId) : undefined;
      const redeemRuleIds = member && hasFuel && member.pointsBalance >= 100 && rand() < 0.35 ? ['redeem-fuel'] : undefined;
      repo.recordTransaction({ ...tx, redeemRuleIds }, memberId, { sample: true, save: false });
    }
  }
}

export function seedData(now = new Date()): ConsoleData {
  const today = localParts(now).ymd;
  const pilotDays = 90;
  const elapsed = 45;
  const pilotStart = addDays(today, -elapsed);
  const data: ConsoleData = {
    version: 1,
    stores: stores(),
    groups: [
      { id: 'pilot', name: 'Pilot' },
      { id: 'sc', name: 'SC stores' },
      { id: 'nc', name: 'NC stores' },
      { id: 'ga', name: 'GA stores' },
    ],
    rules: rules(today, pilotStart),
    members: [],
    ledger: [],
    branding: { programName: 'VGO Rewards', logoDataUrl: '', mainColor: '#0F2747', accentColor: '#C8102E' },
    settings: {
      pointsExpireMonths: 12,
      fuelStacking: { mode: 'best' },
      maxStoreDiscountCents: 0,
      storeManagersCanCreate: true,
      monthlyBudgetCents: 500_000,
    },
    history: [],
    pilot: { storeId: 'vgo-01', startedOn: pilotStart, days: pilotDays },
  };
  const repo = new Repo(data, () => {}, () => now);
  addSampleActivity(repo, pilotStart, elapsed);
  data.history.unshift({ at: now.toISOString(), userId: 'system', what: 'Console created with the pilot rules and sample activity' });
  return data;
}
