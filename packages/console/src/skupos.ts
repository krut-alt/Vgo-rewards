// Skupos promotions: brand-funded deals (mostly tobacco and CPG, through Skupos Engage) that run at
// stores enrolled in Skupos. Once a day the current list of promotions is read (from a feed link when
// one is set up, otherwise the last list uploaded in the portal) and turned into app offers at every
// enrolled store that is live on the rewards network. Promotions that end or drop off the list are retired.
import type { RuleStatus } from '../../engine/src/index.js';
import { addDays, localMidnight, localParts } from './dates.js';
import { categoryFor, csvRows, everyItem } from './items.js';
import type { ConsoleData, ConsoleRule, ConsoleStore } from './model.js';
import { ConsoleError, type Repo } from './repo.js';
import { ADMIN } from './seed.js';
import { AGE_21 } from './validate.js';

/** One promotion as Skupos lists it, cleaned up. */
export interface SkuposPromo {
  id: string;
  brand: string;
  title: string;
  description?: string;
  /** Eligible UPCs. Matched against the POS line and, through the items list, its SKU. */
  upcs: string[];
  /** Our category id, when the promotion names one we know. */
  category?: string;
  centsOff?: number;
  percentOff?: number;
  /** Most discounted items per visit. */
  maxQty: number;
  /** First and last day, YYYY-MM-DD, both included. */
  startsOn: string;
  endsOn: string;
  /** 21+ only. Alcohol and tobacco always are, and so is anything whose category isn't given. */
  ageRestricted: boolean;
  /** Skupos store IDs or our site names it runs at; empty means every enrolled store. */
  stores: string[];
}

export type SkuposSource = 'feed' | 'upload' | 'daily' | 'stores' | 'manual';

export interface SkuposRun {
  at: string;
  source: SkuposSource;
  /** Set when the feed could not be read; the last list was used instead. */
  error?: string;
  created: string[];
  updated: string[];
  ended: string[];
  skipped: { promo: string; reason: string }[];
  /** Skupos offers live or scheduled in the app after this run. */
  active: { ruleId: string; name: string; endsOn: string; stores: string[] }[];
}

export interface SkuposState {
  /** The current list of promotions, from the last feed read or upload. */
  promos: SkuposPromo[];
  promosFrom?: { source: 'feed' | 'upload'; at: string; fileName?: string };
  /** Store-local date of the last daily update. */
  lastDailyOn?: string;
  /** Newest first, last 90. */
  runs: SkuposRun[];
}

const MAX_RUNS = 90;
const MAX_PROMOS = 2_000;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

export const skuposRuleId = (promoId: string) => `skupos-${slug(promoId) || 'promo'}`;

// ---- reading a promotions list ----

// Column names as Skupos exports and reports word them, plus the obvious variants.
const COLUMNS = {
  id: /^(promo(tion)? ?(id|code|#)|offer ?(id|code|#)|program ?(id|code)|deal ?id|id)$/,
  brand: /^(brand|manufacturer|mfr|brand ?name|sponsor)$/,
  title: /^(offer|promo(tion)?|promo(tion)? ?name|offer ?name|program|program ?name|title|name|deal)$/,
  description: /^(description|details|terms|offer ?details|promo(tion)? ?description|member ?text)$/,
  upcs: /^(upcs?|eligible ?upcs?|upc ?list|barcodes?|scan ?codes?|items?|skus?)$/,
  category: /^(category|product ?category|department|dept|product ?type)$/,
  discount: /^(discount|discount ?amount|amount|value|cents ?off|amount ?off|savings|offer ?value|price ?reduction)$/,
  percent: /^(percent ?off|% ?off|discount ?%|percent)$/,
  maxQty: /^(limit|max ?qty|max ?quantity|quantity ?limit|qty ?limit|max ?units|limit ?per ?transaction)$/,
  startsOn: /^(start|starts|start ?date|begins|begin ?date|effective ?date|from)$/,
  endsOn: /^(end|ends|end ?date|expires|expiration|expiration ?date|to|through)$/,
  age: /^(21\+?|age|age ?restricted|age ?21|21 ?plus|min ?age|minimum ?age)$/,
  stores: /^(stores?|store ?ids?|sites?|site ?ids?|locations?|skupos ?store ?ids?)$/,
} as const;
type Field = keyof typeof COLUMNS;

/** YYYY-MM-DD from 2026-10-06, 10/6/2026, 10/6/26 or an ISO time. */
function day(raw: string): string | undefined {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  const [y, m, d] = iso ? [+iso[1]!, +iso[2]!, +iso[3]!] : us ? [us[3]!.length === 2 ? 2000 + +us[3]! : +us[3]!, +us[1]!, +us[2]!] : [0, 0, 0];
  if (!y || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Cents from "$1.00", "1", "1.50", "50¢" or "50c". Plain numbers are dollars. */
function cents(raw: string): number | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  const c = /^(\d+)\s*(¢|c|cents?)$/.exec(s);
  if (c) return +c[1]!;
  const n = Number(s.replace(/[$,\s]/g, '').replace(/off$/, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
}

const list = (raw: string, sep = /[;|,\s]+/) =>
  raw
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);

const yes = (raw: string) => /^(y|yes|true|1|21|21\+|x)$/i.test(raw.trim());
const no = (raw: string) => /^(n|no|false|0|18|18\+)$/i.test(raw.trim());

/** Turns one row (column name to text) into a promotion, or says why it was skipped. */
function toPromo(row: Partial<Record<Field, string>>, today: string): SkuposPromo | { skip: string } {
  const get = (k: Field) => String(row[k] ?? '').trim();
  const brand = get('brand');
  const title = get('title') || get('description');
  const label = [brand, title].filter(Boolean).join(': ') || get('id') || 'A row';
  if (!brand && !title) return { skip: `${label} has no brand or offer name.` };
  const percentRaw = get('percent') || (/%\s*$/.test(get('discount')) ? get('discount') : '');
  const percentOff = percentRaw ? Number(percentRaw.replace(/[%\s]/g, '')) : undefined;
  const centsOff = percentRaw ? undefined : cents(get('discount'));
  if (percentOff !== undefined && !(percentOff > 0 && percentOff <= 100)) return { skip: `${label}: the percent off isn't a number from 1 to 100.` };
  if (percentOff === undefined && !centsOff) return { skip: `${label} has no discount amount.` };
  const endsOn = day(get('endsOn'));
  if (!endsOn) return { skip: `${label} has no end date.` };
  const startsOn = get('startsOn') ? day(get('startsOn')) : today;
  if (!startsOn) return { skip: `${label}: the start date isn't a date.` };
  if (endsOn < startsOn) return { skip: `${label} ends before it starts.` };
  const upcs = [...new Set(list(get('upcs')).map((u) => u.replace(/\D/g, '')).filter((u) => u.length >= 6))];
  const category = categoryFor(get('category')) ?? (get('category') ? undefined : categoryFor(`${brand} ${title}`.toLowerCase().replace(/[^a-z ]/g, ' ')));
  if (!upcs.length && !category) return { skip: `${label} has no UPCs or category, so the register couldn't tell which items get the discount.` };
  const age = get('age');
  // Most Skupos promotions are tobacco, so an unknown product is treated as 21+.
  const ageRestricted = (category && AGE_21.includes(category)) || !category ? true : age ? !no(age) && (yes(age) || Number(age) >= 21) : false;
  const maxQty = Math.max(1, Math.min(10, Math.floor(Number(get('maxQty')) || 1)));
  const id = get('id') || slug(`${brand} ${title} ${startsOn}`);
  return {
    id,
    brand,
    title: title || brand,
    ...(get('description') && get('description') !== title ? { description: get('description').slice(0, 140) } : {}),
    upcs,
    ...(category ? { category } : {}),
    ...(percentOff !== undefined ? { percentOff } : { centsOff }),
    maxQty,
    startsOn,
    endsOn,
    ageRestricted,
    stores: list(get('stores'), /[;|,]+/),
  };
}

function normalize(key: string): string {
  return key.trim().toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' ');
}

function fieldsOf(record: Record<string, unknown>): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const [k, v] of Object.entries(record)) {
    const key = normalize(k);
    const f = (Object.keys(COLUMNS) as Field[]).find((x) => COLUMNS[x].test(key));
    if (!f || out[f]) continue;
    out[f] = Array.isArray(v) ? v.join(';') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : v == null ? '' : String(v);
  }
  return out;
}

export interface ParsedPromos {
  promos: SkuposPromo[];
  skipped: { promo: string; reason: string }[];
}

function collect(rows: Partial<Record<Field, string>>[], today: string): ParsedPromos {
  if (rows.length > MAX_PROMOS) throw new ConsoleError(`That list has more than ${MAX_PROMOS.toLocaleString()} promotions.`);
  const byId = new Map<string, SkuposPromo>();
  const skipped: ParsedPromos['skipped'] = [];
  for (const row of rows) {
    const p = toPromo(row, today);
    if ('skip' in p) skipped.push({ promo: row.id || row.title || row.brand || '', reason: p.skip });
    else byId.set(p.id, p);
  }
  return { promos: [...byId.values()], skipped };
}

/** Reads a promotions list saved from the Skupos dashboard or a Skupos report (CSV). */
export function parseSkuposCsv(text: string, today: string): ParsedPromos {
  const rows = csvRows(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new ConsoleError('That file has no promotions. It needs a header row and one row per promotion.');
  const header = rows[0]!.map(normalize);
  const known = header.filter((h) => Object.values(COLUMNS).some((re) => re.test(h)));
  if (!header.some((h) => COLUMNS.endsOn.test(h)) || !header.some((h) => COLUMNS.discount.test(h) || COLUMNS.percent.test(h)))
    throw new ConsoleError('The first row should name the columns. It needs at least Brand, Offer, UPCs, Discount, Start date and End date.');
  if (known.length < 3) throw new ConsoleError('None of the columns look like a promotions list.');
  return collect(
    rows.slice(1).map((r) => fieldsOf(Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))),
    today,
  );
}

/** Reads a feed response: a list of promotions, or an object holding one under promotions, offers or data. */
export function parseSkuposJson(body: unknown, today: string): ParsedPromos {
  const o = body as Record<string, unknown> | unknown[];
  const items = Array.isArray(o) ? o : ['promotions', 'promos', 'offers', 'deals', 'data', 'items'].map((k) => (o as Record<string, unknown>)?.[k]).find(Array.isArray);
  if (!Array.isArray(items)) throw new ConsoleError('The Skupos feed did not send a list of promotions.');
  return collect(
    items.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map(fieldsOf),
    today,
  );
}

/** Reads the feed link set in SKUPOS_FEED_URL, sending SKUPOS_FEED_TOKEN as a bearer token. */
export function skuposFeedFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): SkuposFeed | undefined {
  const url = env.SKUPOS_FEED_URL?.trim();
  if (!url) return undefined;
  const token = env.SKUPOS_FEED_TOKEN?.trim();
  return async (today) => {
    const res = await fetchImpl(url, { headers: { accept: 'application/json, text/csv;q=0.9', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`The Skupos feed answered ${res.status}.`);
    const text = await res.text();
    const json = (res.headers.get('content-type') ?? '').includes('json') || /^\s*[[{]/.test(text);
    return json ? parseSkuposJson(JSON.parse(text), today) : parseSkuposCsv(text, today);
  };
}

export type SkuposFeed = (today: string) => Promise<ParsedPromos>;

// ---- turning promotions into app offers ----

/** Whether a store takes part: enrolled in Skupos and live on the rewards network. */
export const skuposStore = (s: ConsoleStore) => Boolean(s.skuposEnrolled && s.loyaltyLive);

function storesFor(p: SkuposPromo, stores: ConsoleStore[]): ConsoleStore[] {
  const on = stores.filter(skuposStore);
  if (!p.stores.length) return on;
  // "VGO #31", "vgo 31", "31" and "031" all name site 31.
  const key = (x: string) => {
    const k = x.toLowerCase().replace(/[^a-z0-9]/g, '');
    return /^\d+$/.test(k) ? String(Number(k)) : k;
  };
  const want = new Set(p.stores.flatMap((x) => [key(x), ...(/^vgo\W*\d+$/i.test(x.trim()) ? [key(/(\d+)$/.exec(x.trim())![1]!)] : [])]));
  const num = (s: ConsoleStore) => /(\d+)\s*$/.exec(s.name)?.[1];
  return on.filter((s) => [s.skuposStoreId, s.id, s.name, num(s)].some((k) => k && want.has(key(k))));
}

const money = (c: number) => (c % 100 === 0 ? `$${c / 100}` : c < 100 ? `${c}¢` : `$${(c / 100).toFixed(2)}`);

/** The fields the import owns. Artwork, featured and the headline are left to whoever edits the offer. */
function ruleFields(p: SkuposPromo, storeIds: string[], d: ConsoleData): Omit<ConsoleRule, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'createdBy'> {
  // The POS may ring the item up by its SKU rather than its UPC, so both are matched.
  const catalog = everyItem(d)?.items ?? [];
  const skus = [...new Set(p.upcs.flatMap((u) => [u, ...catalog.filter((i) => i.upc === u).map((i) => i.sku)]))];
  const off = p.percentOff !== undefined ? `${p.percentOff}% off` : `${money(p.centsOff!)} off`;
  return {
    name: `${p.brand ? `${p.brand}: ` : ''}${p.title}`.slice(0, 80),
    section: 'offer',
    scope: { kind: 'stores', storeIds },
    schedule: { startsAt: localMidnight(p.startsOn), endsAt: localMidnight(addDays(p.endsOn, 1)) },
    conditions: p.ageRestricted ? [{ type: 'minAge', years: 21 }] : [],
    effect: {
      type: 'itemDiscount',
      ...(skus.length ? { skus } : { categories: [p.category!] }),
      ...(p.percentOff !== undefined ? { percentOff: p.percentOff } : { centsOff: p.centsOff }),
      maxQty: p.maxQty,
    },
    perMemberLimit: { count: 1, period: 'day' },
    requiresClip: true,
    fundedBy: 'manufacturer',
    memberText: (p.description || `${off}${p.maxQty > 1 ? `, up to ${p.maxQty}` : ''}. Paid for by the brand through Skupos.`).slice(0, 140),
    skupos: { promoId: p.id, brand: p.brand, setStatus: 'active' },
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Brings the Skupos offers in line with the current promotions list and enrolled stores, and logs
 * the run. An offer someone paused or retired by hand stays that way; the import only changes the
 * status it set itself.
 */
export function applySkupos(repo: Repo, source: SkuposSource, now: Date, error?: string): SkuposRun {
  const d = repo.data;
  const state = (d.skupos ??= { promos: [], runs: [] });
  const today = localParts(now).ymd;
  const at = now.toISOString();
  const run: SkuposRun = { at, source, ...(error ? { error } : {}), created: [], updated: [], ended: [], skipped: [], active: [] };
  const setStatus = (r: ConsoleRule, status: RuleStatus) => {
    const mark = r.skupos!;
    if (r.status !== mark.setStatus) return false; // changed by hand
    if (r.status === status) return false;
    r.status = mark.setStatus = status;
    r.updatedAt = at;
    return true;
  };
  const seen = new Set<string>();
  for (const p of state.promos) {
    const existing = d.rules.find((r) => r.skupos?.promoId === p.id);
    if (existing) seen.add(existing.id);
    if (p.endsOn < today) {
      if (existing && setStatus(existing, 'retired')) run.ended.push(existing.name);
      continue;
    }
    const targets = storesFor(p, d.stores);
    if (!targets.length) {
      if (existing && setStatus(existing, 'paused')) run.ended.push(existing.name);
      run.skipped.push({ promo: `${p.brand}: ${p.title}`, reason: p.stores.length ? 'None of its stores are enrolled in Skupos and live.' : 'No store is enrolled in Skupos and live yet.' });
      continue;
    }
    const fields = ruleFields(p, targets.map((s) => s.id), d);
    if (existing) {
      const next: ConsoleRule = { ...existing, ...fields, skupos: { ...fields.skupos!, setStatus: existing.skupos!.setStatus } };
      const problems = repo.ruleBlockers(next, ADMIN);
      if (problems.length) {
        run.skipped.push({ promo: next.name, reason: problems[0]! });
        continue;
      }
      const changed = (['name', 'scope', 'schedule', 'conditions', 'effect', 'memberText', 'perMemberLimit'] as const).some((k) => !same(existing[k], next[k]));
      const reopened = existing.skupos!.setStatus !== 'active' && existing.status === existing.skupos!.setStatus;
      if (changed) next.updatedAt = at;
      d.rules[d.rules.indexOf(existing)] = next;
      if (reopened) setStatus(next, 'active');
      if (changed || reopened) run.updated.push(next.name);
    } else {
      let id = skuposRuleId(p.id);
      for (let n = 2; d.rules.some((r) => r.id === id); n++) id = `${skuposRuleId(p.id)}-${n}`;
      const rule: ConsoleRule = { ...fields, id, status: 'active', createdAt: at, updatedAt: at, createdBy: { role: 'jobber-admin', userId: 'skupos' } };
      const problems = repo.ruleBlockers(rule, ADMIN);
      if (problems.length) {
        run.skipped.push({ promo: rule.name, reason: problems[0]! });
        continue;
      }
      d.rules.push(rule);
      seen.add(id);
      run.created.push(rule.name);
    }
  }
  // Offers whose promotion is no longer on the list.
  for (const r of d.rules) if (r.skupos && !seen.has(r.id) && setStatus(r, 'retired')) run.ended.push(r.name);

  const storeName = (id: string) => d.stores.find((s) => s.id === id)?.name ?? id;
  run.active = d.rules
    .filter((r) => r.skupos && r.status === 'active' && (!r.schedule?.endsAt || Date.parse(r.schedule.endsAt) > now.getTime()))
    .map((r) => ({
      ruleId: r.id,
      name: r.name,
      endsOn: r.schedule?.endsAt ? addDays(localParts(r.schedule.endsAt).ymd, -1) : '',
      stores: r.scope.kind === 'stores' ? r.scope.storeIds.map(storeName) : [],
    }));
  state.runs = [run, ...state.runs].slice(0, MAX_RUNS);
  const parts = [
    run.created.length && `${run.created.length} new`,
    run.updated.length && `${run.updated.length} updated`,
    run.ended.length && `${run.ended.length} ended`,
  ].filter(Boolean);
  if (parts.length) repo.note({ role: 'jobber-admin', userId: 'skupos' }, `Skupos promotions: ${parts.join(', ')}`);
  repo.save();
  return run;
}

/** The daily update, uploads and the portal's Skupos page. */
export class SkuposSync {
  private running?: Promise<SkuposRun | undefined>;

  constructor(
    private readonly repo: Repo,
    private readonly clock: () => Date = () => new Date(),
    private readonly feed?: SkuposFeed,
  ) {}

  private get state(): SkuposState {
    return (this.repo.data.skupos ??= { promos: [], runs: [] });
  }

  get feedConnected(): boolean {
    return Boolean(this.feed);
  }

  /** Runs once per store-local day: reads the feed (if any), then updates the offers. */
  daily(force = false): Promise<SkuposRun | undefined> {
    const today = localParts(this.clock()).ymd;
    if (this.running) return this.running;
    if (!force && this.state.lastDailyOn === today) return Promise.resolve(undefined);
    this.running = (async () => {
      this.state.lastDailyOn = today;
      let error: string | undefined;
      if (this.feed) {
        try {
          const { promos, skipped } = await this.feed(today);
          this.state.promos = promos;
          this.state.promosFrom = { source: 'feed', at: this.clock().toISOString() };
          const run = applySkupos(this.repo, force ? 'manual' : 'feed', this.clock());
          run.skipped.unshift(...skipped);
          this.repo.save();
          return run;
        } catch (err) {
          error = `Couldn't read the Skupos feed (${(err as Error).message}). Used the last list instead.`;
          console.error('[skupos]', error);
        }
      }
      return applySkupos(this.repo, force ? 'manual' : 'daily', this.clock(), error);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  /** A promotions list uploaded in the portal replaces the current list. */
  upload(csv: string, fileName: string | undefined): SkuposRun {
    const today = localParts(this.clock()).ymd;
    const { promos, skipped } = parseSkuposCsv(csv, today);
    if (!promos.length) throw new ConsoleError(skipped[0]?.reason ?? 'No promotions were found in that file.');
    this.state.promos = promos;
    this.state.promosFrom = { source: 'upload', at: this.clock().toISOString(), ...(fileName ? { fileName: fileName.slice(0, 120) } : {}) };
    const run = applySkupos(this.repo, 'upload', this.clock());
    run.skipped.unshift(...skipped);
    this.repo.save();
    return run;
  }

  /** After a store is enrolled, unenrolled, or goes live or offline. Quiet when Skupos isn't in use. */
  storesChanged(): void {
    if (!this.state.promos.length && !this.repo.data.rules.some((r) => r.skupos)) return;
    applySkupos(this.repo, 'stores', this.clock());
  }

  /** What the portal's Skupos page shows. */
  status() {
    const d = this.repo.data;
    const now = this.clock();
    const today = localParts(now).ymd;
    const rules = new Map(d.rules.filter((r) => r.skupos).map((r) => [r.skupos!.promoId, r]));
    return {
      feedConnected: this.feedConnected,
      promosFrom: this.state.promosFrom ?? null,
      lastDailyOn: this.state.lastDailyOn ?? null,
      enrolledStores: d.stores.filter((s) => s.skuposEnrolled).map((s) => ({ id: s.id, name: s.name, live: s.loyaltyLive, skuposStoreId: s.skuposStoreId ?? null })),
      promos: this.state.promos.map((p) => {
        const r = rules.get(p.id);
        const state = p.endsOn < today ? 'Ended' : !r ? 'Not in the app' : r.status !== 'active' ? (r.status === 'paused' ? 'Paused' : 'Retired') : p.startsOn > today ? 'Scheduled' : 'Live';
        return {
          ...p,
          ruleId: r?.id ?? null,
          state,
          storeNames: r && r.scope.kind === 'stores' ? r.scope.storeIds.map((id) => d.stores.find((s) => s.id === id)?.name ?? id) : [],
        };
      }),
      runs: this.state.runs.slice(0, 30),
    };
  }
}
