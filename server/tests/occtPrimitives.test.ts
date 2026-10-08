/**
 * @layer server/tests
 * Live OpenCascade vs Manifold: cylinder, sphere and cone are placed (rotation + position) and
 * combined with a box the same way by both kernels. Meshes are tessellated, so bounds and volumes
 * agree within chord tolerance, not exactly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';

const common = { layerId: 'layer-default', color: '#888888' };
const cylinder = (position: Vec3, rotation: Vec3): Entity =>
  ({ id: 'c', kind: 'cylinder', position, rotation, radius: 2, height: 6, ...common }) as Entity;
const sphere = (position: Vec3, rotation: Vec3): Entity =>
  ({ id: 's', kind: 'sphere', position, rotation, radius: 3, ...common }) as Entity;
const cone = (position: Vec3, rotation: Vec3): Entity =>
  ({ id: 'k', kind: 'cone', position, rotation, radius: 2.5, height: 5, ...common }) as Entity;
const box = (position: Vec3, size: Vec3): Entity =>
  ({ id: 'b', kind: 'box', position, rotation: [0, 0, 0], size, ...common }) as Entity;

function bounds(mesh: MeshData): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? 0, mesh.positions[i + k] ?? 0);
      max[k] = Math.max(max[k] ?? 0, mesh.positions[i + k] ?? 0);
    }
  }
  return { min, max };
}

/** Signed volume by the divergence theorem: positive when the mesh is wound outward. */
function volume(mesh: MeshData): number {
  let sum = 0;
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => (mesh.indices[i + k] ?? 0) * 3) as [
      number,
      number,
      number,
    ];
    sum +=
      ((p[a] ?? 0) * ((p[b + 1] ?? 0) * (p[c + 2] ?? 0) - (p[b + 2] ?? 0) * (p[c + 1] ?? 0)) -
        (p[a + 1] ?? 0) * ((p[b] ?? 0) * (p[c + 2] ?? 0) - (p[b + 2] ?? 0) * (p[c] ?? 0)) +
        (p[a + 2] ?? 0) * ((p[b] ?? 0) * (p[c + 1] ?? 0) - (p[b + 1] ?? 0) * (p[c] ?? 0))) /
      6;
  }
  return sum;
}

let occt: GeometryKernel;
let manifold: GeometryKernel;

beforeAll(async () => {
  occt = await createNodeOcctKernel();
  manifold = await createManifoldKernel();
}, 120_000);

const CHORD_TOLERANCE = 0.25;
const placements: Array<[string, Vec3, Vec3]> = [
  ['origin', [0, 0, 0], [0, 0, 0]],
  ['translated', [5, -3, 2], [0, 0, 0]],
  ['rotated about X', [1, 2, 3], [Math.PI / 2, 0, 0]],
  ['rotated about all axes', [-2, 4, 1], [0.3, -0.5, 1.1]],
];
const shapes: Array<[string, (position: Vec3, rotation: Vec3) => Entity, number]> = [
  ['cylinder', cylinder, Math.PI * 2 * 2 * 6],
  ['sphere', sphere, (4 / 3) * Math.PI * 27],
  ['cone', cone, (Math.PI * 2.5 * 2.5 * 5) / 3],
];

describe.each(shapes)('occt %s', (name, make, analyticVolume) => {
  it.each(placements)('tessellates like Manifold (%s)', (_label, position, rotation) => {
    const entity = make(position, rotation);
    const [fromOcct, fromManifold] = [occt.tessellate(entity), manifold.tessellate(entity)];
    expect(fromOcct, name).not.toBeNull();
    expect(fromManifold, name).not.toBeNull();
    const [a, b] = [bounds(fromOcct!), bounds(fromManifold!)];
    for (let k = 0; k < 3; k++) {
      expect(Math.abs((a.min[k] ?? 0) - (b.min[k] ?? 0))).toBeLessThan(CHORD_TOLERANCE);
      expect(Math.abs((a.max[k] ?? 0) - (b.max[k] ?? 0))).toBeLessThan(CHORD_TOLERANCE);
    }
    expect(volume(fromOcct!) / analyticVolume).toBeGreaterThan(0.93);
    expect(volume(fromOcct!) / analyticVolume).toBeLessThan(1.02);
  });

  it.each(['union', 'subtract', 'intersect'] as const)(
    '%s with a box agrees with Manifold',
    (op) => {
      const entity = make([1, 1, 0], [0.4, 0.2, 0.7]);
      // Box top z=2.7 stays clear of the sphere pole (z=3): tangent contact can hang OCC booleans.
      const cutter = box([2, 1, 1], [5, 3, 3.4]);
      const [fromOcct, fromManifold] = [
        occt.booleanOp(op, entity, cutter),
        manifold.booleanOp(op, entity, cutter),
      ];
      expect(fromOcct, `${name} ${op}`).not.toBeNull();
      expect(fromManifold, `${name} ${op}`).not.toBeNull();
      expect(volume(fromOcct!) / volume(fromManifold!)).toBeGreaterThan(0.92);
      expect(volume(fromOcct!) / volume(fromManifold!)).toBeLessThan(1.08);
    },
  );

  it('rejects a non-positive size', () => {
    const degenerate = { ...make([0, 0, 0], [0, 0, 0]), radius: 0 } as Entity;
    expect(occt.tessellate(degenerate)).toBeNull();
  });
});

// Native OCC torus (exact surface). Manifold's torus is a coarser polygon, so volumes are compared
// to the analytic value for OCC and to Manifold within the chord tolerance of that polygon.
describe('occt torus', () => {
  const torus = (position: Vec3, rotation: Vec3): Entity =>
    ({
      id: 't',
      kind: 'torus',
      position,
      rotation,
      ringRadius: 3,
      tubeRadius: 1,
      ...common,
    }) as Entity;
  const analyticVolume = 2 * Math.PI ** 2 * 3 * 1 ** 2;

  it.each(placements)(
    'has the analytic volume and Manifold bounds (%s)',
    (_label, position, rotation) => {
      const entity = torus(position, rotation);
      const [fromOcct, fromManifold] = [occt.tessellate(entity), manifold.tessellate(entity)];
      expect(fromOcct).not.toBeNull();
      expect(fromManifold).not.toBeNull();
      expect(volume(fromOcct!) / analyticVolume).toBeGreaterThan(0.95);
      expect(volume(fromOcct!) / analyticVolume).toBeLessThan(1.01);
      const [a, b] = [bounds(fromOcct!), bounds(fromManifold!)];
      for (let k = 0; k < 3; k++) {
        expect(Math.abs((a.min[k] ?? 0) - (b.min[k] ?? 0))).toBeLessThan(CHORD_TOLERANCE);
        expect(Math.abs((a.max[k] ?? 0) - (b.max[k] ?? 0))).toBeLessThan(CHORD_TOLERANCE);
      }
    },
  );

  it.each(['union', 'subtract', 'intersect'] as const)(
    '%s with a box agrees with Manifold',
    (op) => {
      const entity = torus([0.3, 0.2, 0.1], [0.2, -0.1, 0.4]);
      const cutter = box([1.3, 0.7, 1.9], [3.1, 2.3, 2.7]);
      const [fromOcct, fromManifold] = [
        occt.booleanOp(op, entity, cutter),
        manifold.booleanOp(op, entity, cutter),
      ];
      expect(fromOcct).not.toBeNull();
      expect(volume(fromOcct!) / volume(fromManifold!)).toBeGreaterThan(0.92);
      expect(volume(fromOcct!) / volume(fromManifold!)).toBeLessThan(1.08);
    },
  );

  it.each([
    ['a zero tube radius', { tubeRadius: 0 }],
    ['a tube radius not smaller than the ring radius', { tubeRadius: 3 }],
  ])('rejects %s', (_label, change) => {
    const entity = { ...torus([0, 0, 0], [0, 0, 0]), ...change } as Entity;
    expect(occt.tessellate(entity)).toBeNull();
  });
});
