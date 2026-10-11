/**
 * @layer server/tests
 * Live OpenCascade vs Manifold: a rotated box is placed identically by both kernels
 * (llull placement M = Rx·Ry·Rz, then translate), so booleans on rotated operands agree.
 */

import { describe, it, expect } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import type { MeshData } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';
import { booleanMesh, bounds, meshOf } from './kernelTestSupport';

function box(position: Vec3, rotation: Vec3, size: Vec3 = [4, 2, 2]): Entity {
  return {
    id: 'b',
    kind: 'box',
    position,
    rotation,
    size,
    layerId: 'layer-default',
    color: '#888888',
  } as unknown as Entity;
}

function expectSameBounds(a: MeshData | null, b: MeshData | null): void {
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  const [first, second] = [bounds(a!), bounds(b!)];
  for (let k = 0; k < 3; k++) {
    expect(first.min[k]).toBeCloseTo(second.min[k] ?? NaN, 4);
    expect(first.max[k]).toBeCloseTo(second.max[k] ?? NaN, 4);
  }
}

describe('occt kernel honours entity rotation', () => {
  it('tessellates a rotated, translated box like Manifold', async () => {
    const occt = await createNodeOcctKernel();
    const manifold = await createManifoldKernel();
    for (const rotation of [
      [0, 0, Math.PI / 2],
      [0, Math.PI / 2, 0],
      [Math.PI / 2, 0, 0],
      [0.3, -0.5, 1.1],
    ] as Vec3[]) {
      const entity = box([5, -3, 2], rotation);
      expectSameBounds(meshOf(occt, entity), meshOf(manifold, entity));
    }
  }, 120_000);

  it('a boolean with a rotated operand matches Manifold', async () => {
    const occt = await createNodeOcctKernel();
    const manifold = await createManifoldKernel();
    const base = box([0, 0, 0], [0, 0, 0], [6, 6, 2]);
    const turned = box([1, 1, 0], [0, 0, Math.PI / 4]);
    for (const op of ['union', 'subtract', 'intersect'] as const) {
      expectSameBounds(
        booleanMesh(occt, op, base, turned),
        booleanMesh(manifold, op, base, turned),
      );
    }
  }, 120_000);
});
