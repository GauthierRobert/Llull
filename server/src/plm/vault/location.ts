/** Where the local vault is (`LLULL_VAULT`) and its read-only object port: a leaf module so the server context can use it without importing the vault. */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { type ObjectStore, createObjectStore } from './objectStore';

/** `LLULL_VAULT` (a folder), or null when unset or empty. */
export const vaultDirOf = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const configured = env['LLULL_VAULT'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : null;
};

/** The objects of the vault of `LLULL_VAULT`, or null when none is configured / initialised: the `ctx.objects` of the server context. */
export function objectsOf(env: NodeJS.ProcessEnv = process.env): ObjectStore | null {
  const dir = vaultDirOf(env);
  if (dir === null || !existsSync(path.join(dir, 'vault.json'))) return null;
  return createObjectStore(dir);
}
