// One-time updates to saved data, applied when the server loads it. Each runs once, in order,
// and is recorded in `data.migrations`, so changes made in the portal afterwards are kept.
import type { ConsoleData, ConsoleStore } from './model.js';
import { birthdayRule } from './seed.js';

/** The id of the migration that brings in the real site list (seed.ts skips it for tests). */
export const REAL_SITES_MIGRATION = '2026-10-real-sites';
/** The site-list migrations, which test data with placeholder stores skips. */
export const SITE_MIGRATIONS = [REAL_SITES_MIGRATION, '2026-10-site-spots', '2026-10-missed-spots'];

/** VGO's sites as Krut sent them, Oct 2026: [site number, street, city, state, ZIP]. */
export const VGO_SITES: [number, string, string, string, string?][] = [
  [25, '469 Roper Mountain Road', 'Greenville', 'SC'],
  [28, '346 N. Reilly Road', 'Fayetteville', 'NC'],
  [29, '1410 Laurens Road', 'Greenville', 'SC'],
  [12, '8349 Moorefield Memorial Hwy', 'Liberty', 'SC'],
  [16, "642 St. Andrew's Blvd", 'Charleston', 'SC'],
  [22, '2314 Ashley River Road', 'Charleston', 'SC'],
  [24, '205 S Goose Creek Blvd', 'Goose Creek', 'SC'],
  [2, '4512 Augusta Rd', 'Greenville', 'SC'],
  [7, '4028 Old Buncombe Rd', 'Greenville', 'SC'],
  [15, '2800 Greenville Hwy', 'Easley', 'SC'],
  [14, '301 Ann Street', 'Pickens', 'SC'],
  [21, '1406 Savannah Hwy', 'Charleston', 'SC'],
  [3, '800 E. Georgia Road', 'Simpsonville', 'SC', '29681'],
  [11, '1335 Cedar Lane Road', 'Greenville', 'SC'],
  [13, '2295 Jefferson Davis Hwy', 'Camden', 'SC'],
  [1, '2401 River Road', 'Piedmont', 'SC'],
  [31, 'W. Georgia Road', 'Greenville', 'SC'],
  [33, 'Mauldin Road & Fairforest Road', 'Greenville', 'SC'],
  [32, '501 N Harper Road', 'Laurens', 'SC'],
  [4, '1195 W Cambridge Ave', 'Greenwood', 'SC'],
  [5, '121 S Main St', 'Donalds', 'SC'],
];
/** The pilot store, the only one live for now. */
export const PILOT_SITE = 31;

/**
 * Map spots for the sites above, looked up once from the U.S. Census address geocoder (and
 * OpenStreetMap where Census had no match), so the app's map doesn't depend on a live lookup.
 * #15 is listed as Easley but its postal city is Liberty; #32 matched 501 N Harper Street. #31 has
 * no street number, so its spot is on W. Georgia Road; #33 is the Mauldin Rd and Fairforest Way corner.
 */
export const SITE_SPOTS: Record<number, [number, number]> = {
  25: [34.84359, -82.311589],
  28: [35.091109, -79.010642],
  29: [34.844683, -82.365142],
  12: [34.748322, -82.660995],
  16: [32.785568, -79.979272],
  22: [32.82161, -80.036283],
  24: [32.989864, -80.039782],
  2: [34.794059, -82.380493],
  7: [34.893417, -82.431896],
  15: [34.81098, -82.650777],
  14: [34.888519, -82.709946],
  21: [32.784938, -80.002084],
  3: [34.751858, -82.217091],
  11: [34.87525, -82.442245],
  13: [34.27639, -80.562072],
  1: [34.757116, -82.473679],
  31: [34.737208, -82.27645],
  33: [34.785585, -82.351806],
  32: [34.506544, -82.008809],
  4: [34.19457, -82.188746],
  5: [34.376038, -82.346338],
};

/** The site number in a store name: "VGO #31", "VGO 31" and "vgo#031" all give 31. */
export const siteNumber = (name: string) => {
  const m = /^\s*VGO\s*#?\s*0*(\d+)\s*$/i.exec(name);
  return m ? Number(m[1]) : undefined;
};

/**
 * Fills in map spots the first pass missed: any "VGO #n" site with no spot yet, whatever its address
 * says, and the pilot store, which is VGO #31 even if it was renamed in the portal. Spots someone set by
 * hand are kept. Also drops a coming-soon copy of the pilot's site that was added next to it.
 */
export function placeMissedSites(d: ConsoleData): void {
  const pilot = d.stores.find((s) => s.id === d.pilot.storeId);
  const copy = d.stores.find((s) => s !== pilot && s.id === `vgo-${PILOT_SITE}` && !s.loyaltyLive);
  if (pilot && copy && siteNumber(pilot.name) === PILOT_SITE) {
    const used = d.members.some((m) => m.homeStoreId === copy.id) || d.ledger.some((e) => e.tx.storeId === copy.id) || d.rules.some((r) => r.scope.kind === 'stores' && r.scope.storeIds.includes(copy.id));
    if (!used) {
      d.stores = d.stores.filter((s) => s !== copy);
      for (const u of d.portal?.users ?? []) u.storeIds = u.storeIds.filter((id) => id !== copy.id);
    }
  }
  for (const s of d.stores) {
    if (s.lat !== undefined) continue;
    // Old placeholder names ("VGO 05") aren't real site numbers, so other stores need the "#".
    const n = s === pilot ? PILOT_SITE : s.name.includes('#') ? siteNumber(s.name) : undefined;
    const spot = n === undefined ? undefined : SITE_SPOTS[n];
    if (!spot) continue;
    [s.lat, s.lng] = spot;
    delete s.mapLookupFailed;
  }
}

/** Puts each listed site on the map at its looked-up spot, unless its address was changed since. */
export function placeSites(d: ConsoleData): void {
  for (const [n, address, city, state] of VGO_SITES) {
    const spot = SITE_SPOTS[n];
    const s = d.stores.find((x) => x.name.replace(/\s+/g, '') === `VGO#${n}`);
    if (!spot || !s || s.address !== address || s.city !== city || s.state !== state) continue;
    [s.lat, s.lng] = spot;
    delete s.mapLookupFailed;
  }
}

const isPlaceholder = (s: ConsoleStore) => /^VGO \d\d$/.test(s.name) && !s.city && !s.address;

/**
 * Swaps the starting placeholder stores for VGO's real sites. The pilot keeps its ID (members,
 * visits and offers point at it) and becomes VGO #31; the other sites start as coming soon.
 * Placeholders Krut already edited in the portal are left alone.
 */
export function useRealSites(d: ConsoleData): void {
  const pilot = d.stores.find((s) => s.id === d.pilot.storeId);
  const site = (n: number) => VGO_SITES.find((x) => x[0] === n)!;
  if (pilot && isPlaceholder(pilot)) {
    const [, address, city, state] = site(PILOT_SITE);
    Object.assign(pilot, { name: `VGO #${PILOT_SITE}`, address, city, state });
  }
  const gone = new Set(d.stores.filter((s) => s !== pilot && isPlaceholder(s)).map((s) => s.id));
  if (gone.size) {
    d.stores = d.stores.filter((s) => !gone.has(s.id));
    const keep = (ids: string[]) => ids.filter((id) => !gone.has(id));
    for (const m of d.members) if (m.homeStoreId && gone.has(m.homeStoreId)) m.homeStoreId = d.pilot.storeId;
    for (const r of d.rules) {
      if (r.scope.kind !== 'stores') continue;
      const ids = keep(r.scope.storeIds);
      if (ids.length !== r.scope.storeIds.length) r.scope = { kind: 'stores', storeIds: ids.length ? ids : [d.pilot.storeId] };
    }
    for (const u of d.portal?.users ?? []) u.storeIds = keep(u.storeIds);
  }
  for (const [n, address, city, state, zip] of VGO_SITES) {
    const name = `VGO #${n}`;
    if (d.stores.some((s) => s.name.replace(/\s+/g, '') === name.replace(/\s+/g, ''))) continue;
    let id = `vgo-${n}`;
    for (let k = 2; d.stores.some((s) => s.id === id); k++) id = `vgo-${n}-${k}`;
    const group = d.groups.find((g) => g.id === state.toLowerCase());
    const spot = SITE_SPOTS[n];
    d.stores.push({ id, name, address, city, state, ...(zip ? { zip } : {}), ...(spot ? { lat: spot[0], lng: spot[1] } : {}), groupIds: group ? [group.id] : [], pos: 'other', loyaltyLive: false, mappedCategories: [] });
  }
}

const MIGRATIONS: { id: string; run: (d: ConsoleData) => void }[] = [
  {
    // Krut, Oct 2026: alcohol earns no points, like tobacco.
    id: '2026-10-alcohol-no-points',
    run: (d) => {
      const rule = d.rules.find((r) => r.id === 'earn-inside');
      if (rule?.effect.type === 'pointsPerDollar') {
        const ex = rule.effect.excludeCategories ?? [];
        if (!ex.includes('beer')) rule.effect.excludeCategories = [...ex, 'beer'];
      }
    },
  },
  {
    // Krut, Oct 2026: no cap on store offers for now.
    id: '2026-10-no-store-cap',
    run: (d) => {
      d.settings.maxStoreDiscountCents = 0;
    },
  },
  {
    // Krut, Oct 2026: a birthday reward, editable in the portal.
    id: '2026-10-birthday-treat',
    run: (d) => {
      if (!d.rules.some((r) => r.id === 'birthday-treat')) d.rules.push(birthdayRule(new Date().toISOString()));
    },
  },
  {
    // Krut, Oct 2026: the real site list. VGO #31 stays live; the rest show as coming soon.
    id: REAL_SITES_MIGRATION,
    run: useRealSites,
  },
  {
    // Krut, Oct 2026: real map pins for every site, looked up ahead of time.
    id: '2026-10-site-spots',
    run: placeSites,
  },
  {
    // Krut, Oct 2026: VGO #31 had no pin, so it couldn't be found from the store list.
    id: '2026-10-missed-spots',
    run: placeMissedSites,
  },
  {
    // Krut, Oct 2026: dealers pay for the points their customers earn inside, and are credited when points
    // are redeemed. Points on fuel stay jobber-funded.
    id: '2026-10-dealers-fund-inside-points',
    run: (d) => {
      const rule = d.rules.find((r) => r.id === 'earn-inside');
      if (rule?.fundedBy === 'jobber') rule.fundedBy = 'store';
    },
  },
];

/** Applies the migrations this data hasn't had yet. Returns true when anything changed. */
export function migrate(data: ConsoleData): boolean {
  const done = new Set(data.migrations ?? []);
  let changed = false;
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    m.run(data);
    done.add(m.id);
    changed = true;
  }
  data.migrations = [...done];
  return changed;
}

/** For new data: marks every migration as already applied. */
export function allMigrations(): string[] {
  return MIGRATIONS.map((m) => m.id);
}
