/**
 * Content-addressed FE artifact store: `<dir>/<sha256>.json.gz` where sha256 = `sha256Hex(canonicalJson(artifact))`.
 * The read side is the `FeArtifactPort` the registry commands re-verify artifacts through (record_fe_mesh / record_fea_results):
 * a file whose content no longer hashes to its name (tamper, truncation) or whose `kind` is unknown reads as absent.
 * Environment: LLULL_FEA_CACHE  directory (default ~/.llull/cache/fea)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact, FeTableArtifact } from '@core/model/analysis';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { isRecord } from '@lib/isRecord';

type FeArtifact = FeMeshArtifact | FeResultsArtifact | FeTableArtifact;

export interface FeArtifactStore extends FeArtifactPort {
  /** Stores `artifact` and returns its hash (idempotent). */
  put(artifact: FeArtifact): string;
  readonly directory: string;
}

const HASH = /^[0-9a-f]{64}$/;

export function feaCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_FEA_CACHE'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(homedir(), '.llull', 'cache', 'fea');
}

const hashArtifact = (artifact: FeArtifact): string => sha256Hex(canonicalJson(artifact));

function isArtifact(value: unknown): value is FeArtifact {
  return isRecord(value) && (value['kind'] === 'fe_mesh' || value['kind'] === 'fe_results' || value['kind'] === 'fe_table');
}

export function createFeArtifactStore(directory: string): FeArtifactStore {
  const fileOf = (hash: string): string => path.join(directory, `${hash}.json.gz`);
  return {
    directory,
    put(artifact) {
      const hash = hashArtifact(artifact);
      const target = fileOf(hash);
      if (existsSync(target)) return hash;
      mkdirSync(directory, { recursive: true });
      const partial = `${target}.${process.pid}.tmp`;
      writeFileSync(partial, gzipSync(JSON.stringify(artifact)));
      renameSync(partial, target);
      return hash;
    },
    get(hash) {
      if (!HASH.test(hash)) return null;
      try {
        const parsed: unknown = JSON.parse(gunzipSync(readFileSync(fileOf(hash))).toString('utf8'));
        return isArtifact(parsed) && hashArtifact(parsed) === hash ? parsed : null;
      } catch {
        return null;
      }
    },
  };
}

let shared: FeArtifactStore | null = null;

/** The process-wide store (`LLULL_FEA_CACHE`, read once). */
export function defaultFeArtifactStore(): FeArtifactStore {
  shared ??= createFeArtifactStore(feaCacheDir());
  return shared;
}
