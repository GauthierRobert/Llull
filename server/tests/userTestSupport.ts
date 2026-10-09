/**
 * @layer server/tests
 * Shared fixtures for the named-user / audit / license tests: temp dir, users file, tokens.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Role } from '../src/users';

export const sha256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llull-test-'));
}

interface TestUser {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly token: string;
}

export const VIEWER: TestUser = {
  id: 'vera',
  name: 'Vera Viewer',
  role: 'viewer',
  token: 'tok-viewer',
};
export const EDITOR: TestUser = {
  id: 'ed',
  name: 'Ed Editor',
  role: 'editor',
  token: 'tok-editor',
};
export const ADMIN: TestUser = { id: 'ada', name: 'Ada Admin', role: 'admin', token: 'tok-admin' };

/** Write a users file (hashes only) and point LLULL_USERS_FILE at it. */
export function installUsersFile(dir: string, users: readonly TestUser[]): string {
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      users.map(({ id, name, role, token }) => ({ id, name, role, tokenSha256: sha256(token) })),
    ),
  );
  process.env['LLULL_USERS_FILE'] = file;
  return file;
}

export const ENV_KEYS = [
  'LLULL_USERS_FILE',
  'LLULL_AUDIT_FILE',
  'LLULL_AUDIT_MAX_BYTES',
  'LLULL_AUDIT_KEEP',
  'LLULL_LICENSE_FILE',
  'LLULL_LICENSE_PUBLIC_KEY',
  'MCP_AUTH_TOKEN',
];

export function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}
