/**
 * In-memory `PointCloudPort` for the scan plugin tests: brute-force manifest / query / nearest over a few synthetic points, and a `compute`
 * that records each op and answers with a scripted result (the numerics are tested natively in `llull-cloud` and end to end in server/tests).
 */

import type { CloudManifest, CloudOp, CloudOpResult, CloudOpSuccess, PointCloudPort } from '@core/model/pointCloud';
import type { ExecutionContext } from '@core/commands/types';
import type { Vec3 } from '@core/model/vectors';
import { defaultContext } from '@core/commands/context';

export const KEY_A = 'a'.repeat(64);
export const KEY_B = 'b'.repeat(64);

export interface FixtureCloud {
  readonly key: string;
  readonly points: readonly Vec3[];
  readonly attributes?: CloudManifest['attributes'];
}

function manifestOf(cloud: FixtureCloud): CloudManifest {
  const axis = (a: number, pick: (x: number, y: number) => number): number =>
    cloud.points.map((p) => p[a] ?? 0).reduce((x, y) => pick(x, y));
  const n = cloud.points.length;
  return {
    assetVersion: 1,
    assetKey: cloud.key,
    sourceSha256: 'c'.repeat(64),
    sourceName: `${cloud.key.slice(0, 4)}.e57`,
    format: 'e57',
    importerVersion: 'llull-cloud@0.1.0/asset-1',
    unit: 'm',
    pointCount: n,
    dropped: 0,
    scans: [
      {
        guid: 'g',
        name: null,
        pointCount: n,
        recordCount: n,
        pose: { rotationWxyz: [1, 0, 0, 0], translation: [0, 0, 0] },
        stationOrigin: null,
        fields: ['cartesianX'],
      },
    ],
    bounds: {
      min: [axis(0, Math.min), axis(1, Math.min), axis(2, Math.min)],
      max: [axis(0, Math.max), axis(1, Math.max), axis(2, Math.max)],
    },
    centroid: [0, 1, 2].map((a) => cloud.points.reduce((s, p) => s + (p[a] ?? 0), 0) / n) as unknown as Vec3,
    quantum: [1e-7, 1e-7, 1e-7],
    offset: [0, 0, 0],
    attributes: cloud.attributes ?? [],
    octree: { depth: 1, rootBits: 24, rootMin: [0, 0, 0], rootSpacing: 0.01, maxPointsPerNode: 20000, nodeCount: 1 },
    warnings: [],
  };
}

export interface FixturePort extends PointCloudPort {
  readonly ops: CloudOp[];
}

export function fixturePort(clouds: readonly FixtureCloud[], answer: (op: CloudOp) => CloudOpResult | null = () => null): FixturePort {
  const find = (key: string): FixtureCloud | undefined => clouds.find((c) => c.key === key);
  const ops: CloudOp[] = [];
  return {
    ops,
    manifest: (key) => {
      const cloud = find(key);
      return cloud === undefined ? null : manifestOf(cloud);
    },
    query: (key, query) => {
      const cloud = find(key);
      if (cloud === undefined) return null;
      const inside = cloud.points
        .map((p, index) => ({ p, index }))
        .filter(
          ({ p }) =>
            query.box === undefined ||
            [0, 1, 2].every((a) => (p[a] ?? 0) >= (query.box?.min[a] ?? 0) && (p[a] ?? 0) <= (query.box?.max[a] ?? 0)),
        );
      const limit = query.lod === 'full' ? query.maxPoints : Math.min(query.maxPoints, query.lod.budget);
      const kept = inside.slice(0, limit);
      return {
        positions: Float64Array.from(kept.flatMap(({ p }) => [...p])),
        indices: Uint32Array.from(kept.map(({ index }) => index)),
        truncated: kept.length < inside.length,
        spacing: 0.01,
      };
    },
    nearest: (key, point, maxDistance) => {
      const cloud = find(key);
      if (cloud === undefined) return null;
      const ranked = cloud.points
        .map((p, index) => ({ index, position: p, distance: Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]) }))
        .sort((a, b) => a.distance - b.distance || a.index - b.index);
      const [best, second] = ranked;
      return best === undefined || best.distance > maxDistance ? null : { ...best, secondDistance: second?.distance ?? Infinity };
    },
    compute: (op) => {
      if (!op.clouds.every((c) => find(c.assetKey) !== undefined)) return null;
      ops.push(op);
      return answer(op);
    },
  };
}

export const withPort = (port: PointCloudPort | null): ExecutionContext => ({ ...defaultContext(), pointClouds: port });

/** A successful op result with CPU provenance. */
export const opOk = (result: Record<string, unknown>, device: 'cpu' | 'gpu' = 'cpu'): CloudOpSuccess => ({
  ok: true,
  result,
  provenance: { binary: 'llull-compute 0.1.0', device, deterministic: device === 'cpu', elapsedMs: 1 },
});
