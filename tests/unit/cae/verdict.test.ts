/** Verdict element metrics (05 §5.5, VC-FEA-07, VC-FEA-08): the port against mesh_quality_reference.json and the reference quads. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { meshQuality } from '@cae/results/meshQuality';
import { quadMetrics, tetMetrics, triMetrics } from '@cae/results/verdict';

interface Reference {
  readonly elements: Record<string, { scaled_jacobian?: number; aspect_ratio: number; volume?: number }>;
  readonly tolerance_abs: number;
}
const reference = JSON.parse(readFileSync('docs/aerospace/05-fea-cae-handoff/validation/mesh_quality_reference.json', 'utf8')) as Reference;

const S3 = Math.sqrt(3);
const regular: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0.5, S3 / 2, 0],
  [0.5, S3 / 6, Math.sqrt(2 / 3)],
];
const corner: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const sliver: Vec3[] = [regular[0] as Vec3, regular[1] as Vec3, regular[2] as Vec3, [0.5, S3 / 6, 0.05]];
const inverted: Vec3[] = [regular[0] as Vec3, regular[2] as Vec3, regular[1] as Vec3, regular[3] as Vec3];
const tet = (points: Vec3[]): ReturnType<typeof tetMetrics> =>
  tetMetrics(points[0] as Vec3, points[1] as Vec3, points[2] as Vec3, points[3] as Vec3);
const rect = (width: number, height: number): ReturnType<typeof quadMetrics> =>
  quadMetrics([0, 0, 0], [width, 0, 0], [width, height, 0], [0, height, 0]);

describe('Verdict tetrahedron metrics (VC-FEA-07)', () => {
  const tolerance = reference.tolerance_abs;
  it.each([
    ['tet_regular_unit', regular],
    ['tet_trirectangular_corner', corner],
    ['tet_sliver_h0.05', sliver],
    ['tet_inverted_regular', inverted],
  ] as const)('%s matches the pinned reference', (name, points) => {
    const expected = reference.elements[name];
    const metrics = tet([...points]);
    expect(Math.abs(metrics.scaledJacobian - (expected?.scaled_jacobian ?? Number.NaN))).toBeLessThan(tolerance);
    expect(Math.abs(metrics.aspectRatio - (expected?.aspect_ratio ?? Number.NaN))).toBeLessThan(tolerance * 10);
    expect(Math.abs(metrics.volume - (expected?.volume ?? Number.NaN))).toBeLessThan(tolerance);
  });

  it('a degenerate (flat) tetrahedron scores 0 and an enormous aspect ratio, never NaN', () => {
    const flat = tetMetrics([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]);
    expect(flat.scaledJacobian).toBe(0);
    expect(flat.aspectRatio).toBe(Number.MAX_SAFE_INTEGER);
    const point = tetMetrics([0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]);
    expect(point.scaledJacobian).toBe(0);
    expect(point.edgeRatio).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('Verdict quadrilateral metrics', () => {
  it('aspect ratios of the reference quads are 1, 1.5 and 5.5', () => {
    expect(rect(1, 1).aspectRatio).toBeCloseTo(1, 12);
    expect(rect(2, 1).aspectRatio).toBeCloseTo(1.5, 12);
    expect(rect(10, 1).aspectRatio).toBeCloseTo(5.5, 12);
  });

  it('a square has scaled Jacobian 1, skew 0 and warpage 0 (a flat quad is not warped)', () => {
    const square = rect(1, 1);
    expect(square.scaledJacobian).toBeCloseTo(1, 12);
    expect(square.skew).toBeCloseTo(0, 12);
    expect(square.warpage).toBeCloseTo(0, 12);
  });

  it('a sheared quad has skew and a lower scaled Jacobian; a bow-tie is not positive; a lifted corner warps', () => {
    const sheared = quadMetrics([0, 0, 0], [1, 0, 0], [2, 1, 0], [1, 1, 0]);
    expect(sheared.skew).toBeGreaterThan(0.5);
    expect(sheared.scaledJacobian).toBeCloseTo(Math.sin(Math.PI / 4), 9);
    expect(quadMetrics([0, 0, 0], [1, 1, 0], [1, 0, 0], [0, 1, 0]).scaledJacobian).toBeLessThanOrEqual(0);
    const warped = quadMetrics([0, 0, 0], [1, 0, 0], [1, 1, 0.3], [0, 1, 0]);
    expect(warped.warpage).toBeGreaterThan(0);
    expect(quadMetrics([0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]).aspectRatio).toBe(Number.MAX_SAFE_INTEGER);
    expect(quadMetrics([0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]).skew).toBe(1);
  });
});

describe('Verdict triangle metrics', () => {
  it('minimum angle: 60 equilateral, 45 right isosceles, 0 degenerate', () => {
    expect(triMetrics([0, 0, 0], [1, 0, 0], [0.5, S3 / 2, 0]).minAngleDeg).toBeCloseTo(60, 9);
    expect(triMetrics([0, 0, 0], [1, 0, 0], [0, 1, 0]).minAngleDeg).toBeCloseTo(45, 9);
    expect(triMetrics([0, 0, 0], [1, 0, 0], [2, 0, 0]).minAngleDeg).toBeCloseTo(0, 9);
    expect(triMetrics([0, 0, 0], [0, 0, 0], [1, 0, 0]).minAngleDeg).toBe(0);
  });
});

describe('meshQuality over mixed element families', () => {
  const nodes: FeMeshArtifact['nodes'] = [
    [1, 0, 0, 0],
    [2, 1, 0, 0],
    [3, 1, 1, 0],
    [4, 0, 1, 0],
    [5, 5, 0, 0],
    [6, 5, 0.1, 0],
    [7, 0, 0, 1],
  ];
  const mesh = (blocks: FeMeshArtifact['blocks']): FeMeshArtifact => ({
    kind: 'fe_mesh',
    unitSystem: 'N-mm-t-s',
    mesher: 'test',
    mesherVersion: '1',
    inputHash: 'x',
    nodes,
    blocks,
    nodeSets: {},
    faceSets: {},
    targets: {},
  });

  it('reports the quad and triangle metrics, flags what is outside the Verdict range, and never flags warpage', () => {
    const quality = meshQuality(
      mesh([
        { type: 'S4', entityId: 'a', elements: [[1, 1, 2, 3, 4]] },
        { type: 'CPS3', entityId: 'b', elements: [[2, 1, 5, 6]] },
        { type: 'C3D4', entityId: 'c', elements: [[3, 1, 2, 4, 7]] },
      ]),
    );
    expect(Object.keys(quality.metrics).sort()).toEqual([
      'quad_aspect_ratio',
      'quad_scaled_jacobian',
      'quad_skew',
      'quad_warpage',
      'tet_aspect_ratio',
      'tet_edge_ratio',
      'tet_scaled_jacobian',
      'tri_min_angle_deg',
    ]);
    expect(quality.metrics['quad_aspect_ratio']?.min).toBeCloseTo(1, 12);
    expect(quality.metrics['quad_warpage']?.outsideAcceptable).toBe(0);
    expect(quality.metrics['tri_min_angle_deg']?.outsideAcceptable).toBe(1);
    expect(quality.metrics['tri_min_angle_deg']?.min).toBeLessThan(5);
    expect(quality.inverted).toBe(0);
  });

  it('counts inverted tetrahedra, inverted quads and zero-area triangles as inverted (the export / solve gate)', () => {
    const quality = meshQuality(
      mesh([
        { type: 'C3D4', entityId: 'c', elements: [[1, 1, 3, 2, 7]] },
        { type: 'S4', entityId: 'a', elements: [[2, 1, 3, 2, 4]] },
        { type: 'S3', entityId: 'b', elements: [[3, 1, 2, 5]] },
      ]),
    );
    expect(quality.inverted).toBe(3);
  });

  it('skips elements that reference a missing node', () => {
    const quality = meshQuality(mesh([{ type: 'C3D4', entityId: 'c', elements: [[1, 1, 2, 3, 99]] }]));
    expect(quality.metrics).toEqual({});
    expect(quality.inverted).toBe(0);
  });
});
