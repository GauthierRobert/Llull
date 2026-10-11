/**
 * @layer server/tests
 * Live OpenCascade vs Manifold: cylinder, sphere and cone are placed (rotation + position) and
 * combined with a box the same way by both kernels. Meshes are tessellated, so bounds and volumes
 * agree within chord tolerance, not exactly.
 */

import { describe, it, expect } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import {
  ALL_AXES_PLACEMENT,
  ORIGIN_PLACEMENT,
  TRANSLATED_PLACEMENT,
  type Placement,
  bothMeshes,
  box,
  common,
  expectBooleanAgrees,
  expectBoundsClose,
  liveKernels,
  meshOf,
  volume,
} from './kernelTestSupport';

const cylinder = (position: Vec3, rotation: Vec3): Entity =>
  ({ id: 'c', kind: 'cylinder', position, rotation, radius: 2, height: 6, ...common }) as Entity;
const sphere = (position: Vec3, rotation: Vec3): Entity =>
  ({ id: 's', kind: 'sphere', position, rotation, radius: 3, ...common }) as Entity;
const cone = (position: Vec3, rotation: Vec3): Entity =>
  ({ id: 'k', kind: 'cone', position, rotation, radius: 2.5, height: 5, ...common }) as Entity;

const kernels = liveKernels();

const CHORD_TOLERANCE = 0.25;
const placements: Placement[] = [
  ORIGIN_PLACEMENT,
  TRANSLATED_PLACEMENT,
  ['rotated about X', [1, 2, 3], [Math.PI / 2, 0, 0]],
  ALL_AXES_PLACEMENT,
];
const shapes: Array<[string, (position: Vec3, rotation: Vec3) => Entity, number]> = [
  ['cylinder', cylinder, Math.PI * 2 * 2 * 6],
  ['sphere', sphere, (4 / 3) * Math.PI * 27],
  ['cone', cone, (Math.PI * 2.5 * 2.5 * 5) / 3],
];

describe.each(shapes)('occt %s', (name, make, analyticVolume) => {
  it.each(placements)('tessellates like Manifold (%s)', (_label, position, rotation) => {
    const entity = make(position, rotation);
    const { fromOcct, fromManifold } = bothMeshes(kernels, entity, name);
    expectBoundsClose(fromOcct, fromManifold, CHORD_TOLERANCE);
    expect(volume(fromOcct) / analyticVolume).toBeGreaterThan(0.93);
    expect(volume(fromOcct) / analyticVolume).toBeLessThan(1.02);
  });

  it.each(['union', 'subtract', 'intersect'] as const)(
    '%s with a box agrees with Manifold',
    (op) => {
      const entity = make([1, 1, 0], [0.4, 0.2, 0.7]);
      // Box top z=2.7 stays clear of the sphere pole (z=3): tangent contact can hang OCC booleans.
      const cutter = box([2, 1, 1], [5, 3, 3.4]);
      expectBooleanAgrees(kernels, op, entity, cutter, `${name} ${op}`);
    },
  );

  it('rejects a non-positive size', () => {
    const degenerate = { ...make([0, 0, 0], [0, 0, 0]), radius: 0 } as Entity;
    expect(meshOf(kernels.occt, degenerate)).toBeNull();
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
      const { fromOcct, fromManifold } = bothMeshes(kernels, entity);
      expect(volume(fromOcct) / analyticVolume).toBeGreaterThan(0.95);
      expect(volume(fromOcct) / analyticVolume).toBeLessThan(1.01);
      expectBoundsClose(fromOcct, fromManifold, CHORD_TOLERANCE);
    },
  );

  it.each(['union', 'subtract', 'intersect'] as const)(
    '%s with a box agrees with Manifold',
    (op) => {
      const entity = torus([0.3, 0.2, 0.1], [0.2, -0.1, 0.4]);
      const cutter = box([1.3, 0.7, 1.9], [3.1, 2.3, 2.7]);
      expectBooleanAgrees(kernels, op, entity, cutter);
    },
  );

  it.each([
    ['a zero tube radius', { tubeRadius: 0 }],
    ['a tube radius not smaller than the ring radius', { tubeRadius: 3 }],
  ])('rejects %s', (_label, change) => {
    const entity = { ...torus([0, 0, 0], [0, 0, 0]), ...change } as Entity;
    expect(meshOf(kernels.occt, entity)).toBeNull();
  });
});
