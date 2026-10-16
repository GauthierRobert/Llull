import { describe, expect, it } from 'vitest';
import type { MeshData, Vec3 } from '@core/model/types';
import { type RigidTransform, buildMeshBvh, bvhIntersects, bvhMinDistance, bvhRayCast } from '@core/geometry/meshBvh';
import {
  type Triangle,
  closestPointOnTriangle,
  closestPointsOfSegments,
  rayTriangleDistance,
  segmentPiercesTriangle,
  triangleDistance,
} from '@core/geometry/triangleQueries';

/** Seeded generator (mulberry32): the tests never depend on Math.random. */
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

function randomSoup(random: () => number, triangles: number, extent: number, size: number, offset: Vec3): MeshData {
  const positions: number[] = [];
  for (let t = 0; t < triangles; t++) {
    const base: Vec3 = [random() * extent + offset[0], random() * extent + offset[1], random() * extent + offset[2]];
    for (let k = 0; k < 3; k++)
      positions.push(base[0] + (random() - 0.5) * size, base[1] + (random() - 0.5) * size, base[2] + (random() - 0.5) * size);
  }
  return {
    positions,
    indices: positions
      .map((_, i) => i)
      .filter((i) => i % 3 === 0)
      .map((i) => i / 3),
  };
}

const trianglesOf = (mesh: MeshData): Triangle[] => {
  const out: Triangle[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const corner = (k: number): Vec3 => {
      const v = (mesh.indices[i + k] ?? 0) * 3;
      return [mesh.positions[v] ?? 0, mesh.positions[v + 1] ?? 0, mesh.positions[v + 2] ?? 0];
    };
    out.push([corner(0), corner(1), corner(2)]);
  }
  return out;
};

const rotationAbout = (axis: Vec3, angle: number): RigidTransform['rotation'] => {
  const length = Math.hypot(...axis);
  const [x, y, z] = axis.map((c) => c / length) as [number, number, number];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  return [
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
  ];
};

const move = (t: RigidTransform, [x, y, z]: Vec3): Vec3 => {
  const r = t.rotation;
  return [
    r[0] * x + r[1] * y + r[2] * z + t.translation[0],
    r[3] * x + r[4] * y + r[5] * z + t.translation[1],
    r[6] * x + r[7] * y + r[8] * z + t.translation[2],
  ];
};

describe('triangleQueries primitives', () => {
  const tri: Triangle = [
    [0, 0, 0],
    [4, 0, 0],
    [0, 4, 0],
  ];

  it('closest point covers face, edge and vertex regions', () => {
    expect(closestPointOnTriangle([1, 1, 3], tri)).toEqual([1, 1, 0]);
    expect(closestPointOnTriangle([2, -3, 0], tri)).toEqual([2, 0, 0]);
    expect(closestPointOnTriangle([-2, -2, 1], tri)).toEqual([0, 0, 0]);
    expect(closestPointOnTriangle([9, 0, 0], tri)).toEqual([4, 0, 0]);
    expect(closestPointOnTriangle([0, 9, 0], tri)).toEqual([0, 4, 0]);
    expect(closestPointOnTriangle([4, 4, 0], tri)).toEqual([2, 2, 0]);
    expect(closestPointOnTriangle([0, 2, 5], tri)).toEqual([0, 2, 0]);
    expect(closestPointOnTriangle([-3, 9, 0], tri)).toEqual([0, 4, 0]);
  });

  it('segment-segment distance handles crossing, parallel, degenerate cases', () => {
    expect(closestPointsOfSegments([0, 0, 0], [2, 0, 0], [1, -1, 1], [1, 1, 1]).distance).toBeCloseTo(1, 12);
    expect(closestPointsOfSegments([0, 0, 0], [2, 0, 0], [0, 1, 0], [2, 1, 0]).distance).toBeCloseTo(1, 12);
    expect(closestPointsOfSegments([0, 0, 0], [0, 0, 0], [3, 4, 0], [3, 4, 0]).distance).toBeCloseTo(5, 12);
    expect(closestPointsOfSegments([0, 0, 0], [0, 0, 0], [3, 0, 0], [3, 4, 0]).distance).toBeCloseTo(3, 12);
    expect(closestPointsOfSegments([0, 0, 0], [2, 0, 0], [5, 0, 0], [5, 0, 0]).distance).toBeCloseTo(3, 12);
    expect(closestPointsOfSegments([0, 0, 0], [2, 0, 0], [4, 1, 0], [6, 1, 0]).distance).toBeCloseTo(Math.hypot(2, 1), 12);
    expect(closestPointsOfSegments([0, 0, 0], [2, 0, 0], [1, 5, 0], [3, 5, 0]).distance).toBeCloseTo(5, 12);
    expect(closestPointsOfSegments([0, 0, 0], [2, 0, 0], [-1, 1, 0], [-3, 1, 0]).distance).toBeCloseTo(Math.hypot(1, 1), 12);
  });

  it('triangle distance: apart, touching, piercing, coplanar overlap', () => {
    const apart: Triangle = [
      [0, 0, 2],
      [4, 0, 2],
      [0, 4, 2],
    ];
    expect(triangleDistance(tri, apart).distance).toBeCloseTo(2, 12);
    const touching: Triangle = [
      [1, 1, 0],
      [1, 1, 3],
      [2, 1, 3],
    ];
    expect(triangleDistance(tri, touching).distance).toBe(0);
    const piercing: Triangle = [
      [1, 1, -1],
      [1, 1, 1],
      [3, 3, 1],
    ];
    const pierced = triangleDistance(tri, piercing);
    expect(pierced.distance).toBe(0);
    expect(pierced.pointA[2]).toBeCloseTo(0, 12);
    const coplanar: Triangle = [
      [1, 1, 0],
      [5, 1, 0],
      [1, 5, 0],
    ];
    expect(triangleDistance(tri, coplanar).distance).toBeLessThan(1e-12);
    const separated: Triangle = [
      [10, 0, 0],
      [12, 0, 0],
      [10, 2, 0],
    ];
    expect(triangleDistance(tri, separated).distance).toBeCloseTo(6, 12);
  });

  it('segment-triangle and ray-triangle intersections', () => {
    expect(segmentPiercesTriangle([1, 1, -1], [1, 1, 1], tri)).toEqual([1, 1, 0]);
    expect(segmentPiercesTriangle([1, 1, 1], [1, 1, 2], tri)).toBeNull();
    expect(segmentPiercesTriangle([0, 0, 1], [1, 0, 1], tri)).toBeNull();
    expect(segmentPiercesTriangle([5, 5, -1], [5, 5, 1], tri)).toBeNull();
    expect(rayTriangleDistance([1, 1, 5], [0, 0, -1], tri, 0, 10)).toBeCloseTo(5, 12);
    expect(rayTriangleDistance([1, 1, 5], [0, 0, -1], tri, 0, 4)).toBeNull();
    expect(rayTriangleDistance([1, 1, 5], [0, 0, 1], tri, 0, 10)).toBeNull();
    expect(rayTriangleDistance([1, 1, 5], [1, 0, 0], tri, 0, 10)).toBeNull();
    expect(rayTriangleDistance([9, 9, 5], [0, 0, -1], tri, 0, 10)).toBeNull();
    expect(rayTriangleDistance([1, -1, 5], [0, 0, -1], tri, 0, 10)).toBeNull();
  });
});

describe('meshBvh against brute force', () => {
  it.each([1, 2, 3, 4, 5])('minDistance and intersects agree with all-pairs (seed %i)', (seed) => {
    const random = seeded(seed);
    const meshA = randomSoup(random, 120, 10, 1.5, [0, 0, 0]);
    const meshB = randomSoup(random, 90, 8, 1.2, [0, 0, 0]);
    const transform: RigidTransform = {
      rotation: rotationAbout([random() + 0.1, random(), random()], random() * 3),
      translation: [random() * 12, random() * 12, random() * 12],
    };
    const bvhA = buildMeshBvh(meshA);
    const bvhB = buildMeshBvh(meshB);
    const trianglesA = trianglesOf(meshA);
    const trianglesB = trianglesOf(meshB).map((t): Triangle => [move(transform, t[0]), move(transform, t[1]), move(transform, t[2])]);
    let expected = Infinity;
    for (const a of trianglesA) for (const b of trianglesB) expected = Math.min(expected, triangleDistance(a, b).distance);
    const found = bvhMinDistance(bvhA, bvhB, 1e9, transform);
    expect(found).not.toBeNull();
    expect(found?.distance).toBeCloseTo(expected, 9);
    expect(bvhMinDistance(bvhA, bvhB, expected / 2 - 1e-9, transform)).toBeNull();
    expect(bvhIntersects(bvhA, bvhB, transform)).toBe(expected <= 0);
    expect(bvhIntersects(bvhA, bvhB, transform, expected + 1e-9)).toBe(true);
    const again = bvhMinDistance(buildMeshBvh(meshA), buildMeshBvh(meshB), 1e9, transform);
    expect(again).toEqual(found);
  });

  it('a pair of overlapping soups intersects and reports distance 0 with a witness', () => {
    const random = seeded(77);
    const bvhA = buildMeshBvh(randomSoup(random, 200, 4, 2, [0, 0, 0]));
    const bvhB = buildMeshBvh(randomSoup(random, 200, 4, 2, [0, 0, 0]));
    expect(bvhIntersects(bvhA, bvhB)).toBe(true);
    expect(bvhMinDistance(bvhA, bvhB, 1)?.distance).toBe(0);
  });

  it.each([11, 12, 13])('rayCast returns the nearest hit like brute force (seed %i)', (seed) => {
    const random = seeded(seed);
    const mesh = randomSoup(random, 300, 10, 2, [0, 0, 0]);
    const bvh = buildMeshBvh(mesh);
    const triangles = trianglesOf(mesh);
    for (let r = 0; r < 40; r++) {
      const origin: Vec3 = [random() * 14 - 2, random() * 14 - 2, random() * 14 - 2];
      const direction: Vec3 = [random() - 0.5, random() - 0.5, random() - 0.5];
      let bestT = Infinity;
      let bestIndex = -1;
      triangles.forEach((tri, index) => {
        const t = rayTriangleDistance(origin, direction, tri, 1e-6, 50);
        if (t !== null && t < bestT) {
          bestT = t;
          bestIndex = index;
        }
      });
      const hit = bvhRayCast(bvh, origin, direction, 50, 1e-6);
      if (bestIndex < 0) expect(hit).toBeNull();
      else {
        expect(hit?.t).toBeCloseTo(bestT, 12);
        expect(hit?.triangle).toBe(bestIndex);
      }
    }
  });

  it('an empty mesh never hits and axis-parallel rays are handled', () => {
    const empty = buildMeshBvh({ positions: [], indices: [] });
    const box = buildMeshBvh({ positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] });
    expect(empty.triangleCount).toBe(0);
    expect(bvhRayCast(empty, [0, 0, 0], [0, 0, 1], 10)).toBeNull();
    expect(bvhIntersects(empty, box)).toBe(false);
    expect(bvhMinDistance(box, empty, 10)).toBeNull();
    expect(bvhRayCast(box, [0.5, 0.5, 3], [0, 0, -1], 10)?.t).toBeCloseTo(3, 12);
    expect(bvhRayCast(box, [5, 0.5, 3], [0, 0, -1], 10)).toBeNull();
    expect(bvhRayCast(box, [0.5, 0.5, 3], [0, 0, -1], 2)).toBeNull();
  });
});
