/**
 * Content-addressed object store of the local vault (09 PLM M3, §6.2): `objects/<2>/<62>` holds the exact text whose SHA-256 names it.
 * Objects are immutable (written through a temp file, fsynced, renamed, made read-only); a read re-hashes, so a damaged object reads as absent.
 */

import { sha256Hex } from '../../sha256';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type { ObjectStorePort } from '@core/commands/types';

const SHA256 = /^[0-9a-f]{64}$/;

export interface ObjectStore extends ObjectStorePort {
  /** Store `text` and return its SHA-256 (idempotent: an intact object is kept, a damaged one is replaced). */
  put(text: string): string;
  /** Re-hash every object: how many were checked and which are damaged (hash differs from the name). */
  verify(): { readonly checked: number; readonly damaged: readonly string[] };
}

export function createObjectStore(root: string): ObjectStore {
  const objects = path.join(root, 'objects');
  const fileOf = (sha: string): string | null => (SHA256.test(sha) ? path.join(objects, sha.slice(0, 2), sha.slice(2)) : null);
  const read = (sha: string): string | null => {
    const file = fileOf(sha);
    if (file === null || !existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    return sha256Hex(text) === sha ? text : null;
  };
  return {
    has: (sha) => read(sha) !== null,
    get: read,
    put(text) {
      const sha = sha256Hex(text);
      const file = fileOf(sha) as string;
      if (read(sha) !== null) return sha;
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      const descriptor = openSync(temporary, 'w', 0o644);
      try {
        writeSync(descriptor, text, null, 'utf8');
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      rmSync(file, { force: true });
      renameSync(temporary, file);
      chmodSync(file, 0o444);
      return sha;
    },
    verify() {
      const damaged: string[] = [];
      let checked = 0;
      if (!existsSync(objects)) return { checked, damaged };
      for (const prefix of readdirSync(objects)) {
        for (const rest of readdirSync(path.join(objects, prefix))) {
          if (rest.endsWith('.tmp')) continue;
          checked += 1;
          if (read(`${prefix}${rest}`) === null) damaged.push(`${prefix}${rest}`);
        }
      }
      return { checked, damaged };
    },
  };
}
