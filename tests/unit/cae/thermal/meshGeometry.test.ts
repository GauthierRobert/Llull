import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import { elementVolume, faceNodes, indexMesh, integrateFace, nodalWeights, partVolumes } from '@cae/thermal/meshGeometry';

/** One C3D10 tetrahedron with corners (0,0,0), (1,0,0), (0,1,0), (0,0,1) and CalculiX mid-side nodes 5-10 (1-2, 2-3, 3-1, 1-4, 2-4, 3-4). */
const CORNERS: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const mid = (a: number, b: number): [number, number, number] => {
  const p = CORNERS[a - 1] ?? [0, 0, 0];
  const q = CORNERS[b - 1] ?? [0, 0, 0];
  return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
};
const TET10: FeMeshArtifact = {
  kind: 'fe_mesh',
  unitSystem: 'N-m-kg-s',
  mesher: 'test',
  mesherVersion: '1',
  inputHash: '',
  nodes: [
    ...CORNERS.map((p, i) => [i + 1, ...p] as [number, number, number, number]),
    ...(
      [
        [1, 2],
        [2, 3],
        [3, 1],
        [1, 4],
        [2, 4],
        [3, 4],
      ] as const
    ).map(([a, b], i) => [5 + i, ...mid(a, b)] as [number, number, number, number]),
  ],
  blocks: [
    { type: 'C3D10', entityId: 'p', elements: [[1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] },
    { type: 'S3', entityId: 'shell', elements: [[2, 1, 2, 3]] },
  ],
  nodeSets: {},
  faceSets: {},
  targets: {},
};

describe('thermal mesh geometry', () => {
  const index = indexMesh(TET10);
  const element = index.elements.get(1);

  it('indexes tet elements only and gives each node its part', () => {
    expect([...index.elements.keys()]).toEqual([1]);
    expect(index.entityOfNode.get(7)).toBe('p');
    expect(index.coordinates.get(9)).toEqual([0.5, 0, 0.5]);
  });

  it('computes volumes, nodal weights (sum = volume; corners negative on C3D10) and part volumes', () => {
    if (element === undefined) throw new Error('no element');
    expect(elementVolume(index, element)).toBeCloseTo(1 / 6, 14);
    const weights = nodalWeights(element, 1 / 6);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1 / 6, 14);
    expect(weights[0]).toBeCloseTo(-1 / 120, 14);
    expect(weights[4]).toBeCloseTo(1 / 30, 14);
    expect(nodalWeights({ ...element, type: 'C3D4', nodes: [1, 2, 3, 4] }, 1)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(partVolumes(index).get('p')).toBeCloseTo(1 / 6, 14);
    expect(elementVolume(index, { ...element, nodes: [1, 2] })).toBe(0);
  });

  it('numbers faces as CalculiX does (1 = 1-2-3, 2 = 1-4-2, 3 = 2-4-3, 4 = 3-4-1) with their mid-side nodes', () => {
    if (element === undefined) throw new Error('no element');
    expect(faceNodes(element, 1)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(faceNodes(element, 2)).toEqual([1, 4, 2, 8, 9, 5]);
    expect(faceNodes(element, 3)).toEqual([2, 4, 3, 9, 10, 6]);
    expect(faceNodes(element, 4)).toEqual([3, 4, 1, 10, 8, 7]);
    expect(faceNodes(element, 0)).toBeNull();
    expect(faceNodes(element, 5)).toBeNull();
    expect(faceNodes({ ...element, type: 'C3D4', nodes: [1, 2, 3, 4] }, 3)).toEqual([2, 4, 3]);
    expect(faceNodes({ ...element, nodes: [1, 2, 3, 4] }, 1)).toBeNull();
  });

  it('integrates a quadratic nodal field exactly over a 6-node face and a linear one over a 3-node face (degree-5 rule)', () => {
    if (element === undefined) throw new Error('no element');
    const field = (node: number): number => {
      const [x = 0, y = 0] = index.coordinates.get(node) ?? [];
      return 1 + 2 * x + 3 * y + x * x + x * y;
    };
    const face = faceNodes(element, 1) ?? [];
    expect(integrateFace(index, face, field, (t) => t).area).toBeCloseTo(0.5, 14);
    expect(integrateFace(index, face, field, (t) => t).integral).toBeCloseTo(0.5 + 2 / 6 + 3 / 6 + 1 / 12 + 1 / 24, 13);
    // integral of T^2 against a fine centroid sum over the unit right triangle (two triangles per cell)
    const n = 400;
    const squared = (x: number, y: number): number => (1 + 2 * x + 3 * y + x * x + x * y) ** 2;
    let reference = 0;
    for (let i = 0; i < n; i += 1)
      for (let j = 0; j < n - i; j += 1) {
        reference += squared((i + 1 / 3) / n, (j + 1 / 3) / n) / (2 * n * n);
        if (j < n - i - 1) reference += squared((i + 2 / 3) / n, (j + 2 / 3) / n) / (2 * n * n);
      }
    expect(integrateFace(index, face, field, (t) => t * t).integral).toBeCloseTo(reference, 4);
    const linear = integrateFace(
      index,
      [1, 2, 3],
      (node) => (node === 1 ? 3 : node === 2 ? 6 : 9),
      (t) => t,
    );
    expect(linear.integral).toBeCloseTo(0.5 * 6, 14);
    expect(
      integrateFace(
        index,
        [99, 98, 97],
        () => 1,
        (t) => t,
      ).area,
    ).toBe(0);
  });
});
