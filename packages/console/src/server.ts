// Console API and web server. With an admin password set, the portal needs a sign-in and store
// users only see their own locations; without one (local development) everyone is the admin.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { inScope, type Actor, type RuleStatus, type Transaction } from '../../engine/src/index.js';
import { CATEGORIES, FUEL_GRADES } from './catalog.js';
import { ruleChecks } from './checks.js';
import { localParts } from './dates.js';
import { DRAFT_EXAMPLES, draftRule } from './drafter.js';
import { setFuelPricesByHand } from './fuel-prices.js';
import {
  displayStatus,
  fundedLabel,
  memberLine,
  rewardLabel,
  runsLabel,
  targetLabel,
  typeLabel,
} from './labels.js';
import type { ConsoleData, ConsoleRule, ConsoleStore, PortalUser } from './model.js';
import { MemberApi, offerKind, promoHeadline } from './member-api.js';
import { PortalAuthService, type SignedIn } from './portal-auth.js';
import { adapterFor } from './pos/adapters.js';
import { PosLink } from './pos/link.js';
import { PRESETS } from './presets.js';
import { ConsoleError, Repo, withoutNulls, type RuleInput } from './repo.js';
import { spotFrom } from './geo.js';
import { storeSpotFiller, type Geocoder } from './geocode.js';
import { mediaUrl, memoryMediaStore, readUpload, type MediaStore } from './media.js';
import { addItemUpload, ALL_STORES, catalogFor, clearStoreItems, everyItem, parseItemsCsv, searchItems } from './items.js';
import { computeResults } from './results.js';
import { ADMIN } from './seed.js';
import { SkuposSync, type SkuposFeed } from './skupos.js';
import { closeMonths, PERIOD_KINDS, recloseMonth, statementCsv, statementFor, statementPdf, type PeriodKind } from './statements.js';
import { STOCK_ART, pickStockArt, stockArtFor, stockArtUrl } from './stock-art.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
};

export function ruleView(repo: Repo, rule: ConsoleRule, now = new Date()) {
  const { stores, groups } = repo.data;
  const stock = stockArtFor(rule, everyItem(repo.data));
  return {
    ...rule,
    display: {
      status: displayStatus(rule, now),
      type: typeLabel(rule),
      target: `${targetLabel(rule.scope, stores, groups)}${rule.geofence ? ` · within ${rule.geofence.radiusMiles} mi` : ''}`,
      runs: runsLabel(rule),
      funded: fundedLabel(rule),
      reward: rewardLabel(rule),
      memberLine: memberLine(rule),
      headline: promoHeadline(rule),
      artKind: offerKind(rule),
      imageUrl: rule.artwork ? mediaUrl(rule.artwork.mediaId) : null,
      stockArt: stock ? { id: stock.id, title: stock.title, url: stockArtUrl(stock.id) } : null,
      autoStockArt: pickStockArt(rule, everyItem(repo.data)).id,
    },
  };
}

async function body<T>(req: IncomingMessage, limit = 2_000_000): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ConsoleError('Request is too large.', 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new ConsoleError('Request body is not valid JSON.');
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

/** Fills in store-local hour and weekday when the POS link only sends a timestamp. */
function withLocalTime(tx: Transaction): Transaction {
  if (!tx || typeof tx.at !== 'string' || Number.isNaN(Date.parse(tx.at))) throw new ConsoleError('Transaction needs a valid "at" time.');
  if (!tx.id || !tx.storeId) throw new ConsoleError('Transaction needs an id and a storeId.');
  const p = localParts(tx.at);
  return { ...tx, items: tx.items ?? [], localHour: tx.localHour ?? p.hour, localDayOfWeek: tx.localDayOfWeek ?? p.dayOfWeek, localDate: tx.localDate ?? p.ymd };
}

export interface AppOptions {
  clock?: () => Date;
  /** Folder with the customer app, served at /app/. */
  appDir?: string;
  memberApi?: MemberApi;
  /** When set, the portal needs a sign-in; "admin" plus this password is the master admin. The member app stays open. */
  adminPassword?: string;
  /** Key the POS link sends as `Authorization: Bearer <key>` to reach /api/pos. */
  posKey?: string;
  /** Which vendor's wire format /api/pos/link speaks (pos/adapters.ts). Defaults to our own, `vgo`. */
  posLinkAdapter?: string;
  /** Where reward artwork is kept. Defaults to memory (tests and local tries). */
  media?: MediaStore;
  /** Finds map spots for stores from their addresses. Off in tests. */
  geocoder?: Geocoder;
  /** Where the daily Skupos update reads the current promotions; without it, the last uploaded list is used. */
  skuposFeed?: SkuposFeed;
  /** Runs the Skupos update once a day on its own (at start-up, hourly checks and on portal use). Off in tests. */
  skuposDaily?: boolean;
  /** Closes each month's site statements on their own (hourly checks and on portal use). Off in tests. */
  autoClose?: boolean;
}

const COOKIE = 'vgo_portal';

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Store ids this person may see, or undefined for admins (everything). */
function visibleStores(who: SignedIn): string[] | undefined {
  return who.user.role === 'admin' ? undefined : who.user.storeIds;
}

/** Members a store user may see: their locations' sign-ups plus anyone who visited them. */
function visibleMemberIds(data: ConsoleData, storeIds: string[]): Set<string> {
  const ids = new Set(data.members.filter((m) => m.homeStoreId && storeIds.includes(m.homeStoreId)).map((m) => m.id));
  for (const e of data.ledger) if (e.memberId && storeIds.includes(e.tx.storeId)) ids.add(e.memberId);
  return ids;
}

export function createApp(repo: Repo, publicDir: string, options: AppOptions | (() => Date) = {}) {
  const opts = typeof options === 'function' ? { clock: options } : options;
  const clock = opts.clock ?? (() => new Date());
  const members = opts.memberApi ?? new MemberApi(repo, undefined, clock);
  const media = opts.media ?? memoryMediaStore();
  const fillSpots = opts.geocoder ? storeSpotFiller(repo, opts.geocoder) : undefined;
  void fillSpots?.();
  // Recently shown artwork, so the app doesn't fetch the same image from storage on every view.
  const mediaCache = new Map<string, Buffer>();
  const portal = opts.adminPassword ? new PortalAuthService(repo, opts.adminPassword, clock) : undefined;
  const posLink = new PosLink(repo, clock);
  const posAdapter = adapterFor(opts.posLinkAdapter);
  const skupos = new SkuposSync(repo, clock, opts.skuposFeed);
  // Free hosts sleep when idle, so besides the hourly check the update also runs on the first portal visit of the day.
  const skuposDaily = () => void skupos.daily().catch((err) => console.error('[skupos]', err));
  if (opts.skuposDaily) {
    skuposDaily();
    setInterval(skuposDaily, 60 * 60 * 1000).unref();
  }
  // Each month's statements freeze on the 2nd of the next month, checked hourly and on portal use (free hosts sleep).
  const closeDue = () => {
    const started = Boolean(repo.data.statementsSince);
    const closed = closeMonths(repo.data, clock());
    if (!started) repo.save();
    if (!closed.length) return;
    repo.note({ role: 'jobber-admin', userId: 'statements' }, `Closed site statements for ${closed.join(', ')}`);
    repo.save();
  };
  if (opts.autoClose) {
    closeDue();
    setInterval(closeDue, 60 * 60 * 1000).unref();
  }
  // Without a portal password (local development) everyone is the master admin.
  const OPEN: SignedIn = { actor: ADMIN, user: { id: 'master', name: 'Jobber admin', email: 'admin', role: 'admin', storeIds: [] } };

  async function api(req: IncomingMessage, url: URL, who: SignedIn): Promise<[number, unknown]> {
    const path = url.pathname.replace(/^\/api/, '');
    const m = (pattern: RegExp) => pattern.exec(path);
    const method = req.method ?? 'GET';
    const actor = who.actor;
    const mine = visibleStores(who);
    const isAdmin = !mine;
    const adminOnly = () => {
      if (!isAdmin) throw new ConsoleError('Only an admin can do that.', 403);
    };
    const myStores = () => (mine ? repo.data.stores.filter((s) => mine.includes(s.id)) : repo.data.stores);
    // Store users see corporate rules that reach their locations plus their own offers.
    const ruleVisible = (r: ConsoleRule) => isAdmin || myStores().some((s) => inScope(r.scope, s));
    const views = () => repo.data.rules.filter(ruleVisible).map((r) => ruleView(repo, r, clock()));
    const memberVisible = (() => {
      let ids: Set<string> | undefined;
      return (id: string) => isAdmin || (ids ??= visibleMemberIds(repo.data, mine!)).has(id);
    })();
    let match: RegExpExecArray | null;

    if (opts.skuposDaily) skuposDaily();
    if (opts.autoClose) closeDue();
    if (method === 'GET' && path === '/me') return [200, { user: who.user, signInRequired: Boolean(portal) }];

    if (method === 'GET' && path === '/bootstrap') {
      const d = repo.data;
      return [
        200,
        {
          actor,
          me: who.user,
          branding: d.branding,
          settings: d.settings,
          stores: myStores(),
          groups: isAdmin ? d.groups : [],
          rules: views(),
          presets: PRESETS,
          categories: CATEGORIES.map(({ id, label }) => ({ id, label })),
          stockArt: STOCK_ART.map(({ id, title }) => ({ id, title, url: stockArtUrl(id) })),
          grades: FUEL_GRADES.map(({ id, label }) => ({ id, label })),
          draftExamples: DRAFT_EXAMPLES,
          pilot: d.pilot,
          signInRequired: Boolean(portal),
        },
      ];
    }
    if (method === 'GET' && path === '/rules') return [200, views()];
    if (method === 'POST' && path === '/rules') {
      const rule = repo.createRule(await body<RuleInput>(req), actor);
      return [201, ruleView(repo, rule, clock())];
    }
    if (method === 'POST' && path === '/rules/check') {
      const input = withoutNulls(await body<RuleInput>(req));
      const now = clock().toISOString();
      const rule = { ...input, id: input.id ?? 'new', createdAt: now, updatedAt: now, createdBy: actor } as ConsoleRule;
      const { blockers, checks } = ruleChecks(repo, rule, actor);
      return [200, { blockers, checks, view: blockers.length ? null : ruleView(repo, rule, clock()) }];
    }
    if (method === 'POST' && path === '/rules/draft') {
      const { text } = await body<{ text?: string }>(req);
      const draft = draftRule(String(text ?? ''), { stores: repo.data.stores, groups: repo.data.groups, now: clock() });
      if (!draft.ok) return [200, draft];
      const now = clock().toISOString();
      const view = ruleView(repo, { ...draft.rule, id: 'draft', createdAt: now, updatedAt: now, createdBy: actor }, clock());
      return [200, { ...draft, view }];
    }
    if ((match = m(/^\/rules\/([\w-]+)$/))) {
      const id = match[1]!;
      if (method === 'GET') {
        const rule = repo.rule(id);
        if (!ruleVisible(rule)) throw new ConsoleError('Rule not found.', 404);
        return [200, ruleView(repo, rule, clock())];
      }
      if (method === 'PUT') return [200, ruleView(repo, repo.updateRule(id, await body<Partial<RuleInput>>(req), actor), clock())];
    }
    if (method === 'POST' && (match = m(/^\/rules\/([\w-]+)\/status$/))) {
      const { status } = await body<{ status: RuleStatus }>(req);
      return [200, ruleView(repo, repo.setRuleStatus(match[1]!, status, actor), clock())];
    }

    if (method === 'GET' && path === '/stores') return [200, { stores: myStores(), groups: isAdmin ? repo.data.groups : [] }];
    if (method === 'PUT' && (match = m(/^\/stores\/([\w-]+)$/))) {
      const store = await body<ConsoleStore>(req);
      const saved = repo.upsertStore({ ...withoutNulls(store), id: match[1]! } as ConsoleStore, actor);
      void fillSpots?.();
      skupos.storesChanged();
      return [200, saved];
    }
    if (method === 'DELETE' && (match = m(/^\/stores\/([\w-]+)$/))) {
      repo.deleteStore(match[1]!, actor);
      skupos.storesChanged();
      return [200, { ok: true }];
    }
    // Gas prices shown in the app, typed in by hand. The POS link keeps them current once it is live.
    if (method === 'PUT' && (match = m(/^\/stores\/([\w-]+)\/fuel-prices$/))) {
      const store = myStores().find((s) => s.id === match![1]);
      if (!store) throw new ConsoleError('Location not found.', 404);
      const { prices } = await body<{ prices?: Record<string, unknown> }>(req);
      setFuelPricesByHand(store, prices ?? {}, clock().toISOString());
      repo.note(actor, `Updated gas prices at ${store.name}`);
      repo.save();
      return [200, store];
    }
    if (method === 'POST' && (match = m(/^\/stores\/([\w-]+)\/live$/))) {
      const { live } = await body<{ live?: unknown }>(req);
      const saved = repo.setStoreLive(match[1]!, Boolean(live), actor);
      skupos.storesChanged();
      return [200, saved];
    }
    if (method === 'POST' && path === '/stores') {
      const store = await body<ConsoleStore>(req);
      const saved = repo.upsertStore({ ...withoutNulls(store), id: '' } as ConsoleStore, actor);
      void fillSpots?.();
      skupos.storesChanged();
      return [201, saved];
    }
    if (method === 'POST' && path === '/groups') {
      const { id, name, storeIds } = await body<{ id?: string; name: string; storeIds?: string[] }>(req);
      return [200, repo.upsertGroup({ id: id ?? '', name }, storeIds, actor)];
    }

    if (method === 'GET' && path === '/members') {
      const raw = (url.searchParams.get('q') ?? '').toLowerCase().trim();
      const q = raw.replace(/[^\w ]/g, '');
      const digits = q.replace(/\D/g, '');
      const list = repo.data.members.filter(
        (mm) =>
          memberVisible(mm.id) &&
          (!q || mm.name.toLowerCase().includes(q) || (digits.length >= 3 && mm.phone.includes(digits)) || (raw.includes('@') && Boolean(mm.email?.includes(raw)))),
      );
      return [200, { total: list.length, members: list.slice(-200).reverse() }];
    }
    if (method === 'POST' && path === '/members') {
      const input = await body<{ homeStoreId?: string; name: string; phone: string }>(req);
      if (mine && !(input.homeStoreId && mine.includes(input.homeStoreId))) input.homeStoreId = mine[0];
      return [201, repo.createMember(input, actor)];
    }
    if ((match = m(/^\/members\/([\w-]+)$/)) && method === 'GET') {
      const member = repo.member(match[1]!);
      if (!memberVisible(member.id)) throw new ConsoleError('Member not found.', 404);
      const visits = repo.data.ledger
        .filter((e) => e.memberId === member.id && (!mine || mine.includes(e.tx.storeId)))
        .slice(-20)
        .reverse();
      return [200, { member, visits }];
    }
    if (method === 'POST' && (match = m(/^\/members\/([\w-]+)\/points$/))) {
      const { delta, reason } = await body<{ delta: number; reason: string }>(req);
      if (!memberVisible(match[1]!)) throw new ConsoleError('Member not found.', 404);
      return [200, repo.adjustPoints(match[1]!, Number(delta), String(reason ?? ''), actor)];
    }

    if (method === 'PUT' && (match = m(/^\/members\/([\w-]+)\/birth-date$/))) {
      // Members set their date of birth once; a store fixes it after checking ID.
      const { birthDate } = await body<{ birthDate?: string }>(req);
      if (!memberVisible(match[1]!)) throw new ConsoleError('Member not found.', 404);
      const member = repo.member(match[1]!);
      members.setBirthDate(member, birthDate);
      repo.note(actor, `Changed the date of birth for ${member.name}`);
      return [200, member];
    }

    if (method === 'PUT' && path === '/settings') return [200, repo.updateSettings(await body(req), actor)];
    if (method === 'PUT' && path === '/branding') return [200, repo.updateBranding(await body(req), actor)];
    if (method === 'GET' && path === '/results') {
      const view = url.searchParams.get('view') === 'all' ? 'all' : 'pilot';
      return [200, computeResults(repo.data, mine ? 'all' : view, clock(), mine)];
    }
    // Site statements: any period; months close and freeze on their own. Store users see only their sites.
    if (method === 'GET' && (path === '/statements' || path === '/statements/csv' || path === '/statements/pdf')) {
      const kind = (url.searchParams.get('period') ?? 'month') as PeriodKind;
      if (!PERIOD_KINDS.includes(kind)) throw new ConsoleError('Pick day, week, month, quarter or year.');
      const date = url.searchParams.get('date') || localParts(clock()).ymd;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ConsoleError('Dates look like 2026-10-01.');
      // Downloads can be for one site; a store user can only ask for their own.
      const one = url.searchParams.get('store');
      if (one && !myStores().some((s) => s.id === one)) throw new ConsoleError('Location not found.', 404);
      const st = statementFor(repo.data, kind, date, one ? [one] : mine);
      if (path === '/statements') return [200, st];
      const site = one ? `-${one}` : '';
      if (path === '/statements/csv') return [200, { fileName: `vgo-statement-${kind}-${st.period.start}${site}.csv`, csv: statementCsv(st) }];
      const pdf = Buffer.from(statementPdf(st, repo.data, clock()));
      return [200, { fileName: `vgo-statement-${kind}-${st.period.start}${site}.pdf`, pdfBase64: pdf.toString('base64') }];
    }
    if (method === 'POST' && (match = m(/^\/statements\/(\d{4}-\d{2})\/reclose$/))) {
      adminOnly();
      const month = match[1]!;
      if (!repo.data.closedMonths?.some((c) => c.month === month)) throw new ConsoleError('That month isn’t closed yet.', 404);
      recloseMonth(repo.data, month, clock());
      repo.note(actor, `Closed the ${month} statements again with current numbers`);
      repo.save();
      return [200, statementFor(repo.data, 'month', `${month}-01`)];
    }
    if (method === 'GET' && path === '/history') {
      adminOnly();
      return [200, repo.data.history.slice(0, 200)];
    }
    if (method === 'GET' && path === '/media') return [200, [...(repo.data.media ?? [])].reverse()];
    if (method === 'POST' && path === '/media') {
      const { dataUrl, name } = await body<{ dataUrl?: string; name?: string }>(req, 3_000_000);
      const { info, bytes } = readUpload(dataUrl, name, actor.userId, clock());
      await media.put(info.id, bytes);
      mediaCache.set(info.id, bytes);
      (repo.data.media ??= []).push(info);
      repo.note(actor, `Uploaded artwork "${info.name}"`);
      repo.save();
      return [201, info];
    }
    if (method === 'DELETE' && (match = m(/^\/media\/(\w+)$/))) {
      adminOnly();
      const id = match[1]!;
      const users = repo.data.rules.filter((r) => r.artwork?.mediaId === id);
      if (users.length) throw new ConsoleError(`"${users[0]!.name}" uses this artwork. Change its artwork first.`, 409);
      const site = repo.data.stores.find((s) => s.photoMediaId === id);
      if (site) throw new ConsoleError(`${site.name} uses this picture as its store photo. Change it on the Locations page first.`, 409);
      const info = repo.data.media?.find((x) => x.id === id);
      if (!info) throw new ConsoleError('Artwork not found.', 404);
      repo.data.media = repo.data.media!.filter((x) => x.id !== id);
      await media.remove(id);
      mediaCache.delete(id);
      repo.note(actor, `Removed artwork "${info.name}"`);
      repo.save();
      return [200, { ok: true }];
    }
    // Item lists (pricebooks). An upload goes to chosen stores or to all stores; a store with its own
    // list uses it, the rest use the all-stores list. Every upload is kept in the history, with its file.
    if (method === 'GET' && path === '/items') {
      adminOnly();
      const store = url.searchParams.get('store') || ALL_STORES;
      if (store !== ALL_STORES) repo.store(store);
      const d = repo.data;
      const c = store === ALL_STORES ? catalogFor(d) : catalogFor(d, store);
      const ownList = store !== ALL_STORES && !!d.currentItems?.[store];
      const uploads = (d.itemUploads ?? [])
        .filter((u) => store === ALL_STORES || !u.storeIds.length || u.storeIds.includes(store))
        .map((u) => ({ ...u, current: Object.entries(d.currentItems ?? {}).filter(([, id]) => id === u.id).map(([k]) => k) }))
        .reverse();
      const storeLists = Object.entries(d.currentItems ?? {})
        .filter(([k]) => k !== ALL_STORES)
        .map(([storeId, id]) => ({ storeId, uploadedAt: d.itemLists?.[id]?.uploadedAt ?? null, count: d.itemLists?.[id]?.items.length ?? 0 }));
      return [
        200,
        { ...searchItems(c, url.searchParams.get('q') ?? ''), store, ownList, count: c?.items.length ?? 0, uploadedAt: c?.uploadedAt || null, fileName: c?.fileName ?? null, uploads, storeLists },
      ];
    }
    if (method === 'POST' && path === '/items/upload') {
      adminOnly();
      const { csv, fileName, storeIds } = await body<{ csv?: string; fileName?: string; storeIds?: unknown }>(req, 15_000_000);
      if (storeIds !== undefined && (!Array.isArray(storeIds) || storeIds.some((x) => typeof x !== 'string'))) throw new ConsoleError('Choose the stores as a list.');
      const targets = [...new Set(storeIds as string[] | undefined)];
      for (const id of targets) repo.store(id);
      const text = String(csv ?? '');
      const { items, skipped } = parseItemsCsv(text);
      const id = `items-${randomUUID().slice(0, 12)}`;
      const at = clock().toISOString();
      const name = fileName ? String(fileName).slice(0, 120) : undefined;
      // The original file is kept (zipped) beside the artwork, so any upload can be downloaded later.
      const fileKept = await media.put(id, gzipSync(text)).then(() => true, (err) => (console.error('[items] could not keep the file:', err), false));
      const upload = addItemUpload(repo.data, items, { id, fileName: name, storeIds: targets, at, by: who.user.id, skipped, fileKept });
      const where = upload.storeIds.length ? upload.storeIds.map((s) => repo.store(s).name).join(', ') : 'all stores';
      repo.note(actor, `Uploaded ${items.length.toLocaleString()} items for ${where}${name ? ` from ${name}` : ''}`);
      repo.save();
      return [200, { count: items.length, skipped, upload }];
    }
    if (method === 'GET' && (match = m(/^\/items\/uploads\/([\w-]+)\/file$/))) {
      adminOnly();
      const u = repo.data.itemUploads?.find((x) => x.id === match![1]);
      const bytes = u?.fileKept ? await media.get(u.id) : undefined;
      if (!u || !bytes) throw new ConsoleError('That file was not kept.', 404);
      return [200, { fileName: u.fileName ?? `items-${u.uploadedAt.slice(0, 10)}.csv`, csv: gunzipSync(bytes).toString('utf8') }];
    }
    if (method === 'DELETE' && (match = m(/^\/items\/stores\/([\w-]+)$/))) {
      adminOnly();
      const store = repo.store(match[1]!);
      clearStoreItems(repo.data, store.id);
      repo.note(actor, `${store.name} now uses the all-stores item list`);
      repo.save();
      return [200, { ok: true }];
    }
    // Skupos promotions: what is running, the daily log, an uploaded list, and "update now".
    if (method === 'GET' && path === '/skupos') {
      adminOnly();
      return [200, skupos.status()];
    }
    if (method === 'POST' && path === '/skupos/upload') {
      adminOnly();
      const { csv, fileName } = await body<{ csv?: string; fileName?: string }>(req, 5_000_000);
      const run = skupos.upload(String(csv ?? ''), fileName ? String(fileName) : undefined);
      repo.note(actor, `Uploaded the Skupos promotions list${fileName ? ` ${String(fileName).slice(0, 120)}` : ''}`);
      repo.save();
      return [200, { run, status: skupos.status() }];
    }
    if (method === 'POST' && path === '/skupos/run') {
      adminOnly();
      const run = await skupos.daily(true);
      return [200, { run, status: skupos.status() }];
    }
    if (method === 'GET' && path === '/users') {
      adminOnly();
      return [200, portal ? portal.users() : []];
    }
    if ((method === 'POST' && path === '/users') || (method === 'PUT' && (match = m(/^\/users\/([\w-]+)$/)))) {
      if (!portal) throw new ConsoleError('Portal sign-in is off here, so there are no users to manage. Set VGO_ADMIN_PASSWORD to turn it on.');
      const input = await body<Partial<PortalUser> & { password?: string }>(req);
      return [method === 'POST' ? 201 : 200, portal.saveUser({ ...input, id: match?.[1] }, actor)];
    }
    if (method === 'DELETE' && (match = m(/^\/users\/([\w-]+)$/))) {
      if (!portal) throw new ConsoleError('Portal sign-in is off here.');
      portal.removeUser(match[1]!, actor);
      return [200, { ok: true }];
    }
    if (method === 'POST' && path === '/sample/clear') {
      repo.clearSampleData(actor);
      return [200, { ok: true }];
    }

    // What the POS link calls. `preview` answers "what does this member get" before payment;
    // `transactions` records the finished sale. The member is given either as our `memberId` or as
    // `loyaltyId`: the phone number typed on the PIN pad or the scanned app barcode.
    // The certified POS link (see pos/link.ts), through the adapter for the chosen vendor.
    if (method === 'POST' && (match = m(/^\/pos\/link\/(\w+)$/))) {
      return [200, posAdapter.write(posLink.handle(posAdapter.read(match[1]!, await body(req))))];
    }
    if (method === 'GET' && path === '/pos/feed') {
      const limit = url.searchParams.get('limit');
      return [200, posLink.feed({ after: url.searchParams.get('after') ?? undefined, siteId: url.searchParams.get('siteId') ?? undefined, limit: limit ? Number(limit) : undefined })];
    }
    if (method === 'POST' && (path === '/pos/preview' || path === '/pos/transactions')) {
      const { tx, memberId, loyaltyId } = await body<{ tx: Transaction; memberId?: string; loyaltyId?: string }>(req);
      const id = memberId || (loyaltyId ? repo.memberByLoyaltyId(loyaltyId).id : undefined);
      return path === '/pos/preview' ? [200, repo.preview(withLocalTime(tx), id)] : [201, repo.recordTransaction(withLocalTime(tx), id)];
    }
    throw new ConsoleError('Not found.', 404);
  }

  /** The customer app's API. Everything after sign-in acts only on the signed-in member. */
  async function appApi(req: IncomingMessage, url: URL): Promise<[number, unknown]> {
    const path = url.pathname.replace(/^\/api\/app/, '');
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/config') return [200, members.config()];
    if (method === 'GET' && path === '/program') return [200, members.programFacts()];
    if (method === 'POST' && path === '/code') {
      const { phone } = await body<{ phone?: string }>(req);
      return [200, await members.requestCode(phone)];
    }
    if (method === 'POST' && path === '/verify') {
      const { phone, code, firstName, smsOptIn, homeStoreId, email, emailOptIn, birthDate } = await body<Record<string, string | boolean | undefined>>(req);
      const result = members.verify(phone, code, {
        firstName: firstName as string,
        smsOptIn: Boolean(smsOptIn),
        homeStoreId: homeStoreId as string,
        email: email as string,
        emailOptIn: Boolean(emailOptIn),
        birthDate: birthDate as string,
      });
      return [200, result];
    }

    const member = members.memberFor(req.headers.authorization);
    let match: RegExpExecArray | null;
    if (method === 'GET' && path === '/me') return [200, members.home(member)];
    if (method === 'PUT' && path === '/me') {
      members.updateAccount(member, await body(req));
      return [200, members.home(member)];
    }
    if (method === 'GET' && path === '/offers') {
      const at = spotFrom(url.searchParams.get('lat'), url.searchParams.get('lng'));
      return [200, members.offers(member, url.searchParams.get('storeId') ?? undefined, at)];
    }
    if ((match = /^\/offers\/([\w-]+)\/clip$/.exec(path)) && (method === 'POST' || method === 'DELETE')) {
      const { lat, lng } = method === 'POST' ? await body<{ lat?: unknown; lng?: unknown }>(req) : {};
      return [200, { clippedRuleIds: members.setClip(member, match[1]!, method === 'POST', spotFrom(lat, lng)) }];
    }
    if (method === 'PUT' && path === '/redeem') {
      const { ruleIds } = await body<{ ruleIds?: unknown }>(req);
      return [200, members.setRedeem(member, ruleIds)];
    }
    if (method === 'GET' && path === '/visits') return [200, members.visits(member)];
    if (method === 'GET' && path === '/stores') return [200, members.storeLocator(member)];
    if (method === 'GET' && path === '/history') return [200, members.history(member, url.searchParams.get('before') ?? undefined)];
    if (method === 'POST' && path === '/signout') {
      members.signOut(req.headers.authorization);
      return [200, { ok: true }];
    }
    throw new ConsoleError('Not found.', 404);
  }

  async function serveFile(res: ServerResponse, dir: string, rel: string): Promise<boolean> {
    const file = normalize(join(dir, rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel));
    if (!file.startsWith(dir)) return false;
    const content = await readFile(file).catch(() => null);
    if (!content) return false;
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(content);
    return true;
  }

  const root = resolve(publicDir);
  const appRoot = opts.appDir ? resolve(opts.appDir) : undefined;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/app/')) {
        const [status, data] = await appApi(req, url);
        return send(res, status, data);
      }
      if (url.pathname.startsWith('/api/')) {
        const path = url.pathname;
        const secure = req.headers['x-forwarded-proto'] === 'https';
        const setCookie = (value: string, maxAge: number) =>
          res.setHeader('set-cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
        if (path === '/api/login' && req.method === 'POST') {
          if (!portal) return send(res, 200, { user: OPEN.user });
          const { email, password } = await body<{ email?: string; password?: string }>(req);
          const { token, signedIn } = portal.signIn(email, password);
          setCookie(encodeURIComponent(token), 14 * 86_400);
          return send(res, 200, { user: signedIn.user });
        }
        if (path === '/api/logout' && req.method === 'POST') {
          portal?.signOut(cookie(req, COOKIE));
          setCookie('', 0);
          return send(res, 200, { ok: true });
        }
        let who = portal ? portal.fromToken(cookie(req, COOKIE)) : OPEN;
        // The POS link signs its calls with the POS key instead of a portal sign-in.
        if (!who && path.startsWith('/api/pos/') && opts.posKey) {
          const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
          if (key && sameSecret(key, opts.posKey)) who = OPEN;
        }
        if (!who) return send(res, 401, { error: 'Please sign in.' });
        if (path.startsWith('/api/pos/') && who.user.role !== 'admin') return send(res, 403, { error: 'Only the POS link or an admin can do that.' });
        const [status, data] = await api(req, url, who);
        return send(res, status, data);
      }
      const art = /^\/media\/(\w+)$/.exec(url.pathname);
      if (art && req.method === 'GET') {
        const info = repo.data.media?.find((x) => x.id === art[1]);
        let bytes = info && mediaCache.get(info.id);
        if (info && !bytes) {
          bytes = await media.get(info.id);
          if (bytes) {
            if (mediaCache.size >= 200) mediaCache.delete(mediaCache.keys().next().value!);
            mediaCache.set(info.id, bytes);
          }
        }
        if (!info || !bytes) return send(res, 404, { error: 'Not found.' });
        // Ids are never reused, so the image can be cached for good.
        res.writeHead(200, { 'content-type': info.type, 'cache-control': 'public, max-age=31536000, immutable', 'content-length': bytes.length });
        return res.end(bytes);
      }
      if (url.pathname === '/app' || url.pathname === '/download' || url.pathname === '/app/download') {
        // The phone app download page lives with the member app.
        res.writeHead(302, { location: url.pathname === '/app' ? '/app/' : '/app/download/' });
        return res.end();
      }
      if (appRoot && url.pathname.startsWith('/app/')) {
        if (await serveFile(res, appRoot, url.pathname.slice('/app'.length))) return;
        // Shared files such as the logo come from the console folder.
        if (await serveFile(res, root, url.pathname.slice('/app'.length))) return;
        return send(res, 404, { error: 'Not found.' });
      }
      if (await serveFile(res, root, url.pathname)) return;
      send(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (err instanceof ConsoleError) return send(res, err.status, { error: err.message, problems: err.problems });
      console.error(err);
      send(res, 500, { error: 'Something went wrong.' });
    }
  });
}
