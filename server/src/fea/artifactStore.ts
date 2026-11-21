/**
 * Content-addressed FE artifact store: `<dir>/<sha256>.json.gz` where sha256 = `sha256Hex(canonicalJson(artifact))`.
 * The file holds the canonical text itself, so a read verifies it with one native hash of the bytes (files written before PERF1 hold
 * plain JSON and are verified by re-canonicalizing). A verified artifact stays in memory (bounded, least recently used first out) and is
 * served again while its file is unchanged (size, times, inode): a result query costs one `stat`, not a re-read of a mesh-sized file.
 * The read side is the `FeArtifactPort` the registry commands re-verify artifacts through (record_fe_mesh / record_fea_results):
 * a file whose content no longer hashes to its name (tamper, truncation) or whose `kind` is unknown reads as absent.
 * Derived artifacts (native FatigueField, mapped fields: RS1 RS-7) are also reachable under their INPUT hash: `alias(key, hash)` writes
 * `<dir>/<key>.ref` naming the content hash, and `get(key)` follows it to a content-verified file (the reader then checks the bindings).
 * Environment: LLULL_FEA_CACHE  directory (default ~/.llull/cache/fea)
 *              LLULL_FEA_MEMORY_MB  canonical-text megabytes of verified artifacts kept in memory (default 128; 0 = none)
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact, FeTableArtifact } from '@core/model/analysis';
import type { FeTopologyArtifact } from '@core/model/topology';
import type { FeExplicitArtifact } from '@core/model/explicit';
import type { CfdResultArtifact } from '@core/model/cfdResult';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '../sha256';
import { nonNegativeInteger } from '../env';
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

const DEFAULT_MEMORY_MB = 128;
/** Fast deflate: a mesh-sized artifact is written while the user waits on fea_mesh / fea_solve; level 6 costs 3x the time for ~15 % fewer bytes. */
const GZIP_LEVEL = 3;

/** The identity of a file's content as far as the file system tells it without reading. */
const fileStamp = (info: Stats): string => `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;

interface Remembered {
  readonly artifact: FeArtifact;
  readonly stamp: string;
  readonly bytes: number;
}

/** Verified artifacts by hash, least recently used first; holds at most `capacity` text bytes but always the newest entry. */
class VerifiedArtifacts {
  private readonly entries = new Map<string, Remembered>();
  private readonly hashes = new WeakMap<object, string>();
  private held = 0;
  constructor(private readonly capacity: number) {}

  get(hash: string, stamp: string): FeArtifact | null {
    const known = this.entries.get(hash);
    if (known === undefined) return null;
    this.entries.delete(hash);
    if (known.stamp !== stamp) {
      this.held -= known.bytes;
      return null;
    }
    this.entries.set(hash, known);
    return known.artifact;
  }

  /** The hash an artifact object of this store was verified under (it stays true after eviction: the object is immutable). */
  hashOf(artifact: object): string | null {
    return this.hashes.get(artifact) ?? null;
  }

  forget(hash: string): void {
    const known = this.entries.get(hash);
    if (known === undefined) return;
    this.entries.delete(hash);
    this.held -= known.bytes;
  }

  remember(hash: string, artifact: FeArtifact, stamp: string, bytes: number): void {
    this.forget(hash);
    this.hashes.set(artifact, hash);
    if (this.capacity === 0) return;
    this.entries.set(hash, { artifact, stamp, bytes });
    this.held += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.held <= this.capacity || oldest === hash) break;
      this.entries.delete(oldest);
      this.held -= entry.bytes;
    }
  }
}

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

export function createFeArtifactStore(directory: string, env: NodeJS.ProcessEnv = process.env): FeArtifactCache {
  const fileOf = (hash: string): string => path.join(directory, `${hash}.json.gz`);
  const verified = new VerifiedArtifacts(nonNegativeInteger(env['LLULL_FEA_MEMORY_MB'], DEFAULT_MEMORY_MB) * 1024 * 1024);
  const stampOf = (file: string): string | null => {
    try {
      return fileStamp(statSync(file));
    } catch {
      return null;
    }
  };
  /** The artifact of a file whose content hashes to `hash`, else null. */
  const readVerified = (file: string, hash: string): { readonly artifact: FeArtifact; readonly bytes: number } | null => {
    try {
      const text = gunzipSync(readFileSync(file));
      const parsed: unknown = JSON.parse(text.toString('utf8'));
      if (!isArtifact(parsed)) return null;
      const canonical = sha256Hex(text) === hash || sha256Hex(canonicalJson(parsed)) === hash;
      return canonical ? { artifact: parsed, bytes: text.length } : null;
    } catch {
      return null;
    }
  };
  const read = (hash: string): FeArtifact | null => {
    const file = fileOf(hash);
    const stamp = stampOf(file);
    if (stamp === null) {
      verified.forget(hash);
      return null;
    }
    const known = verified.get(hash, stamp);
    if (known !== null) return known;
    const loaded = readVerified(file, hash);
    if (loaded === null) return null;
    verified.remember(hash, loaded.artifact, stamp, loaded.bytes);
    return loaded.artifact;
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
      const text = canonicalJson(artifact);
      const hash = sha256Hex(text);
      const target = fileOf(hash);
      if (existsSync(target)) return hash;
      mkdirSync(directory, { recursive: true });
      writeAtomically(target, gzipSync(text, { level: GZIP_LEVEL }));
      const stamp = stampOf(target);
      // The parsed text, not the caller's object: what a later cold read returns (no undefined members, no shared mutable reference).
      if (stamp !== null) verified.remember(hash, JSON.parse(text) as FeArtifact, stamp, Buffer.byteLength(text));
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
    hashOf: (artifact) => verified.hashOf(artifact),
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
