/**
 * Native `GeometryQueryEngine` (PHY-21 TR-FPR-19, PHY-03 TR-THM-20, RS1 RS-6): each batch runs `llull-compute geomq` on a job folder
 * (`job.json` + little-endian f64 files, contract in `solver/crates/llull-geomq/src/lib.rs`). Commands are synchronous, so the job runs
 * with spawnSync and the caller blocks (PHY-21 §11 item 10: blocking call in the MVP). The Rust CPU path reproduces the TypeScript
 * engine bit for bit (VC-FPR-37, VC-THM-64), so `deterministic: true`; it lifts the TS caps (`limits`). A failed run (crash, timeout,
 * protocol) is logged and that batch is answered by the TS engine, whose numbers are the same; provenance then names `meshBvh`.
 * Installed by the CLI and the backend only when the binary exists. Environment: LLULL_COMPUTE / LLULL_NATIVE_DIR, LLULL_NATIVE_KEEP=1.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MeshData, Vec3 } from '@core/model/types';
import type { BvhDistance, BvhRayHit } from '@core/geometry/meshBvh';
import {
  type GeometryQueryEngine,
  type MeshRay,
  type PlacedDistanceQuery,
  type ViewFacet,
  meshBvhEngine,
  minDistanceByPlacement,
  setGeometryQueryEngine,
} from '@core/geometry/geometryQueries';
import { isRecord } from '@lib/isRecord';
import { errorMessage } from '@lib/errorMessage';
import { f64Bytes, f64Values } from './computeJob';
import { nativeBinaryPath } from './nativeBinary';

/** Named guard: the largest batches the limits admit finish far below this on a desktop CPU, process start included. */
const BATCH_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** A failed distance batch larger than this is not recomputed on TS (10⁵ unbounded queries take minutes there): it throws instead. */
const TS_FALLBACK_QUERIES = 10_000;

/** Measured caps (docs/physics/21 §12, docs/physics/03 §13; VC-FPR-37, VC-THM-64). */
export const NATIVE_GEOMETRY_LIMITS: GeometryQueryEngine['limits'] = {
  maxViewFactorFacets: 12_500,
  maxThicknessRays: 4_000_000,
  motionPrefetchQueries: 1_000_000,
};

type Files = Record<string, Buffer | string>;

/** Thrown inside a batch; caught by `guarded`, which falls back to the TS engine. */
class GeomqFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const cornersOf = (mesh: MeshData): number[] =>
  Array.from({ length: Math.floor(mesh.indices.length / 3) * 3 }, (_, k) => (mesh.indices[k] ?? 0) * 3).flatMap((vertex) => [
    mesh.positions[vertex] ?? 0,
    mesh.positions[vertex + 1] ?? 0,
    mesh.positions[vertex + 2] ?? 0,
  ]);

const meshRecord = (mesh: MeshData): number[] => {
  const corners = cornersOf(mesh);
  return [corners.length / 9, ...corners];
};

const facetRecord = (facet: ViewFacet, surface: number): number[] => [
  surface,
  ...facet.corners.flat(),
  ...facet.normal,
  ...facet.centroid,
  facet.area,
];

/** 16 numbers per query: a, b, placed, rotation (9), translation (3), maxDistance. */
function packQueries(queries: readonly PlacedDistanceQuery[]): Float64Array {
  const out = new Float64Array(queries.length * 16);
  queries.forEach((q, k) => {
    out[k * 16] = q.a;
    out[k * 16 + 1] = q.b;
    if (q.placement !== null) {
      out[k * 16 + 2] = 1;
      out.set(q.placement.rotation, k * 16 + 3);
      out.set(q.placement.translation, k * 16 + 12);
    }
    out[k * 16 + 15] = q.maxDistance;
  });
  return out;
}

/** 8 numbers per ray: origin (3), direction (3), tMin, maxT. */
function packRays(rays: readonly MeshRay[], maxT: number): Float64Array {
  const out = new Float64Array(rays.length * 8);
  rays.forEach((ray, k) => {
    out.set(ray.origin, k * 8);
    out.set(ray.direction, k * 8 + 3);
    out[k * 8 + 6] = ray.tMin ?? 0;
    out[k * 8 + 7] = maxT;
  });
  return out;
}

const nanToNull = (value: number | undefined): number | null => (value === undefined || Number.isNaN(value) ? null : value);

/** The done-event outputs of a finished run, or its error event. */
function outcomeOf(stdout: string): { outputs: Map<string, string> } | { code: string; message: string } | null {
  for (const line of stdout.split('\n').reverse()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event['type'] === 'error') return { code: String(event['code']), message: String(event['message']) };
    if (event['type'] === 'done' && Array.isArray(event['outputs']))
      return { outputs: new Map(event['outputs'].filter(isRecord).map((output) => [String(output['path']), String(output['sha256'])])) };
  }
  return null;
}

/** Runs one `geomq` job and returns `result.f64`; throws GeomqFailure. */
function runJob(binary: string, env: NodeJS.ProcessEnv, files: Files): Float64Array {
  const folder = mkdtempSync(path.join(tmpdir(), 'llull-geomq-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(folder, name), content);
    const run = spawnSync(binary, ['geomq', folder], {
      cwd: folder,
      env,
      encoding: 'utf8',
      timeout: BATCH_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (run.error !== undefined) {
      const code = (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'NATIVE_TIMEOUT' : 'NATIVE_PROTOCOL';
      throw new GeomqFailure(code, `llull-compute geomq: ${run.error.message}`);
    }
    const outcome = outcomeOf(run.stdout ?? '');
    if (outcome !== null && 'code' in outcome) throw new GeomqFailure(outcome.code, outcome.message);
    const sha = outcome?.outputs.get('result.f64');
    if (run.status !== 0 || sha === undefined)
      throw new GeomqFailure('NATIVE_PROTOCOL', `llull-compute geomq exited with ${String(run.status)} without result.f64`);
    const bytes = readFileSync(path.join(folder, 'result.f64'));
    if (createHash('sha256').update(bytes).digest('hex') !== sha)
      throw new GeomqFailure('NATIVE_PROTOCOL', 'result.f64 does not match the hash llull-compute reported');
    return f64Values(bytes);
  } finally {
    try {
      if (env['LLULL_NATIVE_KEEP'] !== '1') rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.warn(`[llull] geomq: could not remove ${folder}: ${errorMessage(error)}`);
    }
  }
}

const NATIVE_PROVENANCE: GeometryQueryEngine['provenance'] = { engine: 'llull-geomq', device: 'cpu', deterministic: true };

/** An engine running `binary`. */
export function createNativeGeometryQueryEngine(binary: string, env: NodeJS.ProcessEnv = process.env): GeometryQueryEngine {
  let fellBack = false;
  /** `native()` checked against `expected` items, else (logged) `fallback()`; `provenance` names the engine that answered the LAST batch. */
  const guarded = <T>(what: string, native: () => T[], expected: number, fallback: () => T[]): T[] => {
    try {
      const result = native();
      if (result.length !== expected) throw new GeomqFailure('NATIVE_PROTOCOL', `${result.length} results for ${expected} items`);
      fellBack = false;
      return result;
    } catch (error) {
      const code = error instanceof GeomqFailure ? error.code : 'NATIVE_PROTOCOL';
      console.warn(`[llull] geomq ${what} failed (${code}: ${errorMessage(error)}); answered by the TypeScript engine`);
      fellBack = true;
      return fallback();
    }
  };
  const engine: GeometryQueryEngine = {
    get provenance() {
      return fellBack ? meshBvhEngine.provenance : NATIVE_PROVENANCE;
    },
    limits: NATIVE_GEOMETRY_LIMITS,
    minDistanceBatch: (meshes, poses, pairs, maxDistance) =>
      minDistanceByPlacement(engine.placedDistanceBatch, meshes, poses, pairs, maxDistance),
    placedDistanceBatch(meshes, queries) {
      if (queries.length === 0) return [];
      return guarded(
        'distance',
        () => {
          const values = runJob(binary, env, {
            'job.json': JSON.stringify({ op: 'distance' }),
            'meshes.f64': f64Bytes(Float64Array.from([meshes.length, ...meshes.flatMap(meshRecord)])),
            'queries.f64': f64Bytes(packQueries(queries)),
          });
          return Array.from({ length: values.length / 7 }, (_, k): BvhDistance | null => {
            const at = (i: number): number => values[k * 7 + i] ?? 0;
            if (nanToNull(values[k * 7]) === null) return null;
            return { distance: at(0), pointA: [at(1), at(2), at(3)], pointB: [at(4), at(5), at(6)] };
          });
        },
        queries.length,
        () => {
          if (queries.length > TS_FALLBACK_QUERIES)
            throw new GeomqFailure('NATIVE_PROTOCOL', `${queries.length} distance queries are too many for the TypeScript fallback`);
          return meshBvhEngine.placedDistanceBatch(meshes, queries);
        },
      );
    },
    // only the TS view-factor reference calls it, and this engine answers `viewFactorExchange` itself
    segmentOcclusionBatch: (occluders, segments) => meshBvhEngine.segmentOcclusionBatch(occluders, segments),
    rayCastBatch(mesh, rays, maxT) {
      if (rays.length === 0) return [];
      return guarded(
        'ray',
        () => {
          const values = runJob(binary, env, {
            'job.json': JSON.stringify({ op: 'ray' }),
            'mesh.f64': f64Bytes(Float64Array.from(meshRecord(mesh))),
            'rays.f64': f64Bytes(packRays(rays, maxT)),
          });
          return Array.from({ length: values.length / 5 }, (_, k): BvhRayHit | null => {
            const at = (i: number): number => values[k * 5 + i] ?? 0;
            if (nanToNull(values[k * 5]) === null) return null;
            const point: Vec3 = [at(2), at(3), at(4)];
            return { t: at(0), triangle: at(1), point };
          });
        },
        rays.length,
        () => meshBvhEngine.rayCastBatch(mesh, rays, maxT),
      );
    },
    viewFactorExchange(surfaces, blockers) {
      if (surfaces.length === 0) return [];
      const n = surfaces.length;
      const rows = guarded<number[] | null>(
        'viewfactor',
        () => {
          const facets = [
            ...surfaces.flatMap((facetsOf, surface) => facetsOf.map((facet) => facetRecord(facet, surface))),
            ...(blockers ?? []).map((facet) => facetRecord(facet, -1)),
          ].flat();
          const values = runJob(binary, env, {
            'job.json': JSON.stringify({ op: 'viewfactor', surfaces: n, obstruction: blockers !== null }),
            'facets.f64': f64Bytes(Float64Array.from(facets)),
          });
          if (values.length !== n * n) throw new GeomqFailure('NATIVE_PROTOCOL', `${values.length} exchange values for ${n} surfaces`);
          return Array.from({ length: n }, (_, i) => Array.from(values.subarray(i * n, (i + 1) * n)));
        },
        n,
        () => [null],
      );
      // null: not answered here, the caller runs its TypeScript reference (same numbers)
      return rows.every((row) => row !== null) ? rows : null;
    },
  };
  return engine;
}

/** Installs the native engine as the process `ctx.geometryQueries` when `llull-compute` exists; returns whether it did. */
export function installGeometryQueryEngine(env: NodeJS.ProcessEnv = process.env): boolean {
  const binary = nativeBinaryPath('llull-compute', env);
  setGeometryQueryEngine(binary === null ? null : createNativeGeometryQueryEngine(binary, env));
  return binary !== null;
}
