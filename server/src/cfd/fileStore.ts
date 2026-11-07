/**
 * Content-addressed binary files of the flow results (12 CFD M3a): `field.bin` of each solve (bound by hash in its `cfd_result` bundle) and
 * the `slice.bin` / `streamlines.bin` a query produces, as `<dir>/<sha256>.bin`. Too large for the gzipped JSON bundles of the FE store, so
 * kept raw beside them (`<FE store>/cfd-files`). A file whose content no longer hashes to its name (tamper, truncation) reads as absent.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../sha256';

const HASH = /^[0-9a-f]{64}$/;

export interface CfdFileStore {
  /** Stores `bytes` and returns their sha256 (idempotent). */
  put(bytes: Buffer): string;
  /** The verified bytes of `hash`, or null when absent or damaged. */
  get(hash: string): Buffer | null;
  readonly directory: string;
}

/** The store under `<artifactDirectory>/cfd-files`. */
export function cfdFileStore(artifactDirectory: string): CfdFileStore {
  const directory = path.join(artifactDirectory, 'cfd-files');
  const fileOf = (hash: string): string => path.join(directory, `${hash}.bin`);
  return {
    directory,
    put(bytes) {
      const hash = sha256Hex(bytes);
      const target = fileOf(hash);
      if (existsSync(target) && this.get(hash) !== null) return hash;
      mkdirSync(directory, { recursive: true });
      const partial = `${target}.${process.pid}.tmp`;
      writeFileSync(partial, bytes);
      renameSync(partial, target);
      return hash;
    },
    get(hash) {
      if (!HASH.test(hash)) return null;
      try {
        const bytes = readFileSync(fileOf(hash));
        return sha256Hex(bytes) === hash ? bytes : null;
      } catch {
        return null;
      }
    },
  };
}
