/**
 * @layer server
 * Named users and roles (opt-in via `LLULL_USERS_FILE`). Transport-level authentication only:
 * the bearer token resolves to a user, the role gates routes / MCP tools. No business logic (L6).
 *
 * File: JSON `[{ id, name, role: 'viewer'|'editor'|'admin', tokenSha256 }]`; only the SHA-256 of
 * each token is stored. Re-read when the file changes (no restart after `add-user.mjs`).
 */

import crypto from 'crypto';
import fs from 'fs';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isRecord } from '@lib/isRecord';
import { errorMessage } from '@lib/errorMessage';
import { getLicense } from './license';

export type Role = 'viewer' | 'editor' | 'admin';
const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 1, editor: 2, admin: 3 };

export interface NamedUser {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly tokenSha256: string;
}

/** JSON body of every 401 (shared with the single-token guard). */
const UNAUTHORIZED = { error: 'Unauthorized — valid Bearer token required.' };

export const sha256Hex = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export function isRole(value: unknown): value is Role {
  return value === 'viewer' || value === 'editor' || value === 'admin';
}

/** True when `role` is at least `required`. */
export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

function parseUser(raw: unknown): NamedUser | null {
  if (!isRecord(raw)) return null;
  const { id, name, role, tokenSha256 } = raw;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || !isRole(role)) return null;
  if (typeof tokenSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(tokenSha256)) return null;
  return { id, name, role, tokenSha256: tokenSha256.toLowerCase() };
}

let cache: { path: string; stamp: string; users: NamedUser[] } | null = null;

/** Users file path, or undefined when named-user mode is off. */
export function usersFilePath(): string | undefined {
  const value = process.env['LLULL_USERS_FILE'];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/** Named-user mode: supersedes the shared token (even with an empty/unreadable file: all 401). */
export function isUserMode(): boolean {
  return usersFilePath() !== undefined;
}

/** All valid users in the file (file order); [] when missing or malformed. */
export function loadUsers(): readonly NamedUser[] {
  const file = usersFilePath();
  if (file === undefined) return [];
  let stamp: string;
  try {
    const stat = fs.statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    cache = null;
    return [];
  }
  if (cache !== null && cache.path === file && cache.stamp === stamp) return cache.users;
  let users: NamedUser[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    users = parsed.flatMap((entry): NamedUser[] => {
      const user = parseUser(entry);
      if (user === null) console.warn('[llull-users] ignoring an invalid user entry');
      return user === null ? [] : [user];
    });
  } catch (err) {
    console.warn(`[llull-users] cannot read ${file}: ${errorMessage(err)}`);
  }
  cache = { path: file, stamp, users };
  return users;
}

/** Ids allowed to log in under the license seat count (admins first, then file order). */
export function licensedUserIds(users: readonly NamedUser[], seats: number): Set<string> {
  const ordered = [...users].sort(
    (a, b) => Number(b.role === 'admin') - Number(a.role === 'admin'),
  );
  return new Set(ordered.slice(0, seats).map((user) => user.id));
}

/** Constant-time lookup of the user owning `token` (compares every hash, no early exit). */
export function authenticateToken(token: string): NamedUser | null {
  const presented = crypto.createHash('sha256').update(token).digest();
  let found: NamedUser | null = null;
  for (const user of loadUsers()) {
    if (crypto.timingSafeEqual(presented, Buffer.from(user.tokenSha256, 'hex'))) found = user;
  }
  return found;
}

/** Bearer header token, or (when `allowQuery`) `?access_token=` for EventSource / downloads. */
export function presentedToken(req: Request, allowQuery: boolean): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header === 'string') {
    const presented = /^bearer +(.+)$/i.exec(header)?.[1];
    if (presented !== undefined) return presented;
  }
  const query = req.query['access_token'];
  return allowQuery && typeof query === 'string' && query !== '' ? query : undefined;
}

/** The authenticated user of this request (set by `requireRole`), if any. */
export function requestUser(res: Response): NamedUser | undefined {
  const user: unknown = res.locals['llullUser'];
  return isRecord(user) ? (user as unknown as NamedUser) : undefined;
}

/**
 * Express guard for named-user mode: 401 unknown/missing token, 402 beyond the license seats,
 * 403 when the role is below `required`. Sets `res.locals.llullUser` on success.
 */
export function requireRole(required: Role, allowQuery: boolean): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = presentedToken(req, allowQuery);
    const user = token === undefined ? null : authenticateToken(token);
    if (user === null) {
      res.status(401).json(UNAUTHORIZED);
      return;
    }
    const license = getLicense();
    if (!licensedUserIds(loadUsers(), license.seats).has(user.id)) {
      res.status(402).json({
        error:
          `License seat limit reached: ${license.seats} named user(s) allowed (${license.label}). ` +
          `User "${user.id}" has no seat — remove an unused user or install a larger license.`,
      });
      return;
    }
    if (!roleAtLeast(user.role, required)) {
      res.status(403).json({
        error: `Forbidden — role "${user.role}" cannot do this; role "${required}" or higher is required.`,
      });
      return;
    }
    res.locals['llullUser'] = user;
    next();
  };
}
