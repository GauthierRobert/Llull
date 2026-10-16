import { describe, expect, it } from 'vitest';
import { buildMeshBvh, bvhIntersects, bvhMinDistance, bvhRayCast } from '@core/geometry/meshBvh';

/** n copies of the same unit triangle at z = 0 (identical hit distance: the lower index must win). */
function stackedTriangles(count: number, z = 0): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < count; t++) {
    positions.push(0, 0, z, 4, 0, z, 0, 4, z);
    indices.push(t * 3, t * 3 + 1, t * 3 + 2);
  }
  return { positions, indices };
}

describe('meshBvh edge cases', () => {
  it('coincident triangles across several leaves: the lowest triangle index wins a tie', () => {
    const bvh = buildMeshBvh(stackedTriangles(40));
    expect(bvh.left.length).toBeGreaterThan(1);
    const hit = bvhRayCast(bvh, [1, 1, 5], [0, 0, -1], 100);
    expect(hit?.t).toBeCloseTo(5, 12);
    expect(hit?.triangle).toBe(0);
  });

  it('rejects boxes whose slab the ray misses, handles zero direction components and tMin', () => {
    const bvh = buildMeshBvh(stackedTriangles(20));
    expect(bvhRayCast(bvh, [1, 1, 5], [0, 0, -1], 100, 6)).toBeNull();
    expect(bvhRayCast(bvh, [9, 1, 5], [0, 0, -1], 100)).toBeNull();
    expect(bvhRayCast(bvh, [1, 1, 5], [1, 0, 0], 100)).toBeNull();
    expect(bvhRayCast(bvh, [1, 1, -5], [0, 0, 1], 100)?.t).toBeCloseTo(5, 12);
    expect(bvhRayCast(bvh, [1, 1, 5], [0, 0, -1], 4)).toBeNull();
  });

  it('distance and intersection with a rigid transform that rotates and moves the other mesh', () => {
    const a = buildMeshBvh(stackedTriangles(20));
    const b = buildMeshBvh(stackedTriangles(20, 0));
    const lifted = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, translation: [0, 0, 3] as [number, number, number] };
    expect(bvhMinDistance(a, b, 10, lifted)?.distance).toBeCloseTo(3, 12);
    expect(bvhMinDistance(a, b, 2, lifted)).toBeNull();
    expect(bvhIntersects(a, b, lifted)).toBe(false);
    expect(bvhIntersects(a, b, lifted, 3.5)).toBe(true);
    const turned = { rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0] as const, translation: [0, 0, 0] as [number, number, number] };
    expect(bvhIntersects(a, b, turned)).toBe(true);
  });
});
