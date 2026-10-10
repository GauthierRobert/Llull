/**
 * @layer server/tests
 * Live OpenCascade vs Manifold: extrusions (either winding, concave profiles) and mesh entities
 * are valid boolean operands, placed like the other kernel, and degenerate input is rejected.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';
import { booleanMesh, bounds, box, common, meshOf, volume } from './kernelTestSupport';

type Profile = Array<[number, number]>;
// L-shaped, concave, area 5 (3x3 square minus a 2x1 notch... see volume below).
const L_SHAPE: Profile = [
  [0, 0],
  [3, 0],
  [3, 1],
  [1, 1],
  [1, 3],
  [0, 3],
];
const L_AREA = 5;
const extrusion = (profile: Profile, position: Vec3, rotation: Vec3, depth = 4): Entity =>
  ({ id: 'e', kind: 'extrusion', position, rotation, profile, depth, ...common }) as Entity;
const meshEntity = (mesh: MeshData): Entity =>
  ({ id: 'm', kind: 'mesh', position: [0, 0, 0], rotation: [0, 0, 0], mesh, ...common }) as Entity;

let occt: GeometryKernel;
let manifold: GeometryKernel;
beforeAll(async () => {
  occt = await createNodeOcctKernel();
  manifold = await createManifoldKernel();
}, 120_000);

const placements: Array<[string, Vec3, Vec3]> = [
  ['origin', [0, 0, 0], [0, 0, 0]],
  ['translated', [5, -3, 2], [0, 0, 0]],
  ['rotated', [-2, 4, 1], [0.3, -0.5, 1.1]],
];

describe.each([
  ['counter-clockwise', L_SHAPE],
  ['clockwise', [...L_SHAPE].reverse()],
] as Array<[string, Profile]>)('occt extrusion (%s profile)', (_name, profile) => {
  it.each(placements)(
    'has the analytic volume and Manifold bounds (%s)',
    (_l, position, rotation) => {
      const entity = extrusion(profile, position, rotation);
      const [fromOcct, fromManifold] = [meshOf(occt, entity), meshOf(manifold, entity)];
      expect(fromOcct).not.toBeNull();
      expect(fromManifold).not.toBeNull();
      expect(volume(fromOcct!)).toBeCloseTo(L_AREA * 4, 4);
      const [a, b] = [bounds(fromOcct!), bounds(fromManifold!)];
      for (let k = 0; k < 3; k++) {
        expect(a.min[k]).toBeCloseTo(b.min[k] ?? NaN, 4);
        expect(a.max[k]).toBeCloseTo(b.max[k] ?? NaN, 4);
      }
    },
  );

  it.each(['union', 'subtract', 'intersect'] as const)(
    '%s with a box agrees with Manifold',
    (op) => {
      const entity = extrusion(profile, [0, 0, 0], [0, 0, 0]);
      const other = box([1, 1, 2], [3, 3, 2.5]);
      const [fromOcct, fromManifold] = [
        booleanMesh(occt, op, entity, other),
        booleanMesh(manifold, op, entity, other),
      ];
      expect(fromOcct).not.toBeNull();
      expect(fromManifold).not.toBeNull();
      expect(volume(fromOcct!)).toBeCloseTo(volume(fromManifold!), 3);
    },
  );
});

describe('occt extrusion rejects bad input', () => {
  it.each([
    [
      'fewer than three points',
      [
        [0, 0],
        [1, 1],
      ] as Profile,
      2,
    ],
    [
      'zero area',
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ] as Profile,
      2,
    ],
    ['non-positive depth', L_SHAPE, 0],
  ])('%s -> null', (_label, profile, depth) => {
    expect(meshOf(occt, extrusion(profile, [0, 0, 0], [0, 0, 0], depth))).toBeNull();
  });
});

describe('occt mesh operands', () => {
  it('a mesh solid behaves like the box it was tessellated from', () => {
    const source = box([0, 0, 0], [4, 4, 4]);
    const cube = meshOf(manifold, source)!;
    const cutter = box([2, 0, 0], [4, 4, 4]);
    for (const op of ['union', 'subtract', 'intersect'] as const) {
      const viaMesh = booleanMesh(occt, op, meshEntity(cube), cutter);
      const viaBox = booleanMesh(occt, op, source, cutter);
      expect(viaMesh, op).not.toBeNull();
      expect(viaBox, op).not.toBeNull();
      expect(volume(viaMesh!)).toBeCloseTo(volume(viaBox!), 3);
    }
  });

  it('honours a mesh entity transform', () => {
    const cube = meshOf(manifold, box([0, 0, 0], [2, 2, 2]))!;
    const moved = { ...meshEntity(cube), position: [10, 0, 0] } as Entity;
    const result = booleanMesh(occt, 'union', moved, box([10, 0, 0], [2, 2, 2]));
    expect(result).not.toBeNull();
    expect(volume(result!)).toBeCloseTo(8, 3);
  });

  it('an empty mesh is rejected', () => {
    expect(meshOf(occt, meshEntity({ positions: [], indices: [] }))).toBeNull();
  });
});
