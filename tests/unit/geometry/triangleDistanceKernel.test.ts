import { describe, expect, it } from 'vitest';
import type { MeshData, Vec3 } from '@core/model/types';
import { type RigidTransform, buildMeshBvh, bvhIntersects, bvhMinDistance } from '@core/geometry/meshBvh';
import { triangleDistance } from '@core/geometry/triangleQueries';
import { legacyDualQuery, legacyTriangleDistance } from './legacyMeshDistance';

/** PERF1 #3: the allocation-free kernel is bit-identical to the frozen tuple implementation (legacyMeshDistance.ts). */

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bits = (values: readonly number[]): string => {
  const view = new DataView(new ArrayBuffer(8));
  return values
    .map((value) => {
      view.setFloat64(0, value);
      return `${view.getUint32(0).toString(16)}${view.getUint32(4).toString(16)}`;
    })
    .join(',');
};

type Tri = readonly [Vec3, Vec3, Vec3];
const flat = (result: { distance: number; pointA: Vec3; pointB: Vec3 } | null): string =>
  result === null ? 'null' : bits([result.distance, ...result.pointA, ...result.pointB]);

function degenerateTriangles(): Tri[] {
  return [
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ], // collinear
    [
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ], // a point
    [
      [0, 0, 1],
      [1, 0, 1],
      [0, 1, 1],
    ], // parallel above
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ], // identical
    [
      [1, 0, 0],
      [2, 0, 0],
      [1, 1, 0],
    ], // touching at a vertex
    [
      [0.5, 0, 0],
      [1.5, 0, 0],
      [0.5, 1, 0],
    ], // coplanar overlap
    [
      [0.2, 0.2, -1],
      [0.2, 0.2, 1],
      [0.4, 0.2, 1],
    ], // piercing
    [
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
    ], // zero-area
    [
      [-0, 0, 0],
      [-0, 1, 0],
      [0, 0, -0],
    ],
    [
      [1e-200, 0, 0],
      [0, 1e-200, 0],
      [0, 0, 1e-200],
    ],
    [
      [3, 3, 3],
      [4, 3, 3],
      [3, 4, 3],
    ],
  ];
}

describe('triangleDistance kernel against the frozen tuple implementation', () => {
  it('matches bit for bit on the degenerate catalogue (every ordered pair)', () => {
    const triangles = degenerateTriangles();
    for (const first of triangles)
      for (const second of triangles) {
        expect(flat(triangleDistance(first, second))).toBe(flat(legacyTriangleDistance(first, second)));
      }
  });

  it('matches bit for bit on 20 000 random pairs, including near-touching and integer-lattice ones', () => {
    const random = seeded(7);
    const point = (scale: number, lattice: boolean): Vec3 =>
      lattice
        ? [Math.round(random() * 3), Math.round(random() * 3), Math.round(random() * 3)]
        : [random() * scale, random() * scale, random() * scale];
    for (let n = 0; n < 20000; n++) {
      const lattice = n % 4 === 0;
      const scale = n % 3 === 0 ? 1 : 10;
      const first: Tri = [point(scale, lattice), point(scale, lattice), point(scale, lattice)];
      const second: Tri = [point(scale, lattice), point(scale, lattice), point(scale, lattice)];
      expect(flat(triangleDistance(first, second))).toBe(flat(legacyTriangleDistance(first, second)));
    }
  });
});

function soup(random: () => number, triangles: number, extent: number, size: number, offset: Vec3): MeshData {
  const positions: number[] = [];
  for (let t = 0; t < triangles; t++) {
    const base = [random() * extent + offset[0], random() * extent + offset[1], random() * extent + offset[2]];
    for (let k = 0; k < 3; k++) for (let axis = 0; axis < 3; axis++) positions.push((base[axis] ?? 0) + (random() - 0.5) * size);
  }
  return { positions, indices: Array.from({ length: triangles * 3 }, (_, i) => i) };
}

const rotationZ = (angle: number): RigidTransform['rotation'] => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

describe('mesh BVH distance query against the frozen dual query', () => {
  it('returns identical distances and witnesses over transforms, bounds and stop thresholds', () => {
    const random = seeded(11);
    for (let round = 0; round < 40; round++) {
      const a = buildMeshBvh(soup(random, 10 + Math.floor(random() * 60), 10, 2, [0, 0, 0]));
      const b = buildMeshBvh(soup(random, 10 + Math.floor(random() * 60), 10, 2, [random() * 12, random() * 6, 0]));
      const transform: RigidTransform | null =
        round % 3 === 0 ? null : { rotation: rotationZ(random() * 6), translation: [random() * 4 - 2, random() * 4, random() * 2] };
      for (const max of [0.05, 0.5, 3, 100]) {
        expect(flat(bvhMinDistance(a, b, max, transform))).toBe(flat(legacyDualQuery(a, b, transform, max, 0)));
      }
      for (const tolerance of [0, 0.25]) {
        expect(bvhIntersects(a, b, transform, tolerance)).toBe(legacyDualQuery(a, b, transform, tolerance, tolerance) !== null);
      }
    }
  });

  it('agrees on empty meshes and on a leaf larger than the scratch default', () => {
    const empty = buildMeshBvh({ positions: [], indices: [] });
    const some = buildMeshBvh(soup(seeded(3), 5, 2, 1, [0, 0, 0]));
    expect(bvhMinDistance(empty, some, 10)).toBeNull();
    expect(bvhMinDistance(some, empty, 10)).toBeNull();
    const padded = buildMeshBvh(soup(seeded(4), 20, 2, 1, [0, 0, 0]));
    const loose = {
      ...padded,
      left: Int32Array.from([-1]),
      right: Int32Array.from([-1]),
      start: Int32Array.from([0]),
      count: Int32Array.from([20]),
    };
    expect(flat(bvhMinDistance(some, loose, 100))).toBe(flat(legacyDualQuery(some, loose, null, 100, 0)));
  });
});
