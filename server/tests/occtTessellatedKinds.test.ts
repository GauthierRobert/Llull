/**
 * @layer server/tests
 * Live OpenCascade vs Manifold: torus, wedge, pyramid and revolution (no exact OCC maker; their
 * triangles are sewn into a solid) are valid boolean operands that agree with Manifold, which
 * works from the same triangles.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { Entity, Vec3 } from '@core/model/types';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';

const common = { layerId: 'layer-default', color: '#888888' };
const at = (
  position: Vec3,
  rotation: Vec3,
): Pick<Entity, 'position' | 'rotation' | 'layerId' | 'color'> => ({
  position,
  rotation,
  ...common,
});

const shapes: Array<[string, (position: Vec3, rotation: Vec3) => Entity]> = [
  [
    'torus',
    (p, r) => ({ id: 't', kind: 'torus', ringRadius: 3, tubeRadius: 1, ...at(p, r) }) as Entity,
  ],
  ['wedge', (p, r) => ({ id: 'w', kind: 'wedge', size: [4, 3, 5], ...at(p, r) }) as Entity],
  [
    'pyramid',
    (p, r) =>
      ({ id: 'y', kind: 'pyramid', baseWidth: 4, baseDepth: 3, height: 5, ...at(p, r) }) as Entity,
  ],
  [
    'revolution',
    (p, r) =>
      ({
        id: 'v',
        kind: 'revolution',
        profile: [
          [1, 0],
          [2, 0],
          [2, 3],
          [1, 3],
        ],
        axis: [0, 0, 1],
        angle: Math.PI * 2,
        segments: 24,
        ...at(p, r),
      }) as Entity,
  ],
];

const box = (position: Vec3, size: Vec3): Entity =>
  ({ id: 'b', kind: 'box', rotation: [0, 0, 0], position, size, ...common }) as Entity;

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
let manifold: GeometryKernel;
beforeAll(async () => {
  occt = await createNodeOcctKernel();
  manifold = await createManifoldKernel();
}, 120_000);

describe.each(shapes)('occt %s', (name, make) => {
  it.each([
    ['origin', [0, 0, 0], [0, 0, 0]],
    ['moved and turned', [2, -1, 3], [0.3, -0.4, 0.9]],
  ] as Array<[string, Vec3, Vec3]>)('tessellates with the Manifold volume (%s)', (_l, p, r) => {
    const entity = make(p, r);
    const [fromOcct, fromManifold] = [occt.tessellate(entity), manifold.tessellate(entity)];
    expect(fromOcct, name).not.toBeNull();
    expect(fromManifold, name).not.toBeNull();
    expect(volume(fromOcct!)).toBeGreaterThan(0);
    expect(volume(fromOcct!) / volume(fromManifold!)).toBeCloseTo(1, 2);
  });

  it.each(['union', 'subtract', 'intersect'] as const)(
    '%s with a box agrees with Manifold',
    (op) => {
      const entity = make([0.3, 0.2, 0.1], [0.2, -0.1, 0.4]);
      const other = box([1.3, 0.7, 1.9], [3.1, 2.3, 2.7]);
      const [fromOcct, fromManifold] = [
        occt.booleanOp(op, entity, other),
        manifold.booleanOp(op, entity, other),
      ];
      expect(fromOcct, `${name} ${op}`).not.toBeNull();
      expect(fromManifold, `${name} ${op}`).not.toBeNull();
      expect(volume(fromOcct!) / volume(fromManifold!)).toBeCloseTo(1, 2);
    },
  );
});
