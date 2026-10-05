// Back-office sign-in: the master admin (password from VGO_ADMIN_PASSWORD) plus portal users the
// admin adds, each limited to the locations they're given. Sessions are random tokens in a cookie.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../../engine/src/index.js';
import type { PortalAuth, PortalUser } from './model.js';
import { ConsoleError, type Repo } from './repo.js';

export const MASTER_LOGIN = 'admin';
const MASTER_ID = 'master';
const SESSION_DAYS = 14;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString('hex')}`;
}

export function passwordOk(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const given = scryptSync(password, salt, 32);
  const want = Buffer.from(hash, 'hex');
  return given.length === want.length && timingSafeEqual(given, want);
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** What the portal shows about a user; never the password hash. */
export type PortalUserView = Omit<PortalUser, 'passwordHash'>;
export const userView = ({ passwordHash: _ignored, ...u }: PortalUser): PortalUserView => u;

export interface SignedIn {
  actor: Actor;
  user: { id: string; name: string; email: string; role: 'admin' | 'store'; storeIds: string[] };
}

export class PortalAuthService {
  private fails = new Map<string, number[]>();

  constructor(
    private readonly repo: Repo,
    private readonly adminPassword: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private get auth(): PortalAuth {
    return (this.repo.data.portal ??= { users: [], sessions: {} });
  }

  signIn(rawLogin: unknown, rawPassword: unknown): { token: string; signedIn: SignedIn } {
    const login = String(rawLogin ?? '').trim().toLowerCase();
    const password = String(rawPassword ?? '');
    const now = this.clock().getTime();
    const recent = (this.fails.get(login) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length >= MAX_FAILS) throw new ConsoleError('Too many tries. Wait 15 minutes and try again.', 429);

    let userId: string | undefined;
    if (login === MASTER_LOGIN) {
      if (sameSecret(password, this.adminPassword)) userId = MASTER_ID;
    } else {
      const user = this.auth.users.find((u) => u.email === login);
      if (user && passwordOk(password, user.passwordHash)) {
        userId = user.id;
        user.lastSignInAt = new Date(now).toISOString();
      }
    }
    if (!userId) {
      this.fails.set(login, [...recent, now]);
      throw new ConsoleError('That email or password is not right.', 401);
    }
    this.fails.delete(login);
    // Drop expired sessions while we're here.
    for (const [k, s] of Object.entries(this.auth.sessions)) if (Date.parse(s.expiresAt) < now) delete this.auth.sessions[k];
    const token = randomBytes(32).toString('base64url');
    this.auth.sessions[sha(token)] = { userId, expiresAt: new Date(now + SESSION_DAYS * 86_400_000).toISOString() };
    this.repo.save();
    return { token, signedIn: this.signedInAs(userId)! };
  }

  signOut(token: string | undefined): void {
    if (!token) return;
    delete this.auth.sessions[sha(token)];
    this.repo.save();
  }

  /** The person behind a session token, or undefined when it's missing or expired. */
  fromToken(token: string | undefined): SignedIn | undefined {
    if (!token) return undefined;
    const s = this.auth.sessions[sha(token)];
    if (!s || Date.parse(s.expiresAt) < this.clock().getTime()) return undefined;
    return this.signedInAs(s.userId);
  }

  private signedInAs(userId: string): SignedIn | undefined {
    if (userId === MASTER_ID) {
      return {
        actor: { role: 'jobber-admin', userId: 'krut' },
        user: { id: MASTER_ID, name: 'Master admin', email: MASTER_LOGIN, role: 'admin', storeIds: [] },
      };
    }
    const u = this.auth.users.find((x) => x.id === userId);
    if (!u) return undefined;
    const actor: Actor =
      u.role === 'admin' ? { role: 'jobber-admin', userId: u.email } : { role: 'store-manager', userId: u.email, storeIds: u.storeIds, storeId: u.storeIds[0] };
    return { actor, user: { id: u.id, name: u.name, email: u.email, role: u.role, storeIds: u.storeIds } };
  }

  // ---- managing users (admins only) ----

  users(): PortalUserView[] {
    return this.auth.users.map(userView);
  }

  saveUser(input: Partial<PortalUser> & { password?: string }, actor: Actor): PortalUserView {
    if (actor.role !== 'jobber-admin') throw new ConsoleError('Only an admin can manage portal users.', 403);
    const existing = input.id ? this.auth.users.find((u) => u.id === input.id) : undefined;
    if (input.id && !existing) throw new ConsoleError('User not found.', 404);
    const name = String(input.name ?? existing?.name ?? '').trim();
    const email = String(input.email ?? existing?.email ?? '').trim().toLowerCase();
    const role = input.role ?? existing?.role ?? 'store';
    const storeIds = [...new Set(input.storeIds ?? existing?.storeIds ?? [])];
    if (!name) throw new ConsoleError('Add the person’s name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ConsoleError('Enter a valid email address. It’s what they sign in with.');
    if (this.auth.users.some((u) => u.email === email && u.id !== existing?.id)) throw new ConsoleError('Someone already signs in with that email.');
    if (role !== 'admin' && role !== 'store') throw new ConsoleError('Pick admin or store access.');
    const unknown = storeIds.find((id) => !this.repo.data.stores.some((s) => s.id === id));
    if (unknown) throw new ConsoleError(`Unknown location ${unknown}.`);
    if (role === 'store' && !storeIds.length) throw new ConsoleError('Pick at least one location for store access.');
    if (!existing && !input.password) throw new ConsoleError('Set a starting password.');
    if (input.password !== undefined && input.password.length < 8) throw new ConsoleError('Passwords need at least 8 characters.');

    const user: PortalUser = {
      id: existing?.id ?? `u-${randomUUID().slice(0, 8)}`,
      name,
      email,
      role,
      storeIds: role === 'admin' ? [] : storeIds,
      passwordHash: input.password ? hashPassword(input.password) : existing!.passwordHash,
      createdAt: existing?.createdAt ?? this.clock().toISOString(),
      ...(existing?.lastSignInAt ? { lastSignInAt: existing.lastSignInAt } : {}),
    };
    if (existing) this.auth.users[this.auth.users.indexOf(existing)] = user;
    else this.auth.users.push(user);
    // A new password signs them out everywhere.
    if (existing && input.password) this.endSessions(user.id);
    this.repo.note(actor, `${existing ? 'Updated' : 'Added'} portal user ${name} (${role === 'admin' ? 'admin' : `${storeIds.length} location${storeIds.length === 1 ? '' : 's'}`})`);
    this.repo.save();
    return userView(user);
  }

  removeUser(id: string, actor: Actor): void {
    if (actor.role !== 'jobber-admin') throw new ConsoleError('Only an admin can manage portal users.', 403);
    const user = this.auth.users.find((u) => u.id === id);
    if (!user) throw new ConsoleError('User not found.', 404);
    this.auth.users = this.auth.users.filter((u) => u.id !== id);
    this.endSessions(id);
    this.repo.note(actor, `Removed portal user ${user.name}`);
    this.repo.save();
  }

  private endSessions(userId: string): void {
    for (const [k, s] of Object.entries(this.auth.sessions)) if (s.userId === userId) delete this.auth.sessions[k];
  }
}
