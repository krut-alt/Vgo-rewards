// The items catalog: a pricebook export (CSV) uploaded in the console. Item rewards will point at
// these SKUs and UPCs later, so the POS lines they ring up can be matched exactly.
import { CATEGORIES } from './catalog.js';
import type { ConsoleData, ItemUpload } from './model.js';
import { ConsoleError } from './repo.js';

export interface CatalogItem {
  sku: string;
  upc?: string;
  name: string;
  /** Our category id when the department matches one, so offers by category work too. */
  category?: string;
  /** The department as the pricebook names it. */
  department?: string;
  priceCents?: number;
}

export interface ItemCatalog {
  items: CatalogItem[];
  uploadedAt: string;
  fileName?: string;
}

export const MAX_ITEMS = 50_000;

// Column names seen in Modisoft, Verifone and Gilbarco pricebook exports.
const COLUMNS: Record<keyof CatalogItem, RegExp> = {
  sku: /^(sku|item ?(code|number|no|#|id)|plu|product ?(code|id))$/,
  upc: /^(upc|upc ?code|barcode|scan ?code|gtin|ean)$/,
  name: /^(name|description|item ?(name|description)|product ?name|desc)$/,
  department: /^(category|department|dept|dept ?name|department ?name|group)$/,
  category: /^$/,
  priceCents: /^(price|retail|retail ?price|unit ?price|sell ?price|current ?price)$/,
};

/** Splits CSV text into rows, handling quotes and commas or tabs. */
export function csvRows(text: string): string[][] {
  const sep = text.split('\n', 1)[0]!.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      (row = []), (cell = '');
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export function categoryFor(department: string): string | undefined {
  const d = department.toLowerCase().trim();
  if (!d) return undefined;
  return CATEGORIES.find((c) => c.label.toLowerCase() === d || c.id === d || (c.words as readonly string[]).some((w) => d === w || d.includes(w)))?.id;
}

/** Reads a pricebook CSV. Rows without a SKU or UPC are skipped and counted. */
export function parseItemsCsv(text: string): { items: CatalogItem[]; skipped: number } {
  const rows = csvRows(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new ConsoleError('That file has no item rows. It needs a header row and one row per item.');
  const header = rows[0]!.map((h) => h.trim().toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' '));
  const col = (k: keyof CatalogItem) => header.findIndex((h) => COLUMNS[k].test(h));
  const at = { sku: col('sku'), upc: col('upc'), name: col('name'), department: col('department'), price: col('priceCents') };
  if (at.sku < 0 && at.upc < 0) throw new ConsoleError('Add a SKU or UPC column to the file. The first row should name the columns, like SKU, UPC, Name, Department, Price.');
  if (at.name < 0) throw new ConsoleError('Add a Name or Description column to the file.');
  if (rows.length - 1 > MAX_ITEMS) throw new ConsoleError(`That file has more than ${MAX_ITEMS.toLocaleString()} items. Split it and upload the parts.`);

  const bySku = new Map<string, CatalogItem>();
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const upc = get(at.upc).replace(/\D/g, '');
    const sku = get(at.sku) || upc;
    const name = get(at.name);
    if (!sku || !name) {
      skipped++;
      continue;
    }
    const department = get(at.department);
    const price = Number(get(at.price).replace(/[$,]/g, ''));
    bySku.set(sku, {
      sku,
      ...(upc ? { upc } : {}),
      name: name.slice(0, 120),
      ...(department ? { department: department.slice(0, 60) } : {}),
      ...(categoryFor(department) ? { category: categoryFor(department) } : {}),
      ...(get(at.price) && Number.isFinite(price) ? { priceCents: Math.round(price * 100) } : {}),
    });
  }
  if (!bySku.size) throw new ConsoleError('No rows had both a SKU or UPC and a name.');
  return { items: [...bySku.values()], skipped };
}

/** Searches by name, SKU, UPC or department. */
export function searchItems(catalog: ItemCatalog | undefined, q: string, limit = 200): { total: number; items: CatalogItem[] } {
  const items = catalog?.items ?? [];
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? items.filter((i) => i.name.toLowerCase().includes(needle) || i.sku.toLowerCase().includes(needle) || i.upc?.includes(needle) || i.department?.toLowerCase().includes(needle))
    : items;
  return { total: hits.length, items: hits.slice(0, limit) };
}

/** The key in `currentItems` for the list every store uses unless it has its own. */
export const ALL_STORES = '*';

/** The item list a store uses: its own upload, else the all-stores list. No store means the all-stores list. */
export function catalogFor(d: ConsoleData, storeId?: string): ItemCatalog | undefined {
  const id = (storeId && d.currentItems?.[storeId]) || d.currentItems?.[ALL_STORES];
  return id ? d.itemLists?.[id] : d.items;
}

/** Every current list together (first one wins for a SKU), for matching item names across the chain. */
export function everyItem(d: ConsoleData): ItemCatalog | undefined {
  const ids = [...new Set(Object.values(d.currentItems ?? {}))];
  if (!ids.length) return d.items;
  const bySku = new Map<string, CatalogItem>();
  for (const id of ids) for (const i of d.itemLists?.[id]?.items ?? []) if (!bySku.has(i.sku)) bySku.set(i.sku, i);
  return { items: [...bySku.values()], uploadedAt: '' };
}

/** Records an upload and makes it current for its stores (or for all stores). Lists nobody uses are dropped. */
export function addItemUpload(
  d: ConsoleData,
  items: CatalogItem[],
  meta: { id: string; fileName?: string; storeIds: string[]; at: string; by: string; skipped: number; fileKept: boolean },
): ItemUpload {
  const unknown = meta.storeIds.find((id) => !d.stores.some((s) => s.id === id));
  if (unknown) throw new ConsoleError(`Unknown store ${unknown}.`);
  // The old single catalog becomes an ordinary all-stores list first.
  if (d.items && !d.currentItems) {
    d.itemLists = { legacy: d.items };
    d.currentItems = { [ALL_STORES]: 'legacy' };
  }
  delete d.items;
  d.itemLists ??= {};
  d.currentItems ??= {};
  d.itemLists[meta.id] = { items, uploadedAt: meta.at, ...(meta.fileName ? { fileName: meta.fileName } : {}) };
  for (const key of meta.storeIds.length ? meta.storeIds : [ALL_STORES]) d.currentItems[key] = meta.id;
  const inUse = new Set(Object.values(d.currentItems));
  for (const id of Object.keys(d.itemLists)) if (!inUse.has(id)) delete d.itemLists[id];
  const upload: ItemUpload = { id: meta.id, ...(meta.fileName ? { fileName: meta.fileName } : {}), uploadedAt: meta.at, uploadedBy: meta.by, storeIds: meta.storeIds, count: items.length, skipped: meta.skipped, fileKept: meta.fileKept };
  d.itemUploads = [...(d.itemUploads ?? []), upload].slice(-500);
  return upload;
}

/** A store goes back to the all-stores list. */
export function clearStoreItems(d: ConsoleData, storeId: string): void {
  if (!d.currentItems?.[storeId]) return;
  delete d.currentItems[storeId];
  const inUse = new Set(Object.values(d.currentItems));
  for (const id of Object.keys(d.itemLists ?? {})) if (!inUse.has(id)) delete d.itemLists![id];
}
