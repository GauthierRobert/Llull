/**
 * @layer server/tests
 * Regression: a sphere tangent to a box face made an OCC boolean "succeed" with a solid whose
 * meshing aborted the WASM module (the whole worker/process died). The kernel now opens a hair
 * gap first, so every operation returns a mesh that agrees with Manifold.
 */

import { describe, it, expect } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';
import { common, booleanMesh, volume } from './kernelTestSupport';

const sphere = (rotation: Vec3): Entity =>
  ({ id: 's', kind: 'sphere', position: [1, 1, 0], rotation, radius: 3, ...common }) as Entity;
// Top face at z = 3 touches the sphere (centre z = 0, r = 3) at a single point.
const tangentBox: Entity = {
  id: 'b',
  kind: 'box',
  position: [2, 1, 1],
  rotation: [0, 0, 0],
  size: [5, 3, 4],
  ...common,
} as Entity;

describe.each([
  ['axis-aligned', [0, 0, 0]],
  ['rotated', [0.4, 0.2, 0.7]],
] as Array<[string, Vec3]>)('occt sphere tangent to a box face (%s sphere)', (_name, rotation) => {
  it.each(['union', 'subtract', 'intersect'] as const)(
    '%s returns a mesh that agrees with Manifold',
    async (op) => {
      const occt = await createNodeOcctKernel();
      const manifold = await createManifoldKernel();
      const fromOcct = booleanMesh(occt, op, sphere(rotation), tangentBox);
      const fromManifold = booleanMesh(manifold, op, sphere(rotation), tangentBox);
      expect(fromOcct).not.toBeNull();
      expect(fromManifold).not.toBeNull();
      const ratio = volume(fromOcct!) / volume(fromManifold!);
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    },
    60_000,
  );
});
