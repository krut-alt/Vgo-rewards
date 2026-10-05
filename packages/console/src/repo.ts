// The console's data store. One JSON file for the pilot; every change is saved and logged.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  evaluate,
  ruleViolations,
  type Actor,
  type EvaluationResult,
  type Period,
  type RuleStatus,
  type Transaction,
} from '../../engine/src/index.js';
import { addDays, localParts } from './dates.js';
import type {
  Branding,
  ConsoleData,
  ConsoleMember,
  ConsoleRule,
  ConsoleStore,
  LedgerEntry,
  ProgramSettings,
  StoreGroup,
} from './model.js';
import { migrate } from './migrate.js';
import { ruleProblems } from './validate.js';

export class ConsoleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly problems: string[] = [message],
  ) {
    super(message);
  }
}

export type RuleInput = Omit<ConsoleRule, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> & { id?: string };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

/** The console sends `null` to clear an optional field; JSON has no undefined. */
function withoutNulls<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null && v !== undefined)) as T;
}

function periodStart(ymd: string, period: Period): string {
  switch (period) {
    case 'day':
      return ymd;
    case 'week':
      return addDays(ymd, -new Date(`${ymd}T12:00:00Z`).getUTCDay());
    case 'month':
      return `${ymd.slice(0, 7)}-01`;
    case 'lifetime':
      return '';
  }
}

export { withoutNulls };

export class Repo {
  /** True when loading applied data updates that still need saving. */
  readonly migrated: boolean;

  constructor(
    public data: ConsoleData,
    private readonly persist: (data: ConsoleData) => void = () => {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.migrated = migrate(data);
  }

  static open(file: string, seed: () => ConsoleData): Repo {
    const data = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ConsoleData) : seed();
    const repo = new Repo(data, (d) => {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(d));
      renameSync(tmp, file);
    });
    if (!existsSync(file) || repo.migrated) repo.save();
    return repo;
  }

  save(): void {
    this.persist(this.data);
  }

  private log(actor: Actor, what: string): void {
    this.data.history.unshift({ at: this.clock().toISOString(), userId: actor.userId, what });
    this.data.history.length = Math.min(this.data.history.length, 1000);
  }

  private policy() {
    const s = this.data.settings;
    return { maxStoreDiscountCents: s.maxStoreDiscountCents, storeManagersCanCreate: s.storeManagersCanCreate };
  }

  // ---- rules ----

  rule(id: string): ConsoleRule {
    const rule = this.data.rules.find((r) => r.id === id);
    if (!rule) throw new ConsoleError('Rule not found.', 404);
    return rule;
  }

  /** Problems that block saving this rule for this person; empty means it can be saved. */
  ruleBlockers(rule: ConsoleRule, actor: Actor): string[] {
    return [
      ...ruleProblems(
        rule,
        this.data.stores.map((s) => s.id),
        this.data.groups.map((g) => g.id),
      ),
      ...(rule.effect && rule.scope ? ruleViolations(rule, actor, this.policy()) : []),
    ];
  }

  private checked(rule: ConsoleRule, actor: Actor): ConsoleRule {
    const problems = this.ruleBlockers(rule, actor);
    if (problems.length) throw new ConsoleError(problems[0]!, 400, problems);
    return rule;
  }

  createRule(raw: RuleInput, actor: Actor): ConsoleRule {
    const input = withoutNulls(raw);
    const now = this.clock().toISOString();
    let id = input.id && !this.data.rules.some((r) => r.id === input.id) ? input.id : slug(input.name ?? 'rule');
    if (!id || this.data.rules.some((r) => r.id === id)) id = `${id || 'rule'}-${randomUUID().slice(0, 6)}`;
    const rule = this.checked(
      {
        ...input,
        id,
        createdAt: now,
        updatedAt: now,
        createdBy: { role: actor.role, userId: actor.userId, storeId: actor.storeId },
      },
      actor,
    );
    this.data.rules.push(rule);
    this.log(actor, `Created "${rule.name}" (${rule.status})`);
    this.save();
    return rule;
  }

  updateRule(id: string, input: Partial<RuleInput>, actor: Actor): ConsoleRule {
    const current = this.rule(id);
    const next = this.checked(
      withoutNulls({ ...current, ...input, id, createdAt: current.createdAt, createdBy: current.createdBy, updatedAt: this.clock().toISOString() }),
      actor,
    );
    // Store managers may only change rules they could have created.
    if (actor.role !== 'jobber-admin') this.checked(current, actor);
    const i = this.data.rules.indexOf(current);
    this.data.rules[i] = next;
    this.log(actor, `Edited "${next.name}"`);
    this.save();
    return next;
  }

  setRuleStatus(id: string, status: RuleStatus, actor: Actor): ConsoleRule {
    const rule = this.rule(id);
    this.checked({ ...rule, status }, actor);
    const before = rule.status;
    rule.status = status;
    rule.updatedAt = this.clock().toISOString();
    this.log(actor, `"${rule.name}" ${before} → ${status}`);
    this.save();
    return rule;
  }

  // ---- stores and groups ----

  upsertStore(store: ConsoleStore, actor: Actor): ConsoleStore {
    if (actor.role !== 'jobber-admin') throw new ConsoleError('Only a jobber admin can change stores.', 403);
    if (!store.id || !store.name?.trim()) throw new ConsoleError('A store needs an id and a name.');
    const unknown = store.groupIds.filter((g) => !this.data.groups.some((x) => x.id === g));
    if (unknown.length) throw new ConsoleError(`Unknown store group ${unknown[0]}.`);
    const i = this.data.stores.findIndex((s) => s.id === store.id);
    if (i >= 0) this.data.stores[i] = store;
    else this.data.stores.push(store);
    this.log(actor, `${i >= 0 ? 'Updated' : 'Added'} store ${store.name}${store.loyaltyLive ? ' (loyalty live)' : ''}`);
    this.save();
    return store;
  }

  upsertGroup(group: StoreGroup, storeIds: string[] | undefined, actor: Actor): StoreGroup {
    if (actor.role !== 'jobber-admin') throw new ConsoleError('Only a jobber admin can change store groups.', 403);
    if (!group.name?.trim()) throw new ConsoleError('A store group needs a name.');
    const id = group.id || slug(group.name);
    const existing = this.data.groups.find((g) => g.id === id);
    if (existing) existing.name = group.name;
    else this.data.groups.push({ id, name: group.name });
    if (storeIds) {
      for (const s of this.data.stores) {
        const has = s.groupIds.includes(id);
        if (storeIds.includes(s.id) && !has) s.groupIds.push(id);
        if (!storeIds.includes(s.id) && has) s.groupIds = s.groupIds.filter((g) => g !== id);
      }
    }
    this.log(actor, `${existing ? 'Updated' : 'Added'} store group ${group.name}`);
    this.save();
    return { id, name: group.name };
  }

  // ---- members ----

  member(id: string): ConsoleMember {
    const m = this.data.members.find((x) => x.id === id);
    if (!m) throw new ConsoleError('Member not found.', 404);
    return m;
  }

  /**
   * Finds a member by what the customer gave at checkout: the phone number typed on the PIN pad
   * or the app barcode (which carries the same number). A leading US 1 is ignored.
   */
  memberByLoyaltyId(raw: unknown): ConsoleMember {
    let digits = String(raw ?? '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    const m = digits.length === 10 ? this.data.members.find((x) => x.phone === digits) : undefined;
    if (!m) throw new ConsoleError('No member with that phone number.', 404);
    return m;
  }

  createMember(input: Pick<ConsoleMember, 'name' | 'phone'> & Partial<ConsoleMember>, actor: Actor): ConsoleMember {
    const phone = String(input.phone ?? '').replace(/\D/g, '');
    if (phone.length !== 10) throw new ConsoleError('Enter a 10-digit phone number.');
    if (this.data.members.some((m) => m.phone === phone)) throw new ConsoleError('That phone number is already a member.');
    const m: ConsoleMember = {
      id: `m-${randomUUID().slice(0, 8)}`,
      name: String(input.name ?? '').trim(),
      phone,
      homeStoreId: input.homeStoreId,
      tags: input.tags ?? [],
      pointsBalance: 0,
      visitCount: 0,
      punches: {},
      joinedAt: this.clock().toISOString(),
      ...(input.smsOptIn !== undefined ? { smsOptIn: Boolean(input.smsOptIn) } : {}),
    };
    this.data.members.push(m);
    this.log(actor, `Added member ${m.name || 'without a name'}`);
    this.save();
    return m;
  }

  adjustPoints(id: string, delta: number, reason: string, actor: Actor): ConsoleMember {
    if (actor.role === 'store-manager') throw new ConsoleError('Only the jobber can adjust points.', 403);
    if (!Number.isInteger(delta) || delta === 0) throw new ConsoleError('Enter a whole number of points.');
    if (!reason?.trim()) throw new ConsoleError('Add a reason for the adjustment.');
    const m = this.member(id);
    m.pointsBalance = Math.max(0, m.pointsBalance + delta);
    this.log(actor, `Adjusted ${m.name || m.id} by ${delta > 0 ? '+' : ''}${delta} points: ${reason.trim()}`);
    this.save();
    return m;
  }

  /** Clears points for members who have not visited within the expiry window. */
  expirePoints(actor: Actor): number {
    const months = this.data.settings.pointsExpireMonths;
    if (!months) return 0;
    const cutoff = new Date(this.clock());
    cutoff.setMonth(cutoff.getMonth() - months);
    let count = 0;
    for (const m of this.data.members) {
      const last = Date.parse(m.lastVisitAt ?? m.joinedAt);
      if (m.pointsBalance > 0 && last < cutoff.getTime()) {
        m.pointsBalance = 0;
        count++;
      }
    }
    if (count) {
      this.log(actor, `Expired points for ${count} members with no visit in ${months} months`);
      this.save();
    }
    return count;
  }

  // ---- settings and branding ----

  updateSettings(patch: Partial<ProgramSettings>, actor: Actor): ProgramSettings {
    if (actor.role !== 'jobber-admin') throw new ConsoleError('Only a jobber admin can change program settings.', 403);
    const next = { ...this.data.settings, ...patch };
    const intOk = (n: number) => Number.isInteger(n) && n >= 0;
    if (!intOk(next.pointsExpireMonths) || !intOk(next.maxStoreDiscountCents) || !intOk(next.monthlyBudgetCents))
      throw new ConsoleError('Settings must be whole, non-negative numbers.');
    if (next.fuelStacking.mode === 'stack' && !(next.fuelStacking.maxCentsPerGallon > 0))
      throw new ConsoleError('Set the most cents per gallon a fill-up can get.');
    this.data.settings = next;
    this.log(actor, `Changed program settings: ${Object.keys(patch).join(', ')}`);
    this.save();
    return next;
  }

  updateBranding(patch: Partial<Branding>, actor: Actor): Branding {
    if (actor.role !== 'jobber-admin') throw new ConsoleError('Only a jobber admin can change branding.', 403);
    const next = { ...this.data.branding, ...patch };
    const hex = /^#[0-9a-fA-F]{6}$/;
    if (!hex.test(next.mainColor) || !hex.test(next.accentColor)) throw new ConsoleError('Colors must be hex values like #0F2747.');
    if (!next.programName.trim()) throw new ConsoleError('Give the program a name.');
    if (next.logoDataUrl && !/^data:image\/(png|jpeg|svg\+xml|webp);base64,/.test(next.logoDataUrl))
      throw new ConsoleError('Logo must be a PNG, JPG, SVG or WebP image.');
    if (next.logoDataUrl.length > 700_000) throw new ConsoleError('Logo must be under 500 KB.');
    this.data.branding = next;
    this.log(actor, `Changed branding: ${Object.keys(patch).join(', ')}`);
    this.save();
    return next;
  }

  // ---- transactions (the POS link calls these) ----

  /** Records who did what, for change history. Public so the member API can log app actions. */
  note(actor: Actor, what: string): void {
    this.log(actor, what);
  }

  store(id: string): ConsoleStore {
    const s = this.data.stores.find((x) => x.id === id);
    if (!s) throw new ConsoleError(`Unknown store ${id}.`, 404);
    return s;
  }

  memberUsage(memberId: string, ymd: string) {
    const entries = this.data.ledger.filter((e) => e.memberId === memberId);
    return (ruleId: string, period: Period) => {
      const start = periodStart(ymd, period);
      return entries.filter((e) => e.ymd >= start && e.appliedRuleIds.includes(ruleId)).length;
    };
  }

  private budgetUsed(ymd: string) {
    const month = ymd.slice(0, 7);
    return (ruleId: string) =>
      this.data.ledger
        .filter((e) => e.ymd.startsWith(month))
        .reduce((sum, e) => sum + e.discounts.filter((d) => d.ruleId === ruleId).reduce((s, d) => s + d.centsOff, 0), 0);
  }

  /** What the program would give on this transaction, without saving anything. */
  preview(tx: Transaction, memberId?: string): EvaluationResult {
    const store = this.store(tx.storeId);
    if (!memberId) return { pointsEarned: 0, pointsSpent: 0, discounts: [], punches: {}, appliedRuleIds: [] };
    const ymd = localParts(tx.at).ymd;
    const member = this.member(memberId);
    // Redemptions picked in the app ride along with whatever the POS sends.
    const redeemRuleIds = [...new Set([...(tx.redeemRuleIds ?? []), ...(member.nextVisitRedeem ?? [])])];
    return evaluate(this.data.rules, store, { ...tx, redeemRuleIds }, member, this.memberUsage(memberId, ymd), {
      budgetUsed: this.budgetUsed(ymd),
      fuelStacking: this.data.settings.fuelStacking,
    });
  }

  /** Applies a finished transaction: earns and spends points, moves punch cards and records it. */
  recordTransaction(tx: Transaction, memberId?: string, opts: { sample?: boolean; save?: boolean } = {}): EvaluationResult {
    const store = this.store(tx.storeId);
    if (!store.loyaltyLive && memberId) throw new ConsoleError(`Loyalty is not live at ${store.name} yet.`, 409);
    if (this.data.ledger.some((e) => e.tx.id === tx.id)) throw new ConsoleError('Transaction already recorded.', 409);
    const result = this.preview(tx, memberId);
    if (memberId) {
      const m = this.member(memberId);
      m.pointsBalance += result.pointsEarned - result.pointsSpent;
      Object.assign(m.punches, result.punches);
      m.visitCount += 1;
      m.lastVisitAt = tx.at;
      m.homeStoreId ??= store.id;
      if (m.nextVisitRedeem) m.nextVisitRedeem = m.nextVisitRedeem.filter((id) => !result.appliedRuleIds.includes(id));
    }
    const entry: LedgerEntry = {
      tx,
      ymd: localParts(tx.at).ymd,
      memberId,
      pointsEarned: result.pointsEarned,
      pointsSpent: result.pointsSpent,
      appliedRuleIds: result.appliedRuleIds,
      discounts: result.discounts.map((d) => ({ ruleId: d.ruleId, centsOff: d.centsOff })),
    };
    if (opts.sample) entry.sample = true;
    this.data.ledger.push(entry);
    if (opts.save !== false) this.save();
    return result;
  }

  /** Removes the sample transactions and members that ship with a new console. */
  clearSampleData(actor: Actor): void {
    if (actor.role !== 'jobber-admin') throw new ConsoleError('Only a jobber admin can clear sample data.', 403);
    const sampleMembers = new Set(this.data.ledger.filter((e) => e.sample && e.memberId).map((e) => e.memberId));
    this.data.ledger = this.data.ledger.filter((e) => !e.sample);
    this.data.members = this.data.members.filter((m) => !sampleMembers.has(m.id) && !m.tags.includes('sample'));
    this.log(actor, 'Cleared sample data');
    this.save();
  }
}
