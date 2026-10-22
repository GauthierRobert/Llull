/**
 * Content-addressed FE artifact store: `<dir>/<sha256>.json.gz` where sha256 = `sha256Hex(canonicalJson(artifact))`.
 * The read side is the `FeArtifactPort` the registry commands re-verify artifacts through (record_fe_mesh / record_fea_results):
 * a file whose content no longer hashes to its name (tamper, truncation) or whose `kind` is unknown reads as absent.
 * Derived artifacts (native FatigueField, mapped fields: RS1 RS-7) are also reachable under their INPUT hash: `alias(key, hash)` writes
 * `<dir>/<key>.ref` naming the content hash, and `get(key)` follows it to a content-verified file (the reader then checks the bindings).
 * Environment: LLULL_FEA_CACHE  directory (default ~/.llull/cache/fea)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact, FeTableArtifact } from '@core/model/analysis';
import type { FeTopologyArtifact } from '@core/model/topology';
import type { FeExplicitArtifact } from '@core/model/explicit';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { isRecord } from '@lib/isRecord';

type FeArtifact = FeMeshArtifact | FeResultsArtifact | FeTableArtifact | FeTopologyArtifact | FeExplicitArtifact | CfdResultArtifact;

export interface FeArtifactStore extends FeArtifactPort {
  /** Stores `artifact` and returns its hash (idempotent). */
  put(artifact: FeArtifact): string;
  /** Any stored kind, the CFD result bundles included (`get` answers the FE kinds only, as the `FeArtifactPort` contract says). */
  getAny(hash: string): FeArtifact | null;
  readonly directory: string;
}

/** A store whose artifacts can also be found under an input-hash key (the native jobs' results). */
export interface FeArtifactCache extends FeArtifactStore {
  /** Makes `get(key)` return the artifact stored under content hash `hash` (overwrites an older alias). */
  alias(key: string, hash: string): void;
}

const HASH = /^[0-9a-f]{64}$/;

export function feaCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['LLULL_FEA_CACHE'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : path.join(homedir(), '.llull', 'cache', 'fea');
}

const hashArtifact = (artifact: FeArtifact): string => sha256Hex(canonicalJson(artifact));

function isArtifact(value: unknown): value is FeArtifact {
  return (
    isRecord(value) &&
    (value['kind'] === 'fe_mesh' ||
      value['kind'] === 'fe_results' ||
      value['kind'] === 'fe_table' ||
      value['kind'] === 'fe_topology' ||
      value['kind'] === 'fe_explicit' ||
      value['kind'] === 'cfd_result')
  );
}

function writeAtomically(target: string, bytes: Buffer | string): void {
  const partial = `${target}.${process.pid}.tmp`;
  writeFileSync(partial, bytes);
  renameSync(partial, target);
}

export function createFeArtifactStore(directory: string): FeArtifactCache {
  const fileOf = (hash: string): string => path.join(directory, `${hash}.json.gz`);
  const read = (hash: string): FeArtifact | null => {
    try {
      const parsed: unknown = JSON.parse(gunzipSync(readFileSync(fileOf(hash))).toString('utf8'));
      return isArtifact(parsed) && hashArtifact(parsed) === hash ? parsed : null;
    } catch {
      return null;
    }
  };
  const aliasTarget = (key: string): string | null => {
    try {
      const named = readFileSync(path.join(directory, `${key}.ref`), 'utf8').trim();
      return HASH.test(named) ? named : null;
    } catch {
      return null;
    }
  };
  return {
    directory,
    put(artifact) {
      const hash = hashArtifact(artifact);
      const target = fileOf(hash);
      if (existsSync(target)) return hash;
      mkdirSync(directory, { recursive: true });
      writeAtomically(target, gzipSync(JSON.stringify(artifact)));
      return hash;
    },
    alias(key, hash) {
      if (!HASH.test(key) || !HASH.test(hash)) throw new Error(`artifact alias needs two sha256 hex hashes, got '${key}' -> '${hash}'`);
      mkdirSync(directory, { recursive: true });
      writeAtomically(path.join(directory, `${key}.ref`), hash);
    },
    getAny(hash) {
      if (!HASH.test(hash)) return null;
      if (existsSync(fileOf(hash))) return read(hash);
      const named = aliasTarget(hash);
      return named === null ? null : read(named);
    },
    get(hash) {
      const found = this.getAny(hash);
      return found !== null && found.kind !== 'cfd_result' ? found : null;
    },
  };
}

let shared: FeArtifactCache | null = null;

/** The process-wide store (`LLULL_FEA_CACHE`, read once). */
export function defaultFeArtifactStore(): FeArtifactCache {
  shared ??= createFeArtifactStore(feaCacheDir());
  return shared;
}
