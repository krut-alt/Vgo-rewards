// One-time updates to saved data, applied when the server loads it. Each runs once, in order,
// and is recorded in `data.migrations`, so changes made in the portal afterwards are kept.
import type { ConsoleData } from './model.js';

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
