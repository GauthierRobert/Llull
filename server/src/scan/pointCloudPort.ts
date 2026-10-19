/**
 * The Node `PointCloudPort` (plant 10 TR-SCN-02, §2.A): manifest, bounded queries and the nearest point are read synchronously from the
 * asset store; `compute` runs `llull-compute cloud op <job-folder>` synchronously (commands are synchronous), with a timeout, and returns
 * the job's `result.json` after checking its sha256. Without the binary, `compute` answers NATIVE_TOOL_MISSING with the install hint.
 * Environment: LLULL_SCAN_CACHE (store), LLULL_COMPUTE / LLULL_NATIVE_DIR (binary), LLULL_SCAN_OP_TIMEOUT_S (default 600), LLULL_NATIVE_KEEP=1.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CloudNearest, CloudOp, CloudOpResult, CloudPoints, CloudQuery, PointCloudPort } from '@core/model/pointCloud';
import type { Vec3 } from '@core/model/vectors';
import { isRecord } from '@lib/isRecord';
import { nativeBinaryPath, nativeInstallHint } from '../native/nativeBinary';
import { AssetReader, boxDistance, boxesMeet } from './assetReader';
import { assetDir, isAssetKey, scanCacheDir } from './scanStore';

const DEFAULT_OP_TIMEOUT_S = 600;

export interface PointCloudPortOptions {
  readonly store?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Absolute path of llull-compute (default: located like every native job); null = not installed. */
  readonly binary?: string | null;
}

/** Points of node `i` inside `query`'s box / sphere. */
function* pointsIn(reader: AssetReader, i: number, query: CloudQuery): Generator<{ p: Vec3; index: number }> {
  const node = reader.readNode(i);
  if (node === null) return;
  for (let k = 0; k < node.indices.length; k++) {
    const p: Vec3 = [node.positions[3 * k] ?? 0, node.positions[3 * k + 1] ?? 0, node.positions[3 * k + 2] ?? 0];
    const box = query.box;
    if (
      box !== undefined &&
      !(p[0] >= box.min[0] && p[0] <= box.max[0] && p[1] >= box.min[1] && p[1] <= box.max[1] && p[2] >= box.min[2] && p[2] <= box.max[2])
    )
      continue;
    if (
      query.sphere !== undefined &&
      Math.hypot(p[0] - query.sphere.centre[0], p[1] - query.sphere.centre[1], p[2] - query.sphere.centre[2]) > query.sphere.radius
    )
      continue;
    yield { p, index: node.indices[k] ?? 0 };
  }
}

/** Nodes of a point budget (TECHNICAL_SPEC §5.3), same rule as `llull-cloud` `Asset::lod_budget`: largest projected size first. */
function budgetNodes(reader: AssetReader, centre: Vec3, budget: number, query: CloudQuery): number[] {
  const priority = (i: number): number => {
    const box = reader.nodeBounds(i);
    const diagonal = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    const gap = boxDistance(box, centre);
    return gap > 0 ? diagonal / gap : Infinity;
  };
  const inside = (i: number): boolean => query.box === undefined || boxesMeet(reader.nodeBounds(i), query.box);
  const queue: { i: number; w: number }[] = reader.nodes.length > 0 && inside(0) ? [{ i: 0, w: priority(0) }] : [];
  const selected: number[] = [];
  let total = 0;
  while (queue.length > 0) {
    let best = 0;
    for (let k = 1; k < queue.length; k++) {
      const a = queue[k];
      const b = queue[best];
      if (a !== undefined && b !== undefined && (a.w > b.w || (a.w === b.w && a.i < b.i))) best = k;
    }
    const [next] = queue.splice(best, 1);
    if (next === undefined) break;
    const count = reader.nodes[next.i]?.pointCount ?? 0;
    if (total + count > budget) break;
    total += count;
    selected.push(next.i);
    for (const child of reader.children(next.i)) if (inside(child)) queue.push({ i: child, w: priority(child) });
  }
  return selected.sort((a, b) => a - b);
}

function runQuery(reader: AssetReader, query: CloudQuery): CloudPoints {
  const centre: Vec3 =
    query.sphere?.centre ??
    (query.box !== undefined
      ? ([0, 1, 2].map((a) => ((query.box?.min[a] ?? 0) + (query.box?.max[a] ?? 0)) / 2) as unknown as Vec3)
      : reader.manifest.centroid);
  const nodes =
    query.lod === 'full'
      ? reader.nodes.map((_, i) => i).filter((i) => query.box === undefined || boxesMeet(reader.nodeBounds(i), query.box))
      : budgetNodes(reader, centre, query.lod.budget, query);
  const positions: number[] = [];
  const indices: number[] = [];
  let truncated = false;
  let deepest = 0;
  outer: for (const i of nodes) {
    for (const { p, index } of pointsIn(reader, i, query)) {
      if (indices.length >= query.maxPoints) {
        truncated = true;
        break outer;
      }
      positions.push(p[0], p[1], p[2]);
      indices.push(index);
      deepest = Math.max(deepest, reader.nodes[i]?.level ?? 0);
    }
  }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices), truncated, spacing: reader.spacing(deepest) };
}

function runNearest(reader: AssetReader, point: Vec3, maxDistance: number): CloudNearest | null {
  let best: { index: number; position: Vec3; distance: number } | null = null;
  let second = Infinity;
  reader.nodes.forEach((_, i) => {
    const gap = boxDistance(reader.nodeBounds(i), point);
    if (gap > maxDistance || gap > second) return;
    for (const { p, index } of pointsIn(reader, i, { lod: 'full', maxPoints: Infinity })) {
      const d = Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]);
      if (best !== null && d >= best.distance) second = Math.min(second, d);
      else {
        if (best !== null) second = Math.min(second, best.distance);
        best = { index, position: p, distance: d };
      }
    }
  });
  const found = best as { index: number; position: Vec3; distance: number } | null;
  return found === null || found.distance > maxDistance ? null : { ...found, secondDistance: second };
}

const failure = (code: string, message: string): CloudOpResult => ({ ok: false, code, message });

/** Parses the NDJSON events of a finished `llull-compute` run: the `done` outputs or the `error`. */
function terminal(stdout: string): { outputs: { path: string; sha256: string }[] } | { code: string; message: string } | null {
  let found: { outputs: { path: string; sha256: string }[] } | { code: string; message: string } | null = null;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event['type'] === 'error') found = { code: String(event['code']), message: String(event['message']) };
    if (event['type'] === 'done' && Array.isArray(event['outputs']))
      found = { outputs: event['outputs'].filter(isRecord).map((o) => ({ path: String(o['path']), sha256: String(o['sha256']) })) };
  }
  return found;
}

function runCompute(store: string, binary: string | null, env: NodeJS.ProcessEnv, op: CloudOp): CloudOpResult | null {
  if (!op.clouds.every((cloud) => isAssetKey(cloud.assetKey) && AssetReader.open(assetDir(store, cloud.assetKey), cloud.assetKey) !== null))
    return null;
  if (binary === null) return failure('NATIVE_TOOL_MISSING', nativeInstallHint('llull-compute'));
  const folder = mkdtempSync(path.join(tmpdir(), 'llull-cloud-op-'));
  try {
    const job = {
      version: 1,
      kind: op.kind,
      clouds: op.clouds.map((c) => ({ ...c, dir: assetDir(store, c.assetKey) })),
      params: op.params,
    };
    writeFileSync(path.join(folder, 'job.json'), JSON.stringify(job));
    const seconds = Number(env['LLULL_SCAN_OP_TIMEOUT_S'] ?? DEFAULT_OP_TIMEOUT_S);
    const started = Date.now();
    const run = spawnSync(binary, ['cloud', 'op', folder], {
      cwd: folder,
      env,
      encoding: 'utf8',
      timeout: (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_OP_TIMEOUT_S) * 1000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const elapsedMs = Date.now() - started;
    if (run.error !== undefined) {
      const timedOut = (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      return failure(timedOut ? 'NATIVE_TIMEOUT' : 'NATIVE_TOOL_MISSING', `llull-compute cloud op: ${run.error.message}`);
    }
    const end = terminal(run.stdout);
    if (end === null)
      return failure('NATIVE_PROTOCOL', `llull-compute exited with ${String(run.status)} without a final event: ${run.stderr.slice(-500)}`);
    if ('code' in end) return failure(end.code, end.message);
    const output = end.outputs.find((o) => o.path === 'result.json');
    if (output === undefined) return failure('NATIVE_PROTOCOL', 'the op did not report result.json');
    const bytes = readFileSync(path.join(folder, 'result.json'));
    if (createHash('sha256').update(bytes).digest('hex') !== output.sha256)
      return failure('NATIVE_PROTOCOL', 'result.json does not match its reported sha256');
    const result: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(result)) return failure('NATIVE_PROTOCOL', 'result.json is not an object');
    const device = result['device'] === 'gpu' ? 'gpu' : 'cpu';
    const version = /llull-compute\s+(\S+)/.exec(spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout ?? '')?.[1] ?? 'unknown';
    return {
      ok: true,
      result,
      provenance: { binary: `llull-compute ${version}`, device, deterministic: result['deterministic'] !== false, elapsedMs },
    };
  } finally {
    if (env['LLULL_NATIVE_KEEP'] !== '1') rmSync(folder, { recursive: true, force: true });
  }
}

let shared: { readonly key: string; readonly port: PointCloudPort } | null = null;

/** The process port over `LLULL_SCAN_CACHE` (one per store + binary, so asset readers stay cached across commands). */
export function defaultPointCloudPort(env: NodeJS.ProcessEnv = process.env): PointCloudPort {
  const binary = nativeBinaryPath('llull-compute', env);
  const key = `${scanCacheDir(env)}|${binary ?? ''}`;
  if (shared === null || shared.key !== key) shared = { key, port: createPointCloudPort({ env, binary }) };
  return shared.port;
}

/** The port over the store (readers cached per key). */
export function createPointCloudPort(options: PointCloudPortOptions = {}): PointCloudPort {
  const env = options.env ?? process.env;
  const store = options.store ?? scanCacheDir(env);
  const binary = options.binary !== undefined ? options.binary : nativeBinaryPath('llull-compute', env);
  const readers = new Map<string, AssetReader | null>();
  const reader = (key: string): AssetReader | null => {
    if (!isAssetKey(key)) return null;
    const known = readers.get(key);
    if (known !== undefined && known !== null) return known;
    const opened = AssetReader.open(assetDir(store, key), key);
    if (opened !== null) readers.set(key, opened);
    return opened;
  };
  return {
    manifest: (key) => reader(key)?.manifest ?? null,
    query: (key, query) => {
      const opened = reader(key);
      return opened === null ? null : runQuery(opened, query);
    },
    nearest: (key, point, maxDistance) => {
      const opened = reader(key);
      return opened === null ? null : runNearest(opened, point, maxDistance);
    },
    compute: (op) => runCompute(store, binary, env, op),
  };
}
