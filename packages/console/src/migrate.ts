// One-time updates to saved data, applied when the server loads it. Each runs once, in order,
// and is recorded in `data.migrations`, so changes made in the portal afterwards are kept.
import type { ConsoleData, ConsoleStore } from './model.js';
import { birthdayRule } from './seed.js';

/** The id of the migration that brings in the real site list (seed.ts skips it for tests). */
export const REAL_SITES_MIGRATION = '2026-10-real-sites';

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
    d.stores.push({ id, name, address, city, state, ...(zip ? { zip } : {}), groupIds: group ? [group.id] : [], pos: 'other', loyaltyLive: false, mappedCategories: [] });
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
