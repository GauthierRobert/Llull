/**
 * @layer server/tests
 * Live OpenCascade chamfer and shell on a cube mesh, checked against closed-form volumes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Entity } from '@core/model/types';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';

const cubeEntity = (size: number): Entity =>
  ({
    id: 'c',
    kind: 'box',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    size: [size, size, size],
    layerId: 'layer-default',
    color: '#888888',
  }) as Entity;

function volume(mesh: MeshData): number {
  const p = mesh.positions;
  let sum = 0;
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
let cube: MeshData;
beforeAll(async () => {
  occt = await createNodeOcctKernel();
  cube = (await createManifoldKernel()).tessellate(cubeEntity(4))!;
}, 120_000);

describe('occt shellSolid', () => {
  it('hollows a cube: volume is the solid minus its inward offset', () => {
    const shell = occt.shellSolid(cube, 0.5);
    expect(shell).not.toBeNull();
    expect(volume(shell!)).toBeCloseTo(4 ** 3 - 3 ** 3, 2);
  });

  it('rejects a non-positive thickness and an empty mesh', () => {
    expect(occt.shellSolid(cube, 0)).toBeNull();
    expect(occt.shellSolid({ positions: [], indices: [] }, 1)).toBeNull();
  });
});

describe('occt chamferEdges', () => {
  // The mesh has triangle diagonals as edges; only sharp ones can be chamfered, so find them.
  const sharpEdges = (): number[] =>
    Array.from({ length: 18 }, (_, edge) => edge).filter(
      (edge) => occt.chamferEdges(cube, [edge], 0.25) !== null,
    );

  it('cuts material off a sharp edge: volume drops by d^2/2 times the edge length', () => {
    const [edge] = sharpEdges();
    expect(edge).toBeDefined();
    const chamfered = occt.chamferEdges(cube, [edge!], 0.25);
    expect(chamfered).not.toBeNull();
    expect(volume(chamfered!)).toBeCloseTo(64 - (0.25 * 0.25 * 4) / 2, 3);
  });

  it('rejects a non-positive distance and an empty mesh', () => {
    expect(occt.chamferEdges(cube, [], 0)).toBeNull();
    expect(occt.chamferEdges({ positions: [], indices: [] }, [], 1)).toBeNull();
  });
});
