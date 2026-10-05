// Console API and web server. No sign-in yet, so it listens on localhost only;
// sign-in and roles come before it is hosted anywhere.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { Actor, RuleStatus, Transaction } from '../../engine/src/index.js';
import { CATEGORIES, FUEL_GRADES } from './catalog.js';
import { ruleChecks } from './checks.js';
import { localParts } from './dates.js';
import { DRAFT_EXAMPLES, draftRule } from './drafter.js';
import {
  displayStatus,
  fundedLabel,
  memberLine,
  rewardLabel,
  runsLabel,
  targetLabel,
  typeLabel,
} from './labels.js';
import type { ConsoleRule, ConsoleStore } from './model.js';
import { MemberApi } from './member-api.js';
import { PRESETS } from './presets.js';
import { ConsoleError, Repo, withoutNulls, type RuleInput } from './repo.js';
import { computeResults } from './results.js';
import { ADMIN } from './seed.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

export function ruleView(repo: Repo, rule: ConsoleRule, now = new Date()) {
  const { stores, groups } = repo.data;
  return {
    ...rule,
    display: {
      status: displayStatus(rule, now),
      type: typeLabel(rule),
      target: targetLabel(rule.scope, stores, groups),
      runs: runsLabel(rule),
      funded: fundedLabel(rule),
      reward: rewardLabel(rule),
      memberLine: memberLine(rule),
    },
  };
}

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new ConsoleError('Request is too large.', 413);
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
  return { ...tx, items: tx.items ?? [], localHour: tx.localHour ?? p.hour, localDayOfWeek: tx.localDayOfWeek ?? p.dayOfWeek };
}

export interface AppOptions {
  clock?: () => Date;
  /** Folder with the customer app, served at /app/. */
  appDir?: string;
  memberApi?: MemberApi;
  /** When set, the console and its API ask for this password. The member app stays open. */
  adminPassword?: string;
}

/** Basic auth check; any user name is accepted. */
function passwordMatches(header: string | undefined, password: string): boolean {
  const m = /^Basic (.+)$/i.exec(header ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const given = createHash('sha256').update(decoded.slice(decoded.indexOf(':') + 1)).digest();
  return timingSafeEqual(given, createHash('sha256').update(password).digest());
}

export function createApp(repo: Repo, publicDir: string, options: AppOptions | (() => Date) = {}) {
  const opts = typeof options === 'function' ? { clock: options } : options;
  const clock = opts.clock ?? (() => new Date());
  const members = opts.memberApi ?? new MemberApi(repo, undefined, clock);
  // Everyone is the jobber admin until sign-in exists.
  const actor: Actor = ADMIN;

  async function api(req: IncomingMessage, url: URL): Promise<[number, unknown]> {
    const path = url.pathname.replace(/^\/api/, '');
    const m = (pattern: RegExp) => pattern.exec(path);
    const method = req.method ?? 'GET';
    const views = () => repo.data.rules.map((r) => ruleView(repo, r, clock()));
    let match: RegExpExecArray | null;

    if (method === 'GET' && path === '/bootstrap') {
      const d = repo.data;
      return [
        200,
        {
          actor,
          branding: d.branding,
          settings: d.settings,
          stores: d.stores,
          groups: d.groups,
          rules: views(),
          presets: PRESETS,
          categories: CATEGORIES.map(({ id, label }) => ({ id, label })),
          grades: FUEL_GRADES.map(({ id, label }) => ({ id, label })),
          draftExamples: DRAFT_EXAMPLES,
          pilot: d.pilot,
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
      if (method === 'GET') return [200, ruleView(repo, repo.rule(id), clock())];
      if (method === 'PUT') return [200, ruleView(repo, repo.updateRule(id, await body<Partial<RuleInput>>(req), actor), clock())];
    }
    if (method === 'POST' && (match = m(/^\/rules\/([\w-]+)\/status$/))) {
      const { status } = await body<{ status: RuleStatus }>(req);
      return [200, ruleView(repo, repo.setRuleStatus(match[1]!, status, actor), clock())];
    }

    if (method === 'GET' && path === '/stores') return [200, { stores: repo.data.stores, groups: repo.data.groups }];
    if (method === 'PUT' && (match = m(/^\/stores\/([\w-]+)$/))) {
      const store = await body<ConsoleStore>(req);
      return [200, repo.upsertStore({ ...store, id: match[1]! }, actor)];
    }
    if (method === 'POST' && path === '/groups') {
      const { id, name, storeIds } = await body<{ id?: string; name: string; storeIds?: string[] }>(req);
      return [200, repo.upsertGroup({ id: id ?? '', name }, storeIds, actor)];
    }

    if (method === 'GET' && path === '/members') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase().replace(/[^\w ]/g, '');
      const digits = q.replace(/\D/g, '');
      const list = repo.data.members.filter(
        (mm) => !q || mm.name.toLowerCase().includes(q) || (digits.length >= 3 && mm.phone.includes(digits)),
      );
      return [200, { total: list.length, members: list.slice(-200).reverse() }];
    }
    if (method === 'POST' && path === '/members') return [201, repo.createMember(await body(req), actor)];
    if ((match = m(/^\/members\/([\w-]+)$/)) && method === 'GET') {
      const member = repo.member(match[1]!);
      const visits = repo.data.ledger.filter((e) => e.memberId === member.id).slice(-20).reverse();
      return [200, { member, visits }];
    }
    if (method === 'POST' && (match = m(/^\/members\/([\w-]+)\/points$/))) {
      const { delta, reason } = await body<{ delta: number; reason: string }>(req);
      return [200, repo.adjustPoints(match[1]!, Number(delta), String(reason ?? ''), actor)];
    }

    if (method === 'PUT' && path === '/settings') return [200, repo.updateSettings(await body(req), actor)];
    if (method === 'PUT' && path === '/branding') return [200, repo.updateBranding(await body(req), actor)];
    if (method === 'GET' && path === '/results') {
      const view = url.searchParams.get('view') === 'all' ? 'all' : 'pilot';
      return [200, computeResults(repo.data, view, clock())];
    }
    if (method === 'GET' && path === '/history') return [200, repo.data.history.slice(0, 200)];
    if (method === 'POST' && path === '/sample/clear') {
      repo.clearSampleData(actor);
      return [200, { ok: true }];
    }

    // What the POS link calls. `preview` answers "what does this member get" before payment;
    // `transactions` records the finished sale.
    if (method === 'POST' && path === '/pos/preview') {
      const { tx, memberId } = await body<{ tx: Transaction; memberId?: string }>(req);
      return [200, repo.preview(withLocalTime(tx), memberId)];
    }
    if (method === 'POST' && path === '/pos/transactions') {
      const { tx, memberId } = await body<{ tx: Transaction; memberId?: string }>(req);
      return [201, repo.recordTransaction(withLocalTime(tx), memberId)];
    }
    throw new ConsoleError('Not found.', 404);
  }

  /** The customer app's API. Everything after sign-in acts only on the signed-in member. */
  async function appApi(req: IncomingMessage, url: URL): Promise<[number, unknown]> {
    const path = url.pathname.replace(/^\/api\/app/, '');
    const method = req.method ?? 'GET';
    if (method === 'GET' && path === '/config') return [200, members.config()];
    if (method === 'POST' && path === '/code') {
      const { phone } = await body<{ phone?: string }>(req);
      return [200, await members.requestCode(phone)];
    }
    if (method === 'POST' && path === '/verify') {
      const { phone, code, firstName, smsOptIn, homeStoreId } = await body<Record<string, string | boolean | undefined>>(req);
      const result = await members.verify(phone, code, { firstName: firstName as string, smsOptIn: Boolean(smsOptIn), homeStoreId: homeStoreId as string });
      return [200, result];
    }

    const member = members.memberFor(req.headers.authorization);
    let match: RegExpExecArray | null;
    if (method === 'GET' && path === '/me') return [200, members.home(member)];
    if (method === 'PUT' && path === '/me') {
      members.updateAccount(member, await body(req));
      return [200, members.home(member)];
    }
    if (method === 'GET' && path === '/offers') return [200, members.offers(member, url.searchParams.get('storeId') ?? undefined)];
    if ((match = /^\/offers\/([\w-]+)\/clip$/.exec(path)) && (method === 'POST' || method === 'DELETE'))
      return [200, { clippedRuleIds: members.setClip(member, match[1]!, method === 'POST') }];
    if (method === 'PUT' && path === '/redeem') {
      const { ruleIds } = await body<{ ruleIds?: unknown }>(req);
      return [200, members.setRedeem(member, ruleIds)];
    }
    if (method === 'GET' && path === '/visits') return [200, members.visits(member)];
    if (method === 'POST' && path === '/signout') {
      members.signOut(req.headers.authorization);
      return [200, { ok: true }];
    }
    throw new ConsoleError('Not found.', 404);
  }

  async function serveFile(res: ServerResponse, dir: string, rel: string): Promise<boolean> {
    const file = normalize(join(dir, rel === '' || rel === '/' ? 'index.html' : rel));
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
      const memberSide = url.pathname === '/app' || url.pathname.startsWith('/app/') || url.pathname.startsWith('/api/app/');
      if (opts.adminPassword && !memberSide && !passwordMatches(req.headers.authorization, opts.adminPassword)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="VGO Rewards console", charset="UTF-8"' });
        return res.end('Sign in to the VGO Rewards console.');
      }
      if (url.pathname.startsWith('/api/app/')) {
        const [status, data] = await appApi(req, url);
        return send(res, status, data);
      }
      if (url.pathname.startsWith('/api/')) {
        const [status, data] = await api(req, url);
        return send(res, status, data);
      }
      if (url.pathname === '/app') {
        res.writeHead(302, { location: '/app/' });
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
