import { describe, expect, it, beforeAll } from 'vitest';
import type { Entity } from '@core/model/types';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { meshOf, booleanMesh } from '../helpers/manifoldMesh';

const base = { layerId: 'layer-default', color: '#888888', rotation: [0, 0, 0] };
const extrusion = (profile: number[][], depth: number): Entity =>
  ({
    id: 'e',
    kind: 'extrusion',
    position: [0, 0, 0],
    profile,
    depth,
    ...base,
  }) as unknown as Entity;
const box = (position: number[]): Entity =>
  ({ id: 'b', kind: 'box', position, size: [2, 2, 2], ...base }) as unknown as Entity;

function volume(mesh: MeshData): number {
  let sum = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const at = (k: number): number[] => {
      const v = (mesh.indices[i + k] ?? 0) * 3;
      return [mesh.positions[v] ?? 0, mesh.positions[v + 1] ?? 0, mesh.positions[v + 2] ?? 0];
    };
    const [a, b, c] = [at(0), at(1), at(2)] as [number[], number[], number[]];
    sum +=
      (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) -
        a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) +
        a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) /
      6;
  }
  return sum;
}

describe('manifold kernel extrusion profile winding', () => {
  let kernel: GeometryKernel;
  beforeAll(async () => {
    kernel = await createManifoldKernel();
  });

  const counterClockwise = [
    [0, 0],
    [3, 0],
    [3, 2],
    [0, 2],
  ];
  const clockwise = [...counterClockwise].reverse();

  it('extrudes a clockwise profile to the same solid as a counter-clockwise one', () => {
    const ccw = meshOf(kernel, extrusion(counterClockwise, 4));
    const cw = meshOf(kernel, extrusion(clockwise, 4));
    expect(ccw).not.toBeNull();
    expect(cw).not.toBeNull();
    expect(volume(ccw!)).toBeCloseTo(24, 6);
    expect(volume(cw!)).toBeCloseTo(24, 6);
  });

  it('boolean operations accept a clockwise extrusion operand', () => {
    // The 2x2x2 box spans x 2..4; the extrusion covers x 0..3, so a 1x2x2 slab is removed.
    const cut = booleanMesh(kernel, 'subtract', box([3, 1, 2]), extrusion(clockwise, 4));
    expect(cut).not.toBeNull();
    expect(volume(cut!)).toBeCloseTo(4, 6);
  });

  it('still rejects a degenerate (zero-area) profile', () => {
    expect(
      meshOf(
        kernel,
        extrusion(
          [
            [0, 0],
            [1, 0],
            [2, 0],
          ],
          1,
        ),
      ),
    ).toBeNull();
  });
});
