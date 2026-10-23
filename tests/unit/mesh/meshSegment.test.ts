/** 07 MSH M5: segment_mesh and the primitive fits behind it (VC-MSH-23 first half, FR-MSH-20). */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { analyzeIndexedMesh } from '@core/geometry/mesh/analysis';
import { eigenSymmetric3, levenbergMarquardt, solveLinear } from '@core/geometry/mesh/linear';
import { fitDistance, fitRegion } from '@core/geometry/mesh/primitiveFit';
import { segmentMesh } from '@core/geometry/mesh/segment';
import type { PrimitiveFit } from '@core/model/meshProvenance';
import type { Vec3 } from '@core/model/vectors';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { cuboid, docWithMeshes, icosphere, plateWithHole, torus } from '../../helpers/meshFixtures';

type Data = Record<string, unknown>;
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
interface Group {
  readonly id: string;
  readonly faces: number;
  readonly area: number;
  readonly fit: PrimitiveFit;
}

describe('linear algebra', () => {
  it('diagonalises a symmetric matrix and solves a system', () => {
    const { values, vectors } = eigenSymmetric3([
      [2, 0, 0],
      [0, 5, 0],
      [0, 0, 1],
    ]);
    expect(values).toEqual([1, 2, 5]);
    expect(vectors[0].map(Math.abs)).toEqual([0, 0, 1]);
    const rotated = eigenSymmetric3([
      [3, 1, 0],
      [1, 3, 0],
      [0, 0, 7],
    ]);
    expect(rotated.values[0]).toBeCloseTo(2, 12);
    expect(rotated.values[1]).toBeCloseTo(4, 12);
    expect(
      solveLinear(
        [
          [2, 1],
          [1, 3],
        ],
        [3, 5],
      ),
    ).toEqual([0.8, 1.4].map((v) => expect.closeTo(v, 12)));
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
  });

  it('Levenberg-Marquardt fits a line through noisy data and keeps the start when nothing improves', () => {
    const points = [0, 1, 2, 3, 4].map((x) => [x, 2 * x + 1] as const);
    const fit = levenbergMarquardt([0, 0], (p) => points.map(([x, y]) => (p[0] as number) * x + (p[1] as number) - y));
    expect(fit[0]).toBeCloseTo(2, 8);
    expect(fit[1]).toBeCloseTo(1, 8);
    expect(levenbergMarquardt([5], () => [0])).toEqual([5]);
  });
});

describe('primitive fits', () => {
  const ring = (radius: number, count: number, z: number): Vec3[] =>
    Array.from(
      { length: count },
      (_, k) => [radius * Math.cos((2 * Math.PI * k) / count), radius * Math.sin((2 * Math.PI * k) / count), z] as Vec3,
    );

  it('recognises a plane, a sphere, a cylinder and a cone from their vertices and normals', () => {
    const planePoints: Vec3[] = [
      [0, 0, 1],
      [3, 0, 1],
      [3, 2, 1],
      [0, 2, 1],
      [1, 1, 1],
    ];
    const plane = fitRegion({ points: planePoints, normals: [[0, 0, 1]], areas: [6] }, ['plane', 'cylinder'], 1e-6);
    expect(plane).toMatchObject({ type: 'plane', max: expect.closeTo(0, 12) });
    const cylinderPoints = [...ring(5, 32, 0), ...ring(5, 32, 4), ...ring(5, 32, 8)];
    const cylinderNormals = ring(1, 32, 0);
    const cylinder = fitRegion(
      { points: cylinderPoints, normals: cylinderNormals, areas: cylinderNormals.map(() => 1) },
      ['plane', 'cylinder', 'cone', 'sphere'],
      1e-6,
    );
    expect(cylinder.type).toBe('cylinder');
    expect((cylinder as { radius: number }).radius).toBeCloseTo(5, 9);
    const sphere = icosphere(7, 2);
    const spherePoints = Array.from(
      { length: sphere.positions.length / 3 },
      (_, v) => [sphere.positions[v * 3], sphere.positions[v * 3 + 1], sphere.positions[v * 3 + 2]] as Vec3,
    );
    const sphereFit = fitRegion(
      { points: spherePoints, normals: spherePoints.map((p) => p.map((c) => c / 7) as unknown as Vec3), areas: spherePoints.map(() => 1) },
      ['plane', 'cylinder', 'cone', 'sphere'],
      1e-6,
    );
    expect(sphereFit.type).toBe('sphere');
    expect((sphereFit as { radius: number }).radius).toBeCloseTo(7, 9);
    const beta = Math.PI / 6;
    const conePoints = [1, 2, 3, 4].flatMap((z) => ring(z * Math.tan(beta), 24, z));
    const coneNormals: Vec3[] = [1, 2, 3, 4].flatMap(() =>
      ring(1, 24, 0).map(([x, y]) => [Math.cos(beta) * (x as number), Math.cos(beta) * (y as number), -Math.sin(beta)] as Vec3),
    );
    const cone = fitRegion(
      { points: conePoints, normals: coneNormals, areas: coneNormals.map(() => 1) },
      ['plane', 'cylinder', 'cone', 'sphere'],
      1e-6,
    );
    expect(cone.type).toBe('cone');
    expect((cone as { halfAngleRad: number }).halfAngleRad).toBeCloseTo(beta, 8);
    expect(Math.hypot(...(cone as { apex: Vec3 }).apex)).toBeCloseTo(0, 6);
  });

  it('falls back to freeform with the residual of the best attempt, honours the kind list, and measures distances', () => {
    const saddle: Vec3[] = [];
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) saddle.push([i, j, i * j * 0.3]);
    const normals: Vec3[] = [[0, 0, 1]];
    const free = fitRegion({ points: saddle, normals, areas: [1] }, ['plane', 'cylinder', 'cone', 'sphere'], 1e-3);
    expect(free.type).toBe('freeform');
    expect(free.max).toBeGreaterThan(0.1);
    expect(fitRegion({ points: saddle, normals, areas: [1] }, ['plane'], 10).type).toBe('plane');
    const few = fitRegion(
      {
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        normals,
        areas: [1],
      },
      ['plane', 'sphere'],
      1e-9,
    );
    expect(few.type).toBe('plane');
    const fits: PrimitiveFit[] = [
      { type: 'plane', point: [0, 0, 1], normal: [0, 0, 1], rms: 0, max: 0 },
      { type: 'sphere', center: [0, 0, 0], radius: 2, rms: 0, max: 0 },
      { type: 'cylinder', axisPoint: [0, 0, 0], axis: [0, 0, 1], radius: 2, rms: 0, max: 0 },
      { type: 'cone', apex: [0, 0, 0], axis: [0, 0, 1], halfAngleRad: Math.PI / 4, rms: 0, max: 0 },
      { type: 'freeform', rms: 0, max: 0 },
    ];
    expect(fits.map((fit) => fitDistance(fit, [3, 0, 0]))).toEqual([1, 1, 1, Math.SQRT1_2 * 3, 0].map((v) => expect.closeTo(v, 12)));
  });
});

describe('segmentation of the plate with a hole (VC-MSH-23)', () => {
  const plate = plateWithHole();

  it('builds a closed outward mesh with the analytic volume of its polygon hole', () => {
    const analysis = analyzeIndexedMesh(plate.positions, plate.indices, { selfIntersections: false, maxListed: 5 });
    expect([analysis.closed, analysis.orientationConsistent, analysis.faces]).toEqual([true, true, 272]);
    const polygonArea = 0.5 * 64 * 25 * Math.sin((2 * Math.PI) / 64);
    expect(analysis.volume as number).toBeCloseTo(6000 - polygonArea * 5, 8);
  });

  it('finds 6 planes and 1 cylinder of radius 5 with its adjacency', () => {
    const result = segmentMesh(plate, {
      featureAngleRad: (30 * Math.PI) / 180,
      fitTolerance: 1e-6,
      kinds: ['plane', 'cylinder', 'cone', 'sphere'],
    });
    const planes = result.groups.filter((g) => g.fit.type === 'plane');
    const cylinders = result.groups.filter((g) => g.fit.type === 'cylinder');
    expect([result.groups.length, planes.length, cylinders.length, result.unassignedFaces]).toEqual([7, 6, 1, 0]);
    const cylinder = cylinders[0]?.fit as { radius: number; axis: Vec3; axisPoint: Vec3; max: number };
    expect(Math.abs(cylinder.radius - 5)).toBeLessThan(1e-9);
    expect(Math.abs(Math.abs(cylinder.axis[2]) - 1)).toBeLessThan(1e-9);
    expect(cylinder.max).toBeLessThan(1e-9);
    expect(Math.abs(cylinder.axisPoint[0] - 20)).toBeLessThan(1e-8);
    expect(cylinders[0]?.faces).toHaveLength(128);
    expect(result.adjacency.length).toBe(14);
    expect(result.adjacency.reduce((sum, pair) => sum + pair.edges, 0)).toBe(4 + 4 + 4 + 64 + 64);
  });
});

describe('segment_mesh', () => {
  it('reports the groups, their fits, the adjacency and the named defaults', () => {
    const { doc, ids } = docWithMeshes(plateWithHole());
    const result = execute(doc, 'segment_mesh', { id: ids[0] as string, fitTolerance: 1e-6 });
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    const data = dataOf(result);
    expect(data['groupCount']).toBe(7);
    expect(data['fitSummary']).toEqual({ plane: 6, cylinder: 1 });
    const groups = data['groups'] as Group[];
    expect(groups.find((g) => g.fit.type === 'cylinder')?.fit).toMatchObject({ type: 'cylinder' });
    expect((data['adjacency'] as unknown[]).length).toBe(14);
    expect(data['unassignedFaces']).toBe(0);
    expect((data['defaults'] as Array<{ name: string }>).map((d) => d.name)).toEqual(['featureAngleDeg']);
    expect(result.summary).toContain('6 plane, 1 cylinder');
  });

  it('keeps a sphere as one sphere, a box as 6 planes, and splits at the feature angle', () => {
    const sphere = docWithMeshes(icosphere(10, 3));
    const one = dataOf(execute(sphere.doc, 'segment_mesh', { id: sphere.ids[0] as string, featureAngleDeg: 40 }));
    expect(one['fitSummary']).toEqual({ sphere: 1 });
    const box = docWithMeshes(cuboid([0, 0, 0], [2, 3, 4]));
    expect(dataOf(execute(box.doc, 'segment_mesh', { id: box.ids[0] as string }))['fitSummary']).toEqual({ plane: 6 });
    const fine = dataOf(execute(sphere.doc, 'segment_mesh', { id: sphere.ids[0] as string, featureAngleDeg: 5, maxListed: 3 }));
    expect((fine['groupCount'] as number) > 3).toBe(true);
    expect((fine['groups'] as unknown[]).length).toBe(3);
    const restricted = dataOf(execute(sphere.doc, 'segment_mesh', { id: sphere.ids[0] as string, kinds: ['plane'], fitTolerance: 0.01 }));
    expect(restricted['fitSummary']).toEqual({ freeform: 1 });
  });

  it('refuses unknown ids, 2D shapes, inconsistent and non-manifold meshes, and is pure', () => {
    const { doc, ids } = docWithMeshes(icosphere(1, 1));
    const id = ids[0] as string;
    const unknown = execute(doc, 'segment_mesh', { id: 'nope' });
    expectNoOp(unknown, doc);
    expect(unknown.error?.code).toBe('MESH_ENTITY_NOT_FOUND');
    const box = cuboid([0, 0, 0], [1, 1, 1]);
    const flipped = { positions: box.positions, indices: [...box.indices] };
    [flipped.indices[1], flipped.indices[2]] = [flipped.indices[2] as number, flipped.indices[1] as number];
    const bad = docWithMeshes(flipped);
    expect(execute(bad.doc, 'segment_mesh', { id: bad.ids[0] as string }).error?.code).toBe('MESH_ORIENTATION_INCONSISTENT');
    const ring = docWithMeshes(torus(5, 2, 12, 8));
    expect(dataOf(execute(ring.doc, 'segment_mesh', { id: ring.ids[0] as string, featureAngleDeg: 60 }))['groupCount']).toBeGreaterThan(0);
    expectPure(doc, () => execute(doc, 'segment_mesh', { id }));
    expect(execute(doc, 'segment_mesh', { id, featureAngleDeg: 0 }).rejected).toBe(true);
  });
});
