/**
 * TR-KRN-92: the face-query port of the live OCC kernel against closed forms, one analytic fixture per surface type
 * (plane = box, cylinder, cone, sphere, torus). B-spline faces: `bspline` / `tessellateFace` are not implemented (null), see TECHNICAL_SPEC §13.B.
 */
import { expect, it } from 'vitest';
import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import type { FaceDetail, FaceQueryPort } from '@core/geometry/kernelPorts';
import type { Entity, ShapeRecipe, Vec3 } from '@core/model/types';
import { liveKernels, describeNative } from './kernelTestSupport';

const common = { layerId: 'layer-default', color: '#888888', rotation: [0, 0, 0] as Vec3, position: [0, 0, 0] as Vec3 };
const solid = (fields: Record<string, unknown>): ShapeRecipe => ({ op: 'solid', entity: { id: 's', ...common, ...fields } as Entity });

const BOX = solid({ kind: 'box', size: [10, 20, 30] });
const CYLINDER = solid({ kind: 'cylinder', radius: 5, height: 20 });
const CONE = solid({ kind: 'cone', radius: 4, height: 10 });
const SPHERE = solid({ kind: 'sphere', radius: 7 });
const TORUS = solid({ kind: 'torus', ringRadius: 10, tubeRadius: 3 });

const kernels = liveKernels();
const port = (): FaceQueryPort => {
  const query = kernels.occt.faceQuery;
  expect(query).toBeDefined();
  return query as FaceQueryPort;
};
const shapeOf = (recipe: ShapeRecipe, kernel: GeometryKernel = kernels.occt): ShapeHandle => {
  const handle = kernel.evaluate(recipe);
  expect(handle).not.toBeNull();
  return handle as ShapeHandle;
};
const detailsOf = (recipe: ShapeRecipe): readonly FaceDetail[] => {
  const details = port().faceDetails(shapeOf(recipe), { samples: 16 });
  expect(details).not.toBeNull();
  return details as readonly FaceDetail[];
};
const faceOf = (details: readonly FaceDetail[], surface: string, near?: Vec3): FaceDetail => {
  const matches = details.filter(
    (face) => face.surface === surface && (near === undefined || face.normal?.every((c, k) => Math.abs(c - (near[k] ?? 0)) < 1e-9)),
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0] as FaceDetail;
};
const close = (actual: readonly number[], expected: readonly number[], digits = 8): void =>
  expected.forEach((value, k) => expect(actual[k] ?? Number.NaN).toBeCloseTo(value, digits));

describeNative('occt face query: plane (box 10 x 20 x 30)', () => {
  it('faceDetails: area, centroid, outward normal, samples inside the face', () => {
    const details = detailsOf(BOX);
    expect(details).toHaveLength(6);
    const right = faceOf(details, 'plane', [1, 0, 0]);
    expect(right.area).toBeCloseTo(600, 8);
    close(right.centroid, [5, 0, 0]);
    expect(right.samples).toHaveLength(16);
    for (const sample of right.samples) {
      expect(sample[0]).toBeCloseTo(5, 8);
      expect(Math.abs(sample[1])).toBeLessThan(10);
      expect(Math.abs(sample[2])).toBeLessThan(15);
    }
    const normalSum = details.reduce((sum, face) => sum.map((c, k) => c + (face.normal?.[k] ?? 0)), [0, 0, 0]);
    close(normalSum, [0, 0, 0]);
  });

  it('faceGeometry, evaluateFace and faceSamples (zero curvature)', () => {
    const shape = shapeOf(BOX);
    const index = faceOf(detailsOf(BOX), 'plane', [0, 0, 1]).index;
    const geometry = port().faceGeometry(shape, index);
    expect(geometry?.surface.type).toBe('plane');
    if (geometry?.surface.type === 'plane') close(geometry.surface.normal.map(Math.abs), [0, 0, 1]);
    const [lowest, highest] = geometry?.uvBounds ?? [];
    const mid: [number, number] = [((lowest?.[0] ?? 0) + (highest?.[0] ?? 0)) / 2, ((lowest?.[1] ?? 0) + (highest?.[1] ?? 0)) / 2];
    const evaluated = port().evaluateFace(shape, index, [mid]);
    close(evaluated?.[0]?.point ?? [], [0, 0, 15]);
    close(evaluated?.[0]?.normal ?? [], [0, 0, 1]);
    const samples = port().faceSamples(shape, index, { nu: 2, nv: 3 });
    expect(samples).toHaveLength(6);
    for (const sample of samples ?? []) {
      expect(sample.degenerate).toBe(false);
      close([sample.k1, sample.k2, sample.gaussian, sample.mean], [0, 0, 0, 0]);
    }
  });

  it('faceContains: inside, outside the trim, off the plane, tolerance', () => {
    const shape = shapeOf(BOX);
    const index = faceOf(detailsOf(BOX), 'plane', [1, 0, 0]).index;
    expect(port().faceContains(shape, index, [5, 1, 2])).toBe(true);
    expect(port().faceContains(shape, index, [5, 11, 0])).toBe(false);
    expect(port().faceContains(shape, index, [6, 0, 0])).toBe(false);
    expect(port().faceContains(shape, index, [6, 0, 0], 1.5)).toBe(true);
    expect(port().faceContains(shape, 99, [5, 0, 0])).toBeNull();
  });

  it('projectOnFace: closest point, outward normal, uv and distance; a point beyond the trim lands on its boundary', () => {
    const shape = shapeOf(BOX);
    const index = faceOf(detailsOf(BOX), 'plane', [1, 0, 0]).index;
    const [near, beyond] =
      port().projectOnFace(shape, index, [
        [15, 1, 2],
        [15, 14, 0],
      ]) ?? [];
    close(near?.point ?? [], [5, 1, 2]);
    close(near?.normal ?? [], [1, 0, 0]);
    expect(near?.distance).toBeCloseTo(10, 8);
    expect(near?.uv).toHaveLength(2);
    close(beyond?.point ?? [], [5, 10, 0]);
    expect(beyond?.distance).toBeCloseTo(Math.hypot(10, 4), 8);
  });

  it('distance: signed (negative inside), nearest face index, -1 on an edge', () => {
    const shape = shapeOf(BOX);
    const right = faceOf(detailsOf(BOX), 'plane', [1, 0, 0]).index;
    const results = port().distance(shape, [
      [0, 0, 0],
      [8, 0, 0],
      [8, 13, 0],
    ]);
    expect(results?.[0]?.signed).toBeCloseTo(-5, 8);
    expect(results?.[0]?.distance).toBeCloseTo(5, 8);
    expect(results?.[1]).toMatchObject({ face: right });
    expect(results?.[1]?.signed).toBeCloseTo(3, 8);
    expect(results?.[2]?.face).toBe(-1);
    expect(results?.[2]?.distance).toBeCloseTo(Math.hypot(3, 3), 8);
    expect(port().distance(shape, [])).toEqual([]);
  });

  it('faceGraph: 12 edges each between 2 faces, all convex; loops outer first', () => {
    const graph = port().faceGraph(shapeOf(BOX));
    expect(graph?.faces).toHaveLength(6);
    expect(graph?.edgeFaces).toHaveLength(12);
    expect(graph?.edgeFaces.every((faces) => faces.length === 2)).toBe(true);
    expect(graph?.edgeConvexity.every((kind) => kind === 'convex')).toBe(true);
    for (const face of graph?.faces ?? []) {
      expect(face.loops).toHaveLength(1);
      expect(face.loops[0]).toHaveLength(4);
      expect(face.surface.type).toBe('plane');
      expect(typeof face.reversed).toBe('boolean');
    }
    expect(graph?.faces.map((face) => face.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('faceGraph: a concave step edge and smooth fillet edges', () => {
    const lower = { op: 'solid', entity: { id: 'a', ...common, kind: 'box', size: [20, 20, 10] } } as ShapeRecipe;
    const upper = { op: 'solid', entity: { id: 'b', ...common, kind: 'box', size: [10, 20, 10], position: [-5, 0, 10] } } as ShapeRecipe;
    const stepped = port().faceGraph(shapeOf({ op: 'boolean', boolean: 'union', a: lower, b: upper }));
    expect(stepped?.edgeConvexity.filter((kind) => kind === 'concave')).toHaveLength(1);
    expect(stepped?.edgeConvexity.filter((kind) => kind === 'unknown')).toHaveLength(0);
    const rounded = port().faceGraph(shapeOf({ op: 'fillet', source: BOX, edges: [], size: 1 }));
    expect(rounded?.edgeConvexity.filter((kind) => kind === 'smooth').length).toBeGreaterThanOrEqual(24);
    const roundedShape = shapeOf({ op: 'fillet', source: BOX, edges: [], size: 1 });
    const edges = kernels.occt.topology(roundedShape)?.edges ?? [];
    rounded?.edgeConvexity.forEach((kind, index) => {
      if (kind === 'unknown') expect(edges[index]?.degenerate).toBe(true);
    });
  });
});

describeNative('occt face query: cylinder (r 5, h 20)', () => {
  const lateral = (): FaceDetail => faceOf(detailsOf(CYLINDER), 'cylinder');

  it('faceDetails: lateral area, axis, radius; faceGraph keeps the seam smooth', () => {
    const face = lateral();
    expect(face.area).toBeCloseTo(2 * Math.PI * 5 * 20, 6);
    close(face.centroid, [0, 0, 0], 6);
    expect(face.radius).toBeCloseTo(5, 9);
    close((face.axis?.dir ?? []).map(Math.abs), [0, 0, 1]);
    const graph = port().faceGraph(shapeOf(CYLINDER));
    expect(graph?.edgeConvexity.filter((kind) => kind === 'smooth')).toHaveLength(1);
    expect(graph?.edgeConvexity.filter((kind) => kind === 'convex')).toHaveLength(2);
  });

  it('faceSamples: k1 = 1 / r, k2 = 0, principal direction round the axis; projection distance', () => {
    const shape = shapeOf(CYLINDER);
    const index = lateral().index;
    const samples = port().faceSamples(shape, index, { nu: 3, nv: 3 }) ?? [];
    expect(samples).toHaveLength(9);
    for (const sample of samples) {
      close([sample.k1, sample.k2, sample.gaussian, sample.mean], [0.2, 0, 0, 0.1], 8);
      expect(Math.hypot(...sample.point.slice(0, 2))).toBeCloseTo(5, 8);
      expect(Math.abs(sample.dir2[2])).toBeCloseTo(1, 8);
      expect(Math.hypot(sample.normal[0], sample.normal[1])).toBeCloseTo(1, 8);
    }
    const projected = port().projectOnFace(shape, index, [[12, 0, 1]]);
    expect(projected?.[0]?.distance).toBeCloseTo(7, 8);
    close(projected?.[0]?.point ?? [], [5, 0, 1]);
    close(projected?.[0]?.normal ?? [], [1, 0, 0]);
  });

  it('a bore is concave: k2 = -1 / r and the plane normals stay outward', () => {
    const bored: ShapeRecipe = { op: 'boolean', boolean: 'subtract', a: BOX, b: solid({ kind: 'cylinder', radius: 2, height: 60 }) };
    const details = detailsOf(bored);
    const bore = faceOf(details, 'cylinder');
    const samples = port().faceSamples(shapeOf(bored), bore.index, { nu: 2, nv: 2 }) ?? [];
    for (const sample of samples) close([sample.k1, sample.k2], [0, -0.5], 8);
    const top = faceOf(details, 'plane', [0, 0, 1]);
    close(top.normal ?? [], [0, 0, 1]);
    expect(top.area).toBeCloseTo(200 - Math.PI * 4, 6);
    expect(
      port()
        .faceGraph(shapeOf(bored))
        ?.faces.some((face) => face.reversed),
    ).toBe(true);
    const inside = port().distance(shapeOf(bored), [[0, 0, 0]]);
    expect(inside?.[0]?.signed).toBeCloseTo(2, 8);
    expect(inside?.[0]?.face).toBe(bore.index);
  });
});

describeNative('occt face query: cone (r 4, h 10)', () => {
  it('faceSamples: k1 = 0, k2 = cos(a) / rho; surface parameters carry the semi angle', () => {
    const shape = shapeOf(CONE);
    const face = faceOf(detailsOf(CONE), 'cone');
    const semiAngle = Math.atan2(4, 10);
    const geometry = port().faceGeometry(shape, face.index);
    expect(geometry?.surface.type === 'cone' ? geometry.surface.semiAngle : Number.NaN).toBeCloseTo(semiAngle, 9);
    const samples = port().faceSamples(shape, face.index, { nu: 2, nv: 2 }) ?? [];
    expect(samples).toHaveLength(4);
    for (const sample of samples) {
      const rho = Math.hypot(sample.point[0], sample.point[1]);
      expect(sample.k1).toBeCloseTo(Math.cos(semiAngle) / rho, 7);
      expect(sample.k2).toBeCloseTo(0, 8);
      expect(rho).toBeCloseTo((4 * (10 - sample.point[2])) / 10, 7);
    }
    expect(face.radius).toBeGreaterThan(0);
    expect(face.radius).toBeLessThan(4);
  });
});

describeNative('occt face query: sphere (r 7)', () => {
  it('faceDetails: area 4 pi r2, centre, radius; samples on the sphere', () => {
    const face = faceOf(detailsOf(SPHERE), 'sphere');
    expect(face.area).toBeCloseTo(4 * Math.PI * 49, 5);
    close(face.centroid, [0, 0, 0], 5);
    expect(face.radius).toBeCloseTo(7, 9);
    expect(face.samples.length).toBeGreaterThan(0);
    for (const sample of face.samples) expect(Math.hypot(...sample)).toBeCloseTo(7, 7);
  });

  it('faceSamples: k1 = k2 = 1 / r, K = 1 / r2, H = 1 / r; projection and containment', () => {
    const shape = shapeOf(SPHERE);
    const index = faceOf(detailsOf(SPHERE), 'sphere').index;
    for (const sample of port().faceSamples(shape, index, { nu: 3, nv: 3 }) ?? []) {
      close([sample.k1, sample.k2, sample.gaussian, sample.mean], [1 / 7, 1 / 7, 1 / 49, 1 / 7], 8);
      close(
        sample.normal,
        sample.point.map((c) => c / 7),
        8,
      );
    }
    const projected = port().projectOnFace(shape, index, [[14, 0, 0]]);
    expect(projected?.[0]?.distance).toBeCloseTo(7, 8);
    close(projected?.[0]?.point ?? [], [7, 0, 0], 7);
    close(projected?.[0]?.normal ?? [], [1, 0, 0], 7);
    expect(port().faceContains(shape, index, [0, 7, 0])).toBe(true);
    expect(port().faceContains(shape, index, [0, 8, 0])).toBe(false);
    const signed = port().distance(shape, [
      [0, 0, 0],
      [10, 0, 0],
    ]);
    expect(signed?.[0]?.signed).toBeCloseTo(-7, 8);
    expect(signed?.[1]?.signed).toBeCloseTo(3, 8);
    expect(signed?.[1]?.face).toBe(index);
  });
});

describeNative('occt face query: torus (R 10, r 3)', () => {
  it('faceDetails: area 4 pi2 R r, minor radius, axis', () => {
    const face = faceOf(detailsOf(TORUS), 'torus');
    expect(face.area).toBeCloseTo(4 * Math.PI * Math.PI * 10 * 3, 4);
    expect(face.radius).toBeCloseTo(3, 9);
    close((face.axis?.dir ?? []).map(Math.abs), [0, 0, 1]);
    close(face.centroid, [0, 0, 0], 5);
  });

  it('faceSamples: k1 = 1 / r (minor circle), k2 = (rho - R) / (r rho)', () => {
    const shape = shapeOf(TORUS);
    const index = faceOf(detailsOf(TORUS), 'torus').index;
    const samples = port().faceSamples(shape, index, { nu: 4, nv: 4 }) ?? [];
    expect(samples).toHaveLength(16);
    for (const sample of samples) {
      const rho = Math.hypot(sample.point[0], sample.point[1]);
      const expected = [1 / 3, (rho - 10) / (3 * rho)].sort((a, b) => b - a);
      close([sample.k1, sample.k2], expected, 7);
    }
    const geometry = port().faceGeometry(shape, index);
    expect(geometry?.surface).toMatchObject({ type: 'torus', major: 10, minor: 3 });
    const projected = port().projectOnFace(shape, index, [[20, 0, 0]]);
    expect(projected?.[0]?.distance).toBeCloseTo(7, 7);
    close(projected?.[0]?.point ?? [], [13, 0, 0], 7);
  });
});

describeNative('occt face query: unsupported and out-of-range requests', () => {
  it('returns null (never throws) for unimplemented methods and bad indices', () => {
    const shape = shapeOf(BOX);
    expect(port().tessellateFace(shape, 0, 0.1)).toBeNull();
    expect(port().edgeSamples(shape, 99, 4)).toBeNull();
    expect(port().edgeContinuity(shape, 99, 4)).toBeNull();
    expect(port().bspline(shape, 0)).toBeNull();
    expect(port().faceGeometry(shape, -1)).toBeNull();
    expect(port().faceGeometry(shape, 6)).toBeNull();
    expect(port().projectOnFace(shape, 6, [[0, 0, 0]])).toBeNull();
    expect(port().evaluateFace(shape, 6, [[0, 0]])).toBeNull();
    expect(port().faceSamples(shape, 0, { nu: 0, nv: 1 })).toBeNull();
  });

  it('a refused recipe (null handle) is not an error of the port; Manifold has no port', () => {
    expect(kernels.manifold.faceQuery).toBeUndefined();
    expect(kernels.occt.evaluate({ op: 'fillet', source: BOX, edges: [], size: 500 })).toBeNull();
  });
});

describeNative('face query through the isolated worker kernel', () => {
  it('forwards every method with key-only handles and returns the same answers', () => {
    const shape = shapeOf(BOX, kernels.occt);
    const query = kernels.occt.faceQuery as FaceQueryPort;
    const details = query.faceDetails(shape, { samples: 4 });
    expect(details).toHaveLength(6);
    expect(details?.[0]?.samples).toHaveLength(4);
    expect(query.faceContains(shape, 0, details?.[0]?.centroid ?? [0, 0, 0])).toBe(true);
    expect(query.faceGraph(shape)?.edgeFaces).toHaveLength(12);
    expect(query.faceGeometry(shape, 0)?.surface.type).toBe('plane');
    expect(query.projectOnFace(shape, 0, [[50, 0, 0]])?.[0]?.distance).toBeGreaterThan(0);
    expect(query.evaluateFace(shape, 0, [[0, 0]])).toHaveLength(1);
    expect(query.faceSamples(shape, 0, { nu: 1, nv: 1 })).toHaveLength(1);
    expect(query.distance(shape, [[0, 0, 0]])?.[0]?.signed).toBeCloseTo(-5, 8);
    expect(query.tessellateFace(shape, 0, 0.1)).toBeNull();
    expect(query.edgeSamples(shape, 99, 2)).toBeNull();
    expect(query.edgeContinuity(shape, 99, 2)).toBeNull();
    expect(query.bspline(shape, 0)).toBeNull();
  }, 180_000);
});
