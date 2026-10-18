import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { fieldFaces } from '@cae/results/fieldFaces';

/** Two tets sharing a face that lies on the plane z = 0 up to round-off noise in the node heights. */
function meshOnPlane(noise: readonly [number, number, number]): { mesh: FeMeshArtifact; coordinates: Map<number, Vec3> } {
  const coordinates = new Map<number, Vec3>([
    [1, [0, 0, noise[0]]],
    [2, [1, 0, noise[1]]],
    [3, [0, 1, noise[2]]],
    [4, [0.2, 0.2, 1]],
    [5, [0.2, 0.2, -1]],
  ]);
  const mesh: FeMeshArtifact = {
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '0',
    inputHash: 'h',
    nodes: [...coordinates].map(([id, [x, y, z]]) => [id, x, y, z]),
    blocks: [
      {
        type: 'C3D4',
        entityId: 'e',
        elements: [
          [1, 1, 2, 3, 4],
          [2, 1, 3, 2, 5],
        ],
      },
    ],
    nodeSets: {},
    faceSets: {},
    targets: {},
  };
  return { mesh, coordinates };
}

function capsOf(noise: readonly [number, number, number]): { area: number; wrongWay: number; count: number } {
  const { mesh, coordinates } = meshOnPlane(noise);
  const faces = fieldFaces({
    mesh,
    coordinates,
    entityIds: null,
    cut: { normal: [0, 0, 1], offset: 0 },
    position: (node) => coordinates.get(node),
    value: () => 1,
  }).filter((face) => face.cap);
  let area = 0;
  let wrongWay = 0;
  for (const { corners } of faces) {
    const [a, b, c] = corners.map((corner) => corner.u);
    if (a === undefined || b === undefined || c === undefined) continue;
    const z = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    area += Math.abs(z) / 2;
    if (z < -1e-12) wrongWay += 1;
  }
  return { area, wrongWay, count: faces.length };
}

describe('section caps on a plane through mesh nodes', () => {
  it.each([
    ['exact', [0, 0, 0]],
    ['round-off noise of mixed sign', [1e-13, -2e-13, 3e-13]],
    ['round-off noise of one sign', [4e-13, 1e-13, 2e-13]],
  ] as const)('covers the shared face once, facing the cut normal (%s)', (_label, noise) => {
    const { area, wrongWay, count } = capsOf(noise);
    expect(area).toBeCloseTo(0.5, 9);
    expect(wrongWay).toBe(0);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('draws one cap per crossed tet for a plane inside the elements, all facing the cut normal', () => {
    const { mesh, coordinates } = meshOnPlane([0, 0, 0]);
    const faces = fieldFaces({
      mesh,
      coordinates,
      entityIds: null,
      cut: { normal: [0, 0, 1], offset: 0.5 },
      position: (node) => coordinates.get(node),
      value: () => 1,
    }).filter((face) => face.cap);
    expect(faces.length).toBeGreaterThanOrEqual(1);
    for (const { corners } of faces) {
      const [a, b, c] = corners.map((corner) => corner.u);
      expect(
        ((b?.[0] ?? 0) - (a?.[0] ?? 0)) * ((c?.[1] ?? 0) - (a?.[1] ?? 0)) -
          ((b?.[1] ?? 0) - (a?.[1] ?? 0)) * ((c?.[0] ?? 0) - (a?.[0] ?? 0)),
      ).toBeGreaterThan(0);
    }
  });
});

/** Every vertex order of a tet with one node exactly on the plane: the section polygon then has coincident corners (a triangle written as a quad). */
describe('section caps of a tet touching the plane with one node', () => {
  const corners: Vec3[] = [
    [0, 0, 0],
    [1, 0, -1],
    [0, 1, 1],
    [1, 1, 1],
  ];
  const permutations = (items: readonly number[]): number[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) => permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]));

  it.each(permutations([0, 1, 2, 3]).map((order) => [order.join('')] as const))(
    'vertex order %s: one triangle of area 1/8 facing +z',
    (key) => {
      const order = [...key].map(Number);
      const coordinates = new Map<number, Vec3>(order.map((corner, index) => [index + 1, corners[corner] ?? [0, 0, 0]]));
      const mesh: FeMeshArtifact = {
        kind: 'fe_mesh',
        unitSystem: 'N-mm-t-s',
        mesher: 'test',
        mesherVersion: '0',
        inputHash: 'h',
        nodes: [...coordinates].map(([id, [x, y, z]]) => [id, x, y, z]),
        blocks: [{ type: 'C3D4', entityId: 'e', elements: [[1, 1, 2, 3, 4]] }],
        nodeSets: {},
        faceSets: {},
        targets: {},
      };
      const caps = fieldFaces({
        mesh,
        coordinates,
        entityIds: null,
        cut: { normal: [0, 0, 1], offset: 0 },
        position: (node) => coordinates.get(node),
        value: () => 1,
      }).filter((face) => face.cap);
      let signed = 0;
      for (const { corners: triangle } of caps) {
        const [a, b, c] = triangle.map((corner) => corner.u);
        signed +=
          ((b?.[0] ?? 0) - (a?.[0] ?? 0)) * ((c?.[1] ?? 0) - (a?.[1] ?? 0)) -
          ((b?.[1] ?? 0) - (a?.[1] ?? 0)) * ((c?.[0] ?? 0) - (a?.[0] ?? 0));
      }
      expect(signed / 2).toBeCloseTo(0.125, 12);
    },
  );
});
