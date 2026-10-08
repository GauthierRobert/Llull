/**
 * @layer server/tests
 * Live OpenCascade chamfer, fillet and shell on EXACT shapes (B-rep edges, not mesh triangles),
 * checked against closed-form volumes; the sewn-mesh leaf stays a working fallback.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Entity } from '@core/model/types';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import type { ShapeRecipe } from '@core/geometry/shapeRecipe';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';
import { leaf, meshOf } from './kernelTestSupport';

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

const cube = leaf(cubeEntity(4));
const shell = (source: ShapeRecipe, thickness: number): ShapeRecipe => ({
  op: 'shell',
  source,
  thickness,
});
const chamfer = (source: ShapeRecipe, edges: number[], size: number): ShapeRecipe => ({
  op: 'chamfer',
  source,
  edges,
  size,
});

let occt: GeometryKernel;
let cubeMesh: MeshData;
beforeAll(async () => {
  occt = await createNodeOcctKernel();
  cubeMesh = meshOf(await createManifoldKernel(), cubeEntity(4))!;
}, 120_000);

describe('occt shell', () => {
  it('hollows an exact cube: volume is the solid minus its inward offset', () => {
    const hollow = meshOf(occt, shell(cube, 0.5));
    expect(hollow).not.toBeNull();
    expect(volume(hollow!)).toBeCloseTo(4 ** 3 - 3 ** 3, 2);
  });

  it('still hollows a triangle-mesh leaf (sewn fallback for imported meshes)', () => {
    const meshLeaf = leaf({ ...cubeEntity(4), kind: 'mesh', mesh: cubeMesh } as unknown as Entity);
    expect(volume(meshOf(occt, shell(meshLeaf, 0.5))!)).toBeCloseTo(4 ** 3 - 3 ** 3, 2);
  });

  it('rejects a non-positive thickness and an empty mesh', () => {
    expect(occt.evaluate(shell(cube, 0))).toBeNull();
    const empty = { ...cubeEntity(1), kind: 'mesh', mesh: { positions: [], indices: [] } };
    expect(occt.evaluate(shell(leaf(empty as unknown as Entity), 1))).toBeNull();
  });
});

describe('occt chamfer / fillet on true B-rep edges', () => {
  it('a cube has exactly 12 straight edges and 6 planar faces (no triangle diagonals)', () => {
    const topology = occt.topology(occt.evaluate(cube)!);
    expect(topology?.edges).toHaveLength(12);
    expect(topology?.edges.every((edge) => edge.curve === 'line' && edge.length === 4)).toBe(true);
    expect(topology?.faces.map((face) => face.surface)).toEqual(Array(6).fill('plane'));
    expect(topology?.volume).toBeCloseTo(64, 6);
  });

  it('cuts material off any edge: volume drops by d^2/2 times the edge length', () => {
    const chamfered = occt.evaluate(chamfer(cube, [0], 0.25));
    expect(chamfered).not.toBeNull();
    expect(occt.topology(chamfered!)?.volume).toBeCloseTo(64 - (0.25 * 0.25 * 4) / 2, 6);
    expect(occt.topology(chamfered!)?.faces).toHaveLength(7);
  });

  it('fillets a boolean result on its exact circular edge (a filleted hole lip)', () => {
    const drill = {
      id: 'd',
      kind: 'cylinder',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      radius: 1,
      height: 10,
      layerId: 'layer-default',
      color: '#888888',
    } as unknown as Entity;
    const drilled: ShapeRecipe = { op: 'boolean', boolean: 'subtract', a: cube, b: leaf(drill) };
    const topology = occt.topology(occt.evaluate(drilled)!)!;
    const lip = topology.edges.find((edge) => edge.curve === 'circle');
    expect(lip).toBeDefined();
    const filleted = occt.evaluate({
      op: 'fillet',
      source: drilled,
      edges: [lip!.index],
      size: 0.3,
    });
    expect(filleted).not.toBeNull();
    const after = occt.topology(filleted!)!;
    expect(after.faces.some((face) => face.surface === 'torus')).toBe(true);
    expect(after.volume).toBeLessThan(topology.volume);
  });

  it('rejects a non-positive distance and an out-of-range edge', () => {
    expect(occt.evaluate(chamfer(cube, [], 0))).toBeNull();
    expect(occt.evaluate(chamfer(cube, [99], 0.25))).toBeNull();
  });

  it('writes exact STEP: analytic planes and a cylinder, no triangulated faces', () => {
    const drill = {
      id: 'd',
      kind: 'cylinder',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      radius: 1,
      height: 10,
      layerId: 'layer-default',
      color: '#888888',
    } as unknown as Entity;
    const drilled = occt.evaluate({ op: 'boolean', boolean: 'subtract', a: cube, b: leaf(drill) })!;
    const step = occt.exportStep([drilled]);
    expect(step).toMatch(/^ISO-10303-21;/);
    expect(step).toMatch(/CYLINDRICAL_SURFACE/);
    expect(step).toMatch(/MANIFOLD_SOLID_BREP/);
    expect(step!.match(/ADVANCED_FACE/g)).toHaveLength(7);
  });
});
