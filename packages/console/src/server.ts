// Console API and web server. No sign-in yet, so it listens on localhost only;
// sign-in and roles come before it is hosted anywhere.
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

export function createApp(repo: Repo, publicDir: string, clock: () => Date = () => new Date()) {
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

  const root = resolve(publicDir);
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const [status, data] = await api(req, url);
        return send(res, status, data);
      }
      const file = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(root)) return send(res, 404, { error: 'Not found.' });
      const content = await readFile(file).catch(() => null);
      if (!content) return send(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(content);
    } catch (err) {
      if (err instanceof ConsoleError) return send(res, err.status, { error: err.message, problems: err.problems });
      console.error(err);
      send(res, 500, { error: 'Something went wrong.' });
    }
  });
}
