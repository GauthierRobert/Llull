/** 03 GDT M1: face resolution, measurement, placement, text and glyph geometry on synthetic exact faces. */
import { describe, expect, it } from 'vitest';
import type { GeometryKernel, ShapeTopology } from '@core/geometry/kernel';
import type { FaceDetail, FaceQueryPort } from '@core/geometry/kernelPorts';
import { resolveFeature, isFeatureProblem, faceTolerance, type ResolvedFeature } from '@core/geometry/pmiFeatures';
import { featureElement, locate, measureSize, type FeatureElement } from '@core/geometry/pmiMeasure';
import { autoPlacement, frameAnchor, planeAxes } from '@core/geometry/pmiPlacement';
import { characteristicSymbol, fcfText, formatNumber, pmiText, sizeNominal, sizeText } from '@core/geometry/pmiText';
import { characteristicGlyph, placeGlyph, DIAMETER_GLYPH } from '@core/geometry/pmiSymbols';
import {
  GEOMETRIC_CHARACTERISTICS,
  type GeometricTolerancePmi,
  type SizeDimensionPmi,
  type PmiFeature,
  type AnnotationPlacement,
} from '@core/model/pmi';
import { type Entity, type ShapeRecipe, createEmptyDocument } from '@core/model/types';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { execute } from '@core/commands/registry';
import { fakeKernel, TETRA } from '../../helpers/fakeKernel';

const MESH = { positions: [0, 0, 0, 10, 10, 10], indices: [0, 1, 0] };
const boxed = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
const RECIPE: ShapeRecipe = recipeOf(boxed.document.entities[boxed.affected[0] as string] as Entity);

function plane(
  index: number,
  centroid: [number, number, number],
  normal: [number, number, number],
  samples: Array<[number, number, number]> = [],
): FaceDetail {
  return { index, surface: 'plane', area: 1, centroid, normal, samples };
}

/** A kernel whose only shape has `faces`; `contains` answers the point-in-face test (null = cannot answer). */
function kernelOf(
  faces: FaceDetail[],
  contains: (face: number, point: readonly number[]) => boolean | null = () => true,
  topology = true,
): GeometryKernel {
  const nothing = (): null => null;
  const port: FaceQueryPort = {
    faceDetails: () => faces,
    faceContains: (_s, face, point) => contains(face, point),
    faceGraph: nothing,
    faceGeometry: nothing,
    projectOnFace: nothing,
    evaluateFace: nothing,
    tessellateFace: nothing,
    faceSamples: nothing,
    edgeSamples: nothing,
    edgeContinuity: nothing,
    distance: nothing,
    bspline: nothing,
    projectCurves: nothing,
  };
  const topo: ShapeTopology = {
    solids: 1,
    faces: faces.map((f) => ({ index: f.index, surface: f.surface, area: f.area })),
    edges: [],
    vertices: 0,
    volume: 1,
  };
  const base = fakeKernel({ solid: { positions: MESH.positions, indices: MESH.indices }, topology: topology ? topo : null });
  return Object.assign(base, { faceQuery: port });
}

const resolved = (kernel: GeometryKernel, points: Array<[number, number, number]>): ResolvedFeature => {
  const r = resolveFeature(kernel, RECIPE, points);
  if (isFeatureProblem(r)) throw new Error(`${r.code}: ${r.message}`);
  return r;
};

describe('resolveFeature', () => {
  it('has a diagonal-scaled tolerance with a floor', () => {
    expect(faceTolerance(1000)).toBe(1);
    expect(faceTolerance(0)).toBe(1e-6);
  });

  it('merges coincident split faces of one plane and reports the faces of each point', () => {
    const faces = [plane(0, [0, 0, 0], [0, 0, 1]), plane(1, [5, 0, 0], [0, 0, 1]), plane(2, [0, 0, 5], [0, 0, 1])];
    const r = resolved(kernelOf(faces), [[2.5, 0, 0.0001]]);
    expect(r.faces.map((f) => f.index)).toEqual([0, 1]);
    expect(r.surface).toBe('plane');
    expect(r.byPoint).toEqual([[0, 1]]);
  });

  it('is ambiguous across different surfaces and reports a point farther than the tolerance', () => {
    const faces = [plane(0, [0, 0, 0], [0, 0, 1]), plane(1, [0, 0, 0], [1, 0, 0])];
    const edge = resolveFeature(kernelOf(faces), RECIPE, [[0, 0, 0]]);
    expect(isFeatureProblem(edge) && edge.code).toBe('GDT_FACE_AMBIGUOUS');
    const far = resolveFeature(kernelOf(faces), RECIPE, [[50, 50, 50]]);
    expect(isFeatureProblem(far) && far.pointIndices).toEqual([0]);
  });

  it('uses samples when the projection is outside the trimmed face or the face has no closed form; a null answer counts as inside', () => {
    const face: FaceDetail = { ...plane(0, [0, 0, 0], [0, 0, 1]), samples: [[3, 3, 0]] };
    expect(
      isFeatureProblem(
        resolveFeature(
          kernelOf([face], () => false),
          RECIPE,
          [[5, 5, 0]],
        ),
      ),
    ).toBe(true);
    expect(
      resolved(
        kernelOf([face], () => false),
        [[3, 3, 0.0001]],
      ).faces,
    ).toHaveLength(1);
    expect(
      resolved(
        kernelOf([face], () => null),
        [[5, 5, 0]],
      ).faces,
    ).toHaveLength(1);
    const cone: FaceDetail = { index: 0, surface: 'cone', area: 1, centroid: [0, 0, 0], samples: [[1, 1, 1]] };
    expect(resolved(kernelOf([cone]), [[1, 1, 1]]).surface).toBe('cone');
  });

  it('finds spheres and cylinders by their exact surface, and a point on a cylinder axis by samples', () => {
    const sphere: FaceDetail = {
      index: 0,
      surface: 'sphere',
      area: 1,
      centroid: [0, 0, 0],
      axis: { origin: [0, 0, 0], dir: [0, 0, 1] },
      radius: 5,
      samples: [],
    };
    expect(resolved(kernelOf([sphere]), [[0, 5, 0]]).surface).toBe('sphere');
    const cyl: FaceDetail = {
      index: 0,
      surface: 'cylinder',
      area: 1,
      centroid: [0, 0, 5],
      axis: { origin: [0, 0, 0], dir: [0, 0, 1] },
      radius: 3,
      samples: [[3, 0, 5]],
    };
    expect(resolved(kernelOf([cyl]), [[3, 0, 4]]).surface).toBe('cylinder');
    expect(isFeatureProblem(resolveFeature(kernelOf([cyl]), RECIPE, [[0, 0, 5]]))).toBe(true);
    expect(isFeatureProblem(resolveFeature(kernelOf([sphere]), RECIPE, [[0, 0, 0]]))).toBe(true);
    const mixed = resolved(kernelOf([cyl, { ...plane(1, [50, 0, 0], [1, 0, 0]), samples: [] }]), [
      [3, 0, 4],
      [50, 1, 1],
    ]);
    expect(mixed.surface).toBe('mixed');
  });

  it('keeps coaxial cylinders of one radius together and separates different surfaces', () => {
    const a: FaceDetail = {
      index: 0,
      surface: 'cylinder',
      area: 1,
      centroid: [0, 0, 1],
      axis: { origin: [0, 0, 0], dir: [0, 0, 1] },
      radius: 3,
      samples: [],
    };
    const b: FaceDetail = { ...a, index: 1, centroid: [0, 0, 3] };
    expect(resolved(kernelOf([a, b]), [[3, 0, 2]]).faces.map((f) => f.index)).toEqual([0, 1]);
    const spherePair: FaceDetail[] = [
      { index: 0, surface: 'sphere', area: 1, centroid: [0, 0, 0], axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, radius: 5, samples: [] },
      { index: 1, surface: 'sphere', area: 1, centroid: [0, 0, 0], axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, radius: 5, samples: [] },
    ];
    expect(resolved(kernelOf(spherePair), [[5, 0, 0]]).faces).toHaveLength(2);
    const noAxis: FaceDetail[] = [
      { index: 0, surface: 'cone', area: 1, centroid: [0, 0, 0], samples: [[0, 0, 0]] },
      { index: 1, surface: 'cone', area: 1, centroid: [0, 0, 0], samples: [[0, 0, 0]] },
    ];
    expect(isFeatureProblem(resolveFeature(kernelOf(noAxis), RECIPE, [[0, 0, 0]]))).toBe(true);
  });

  it('refuses without a kernel, port, topology or faces', () => {
    expect((resolveFeature(null, RECIPE, [[0, 0, 0]]) as { code: string }).code).toBe('GDT_KERNEL_NO_TOPOLOGY');
    expect((resolveFeature(fakeKernel(), RECIPE, [[0, 0, 0]]) as { code: string }).code).toBe('GDT_KERNEL_NO_TOPOLOGY');
    expect(
      (
        resolveFeature(
          kernelOf([plane(0, [0, 0, 0], [0, 0, 1])], () => true, false),
          RECIPE,
          [[0, 0, 0]],
        ) as { code: string }
      ).code,
    ).toBe('GDT_KERNEL_NO_TOPOLOGY');
    const noDetails = kernelOf([]);
    Object.assign(noDetails.faceQuery as FaceQueryPort, { faceDetails: () => null });
    expect((resolveFeature(noDetails, RECIPE, [[0, 0, 0]]) as { code: string }).code).toBe('GDT_KERNEL_NO_TOPOLOGY');
    expect((resolveFeature(fakeKernel({ solid: null }), RECIPE, [[0, 0, 0]]) as { code: string }).code).toBe('GDT_KERNEL_NO_TOPOLOGY');
    const meshless = kernelOf([plane(0, [0, 0, 0], [0, 0, 1])]);
    Object.assign(meshless, { tessellate: () => null });
    expect(isFeatureProblem(resolveFeature(meshless, RECIPE, [[0, 0, 0]]))).toBe(false);
    expect(TETRA.indices.length).toBeGreaterThan(0);
  });
});

describe('measureSize', () => {
  const topo = (convex?: boolean): ShapeTopology => ({
    solids: 1,
    faces: [{ index: 0, surface: 'cylinder', area: 1, ...(convex === undefined ? {} : { convex }) }],
    edges: [],
    vertices: 0,
    volume: 1,
  });
  const cyl = (index: number, x: number, r: number): FaceDetail => ({
    index,
    surface: 'cylinder',
    area: 1,
    centroid: [x, 0, 0],
    axis: { origin: [x, 0, 0], dir: [0, 0, 1] },
    radius: r,
    samples: [],
  });

  it('reads diameters, pin vs bore, counts holes, and refuses mixed sizes', () => {
    const faces = [cyl(0, 0, 3), cyl(1, 10, 3)];
    expect(measureSize(faces, 'diameter', topo(false), 0.1)).toEqual({
      ofSize: { kind: 'cylinder', measured: 6, internal: true },
      count: 2,
    });
    expect(measureSize([cyl(0, 0, 3)], 'radius', topo(true), 0.1)).toMatchObject({ ofSize: { internal: false } });
    expect(measureSize([cyl(0, 0, 3)], 'diameter', topo(), 0.1)).toEqual({ ofSize: { kind: 'cylinder', measured: 6 }, count: 1 });
    expect(measureSize([cyl(0, 0, 3), cyl(1, 5, 4)], 'diameter', topo(), 0.1)).toMatchObject({ code: 'GDT_SIZE_MIXED' });
  });

  it('reads sphere sizes, slot and tab widths, and refuses what is not a feature of size', () => {
    const sphere: FaceDetail = {
      index: 0,
      surface: 'sphere',
      area: 1,
      centroid: [0, 0, 0],
      axis: { origin: [0, 0, 0], dir: [0, 0, 1] },
      radius: 4,
      samples: [],
    };
    expect(measureSize([sphere], 'spherical_diameter', topo(), 0.1)).toEqual({ ofSize: { kind: 'sphere', measured: 8 }, count: 1 });
    const tab = [plane(0, [0, 0, 0], [0, 0, -1]), plane(1, [0, 0, 5], [0, 0, 1])];
    expect(measureSize(tab, 'width', topo(), 0.1)).toEqual({ ofSize: { kind: 'width', measured: 5, internal: false }, count: 1 });
    const slot = [plane(0, [0, 0, 0], [0, 0, 1]), plane(1, [0, 0, 5], [0, 0, -1])];
    expect(measureSize(slot, 'width', topo(), 0.1)).toMatchObject({ ofSize: { internal: true } });
    expect(measureSize([tab[0] as FaceDetail], 'width', topo(), 0.1)).toMatchObject({ code: 'GDT_NOT_FOS' });
    expect(measureSize([tab[0] as FaceDetail, cyl(1, 0, 1)], 'width', topo(), 0.1)).toMatchObject({ code: 'GDT_NOT_FOS' });
    expect(measureSize([plane(0, [0, 0, 0], [0, 0, 1]), plane(1, [0, 0, 5], [0, 0, 1])], 'width', topo(), 0.1)).toMatchObject({
      code: 'GDT_NOT_FOS',
    });
    expect(measureSize([tab[0] as FaceDetail], 'diameter', topo(), 0.1)).toMatchObject({ code: 'GDT_NOT_FOS' });
    expect(measureSize([cyl(0, 0, 1)], 'spherical_diameter', topo(), 0.1)).toMatchObject({ code: 'GDT_SIZE_KIND_MISMATCH' });
    expect(measureSize([sphere], 'diameter', topo(), 0.1)).toMatchObject({ code: 'GDT_SIZE_KIND_MISMATCH' });
  });
});

describe('featureElement and locate', () => {
  const axis = (x: number, y: number, dir: [number, number, number] = [0, 0, 1]): FaceDetail => ({
    index: 0,
    surface: 'cylinder',
    area: 1,
    centroid: [x, y, 0],
    axis: { origin: [x, y, 0], dir },
    radius: 1,
    samples: [],
  });
  const el = (faces: FaceDetail[]): FeatureElement => featureElement(faces, 0.01) as FeatureElement;

  it('reduces a feature to its plane or axis and refuses spans', () => {
    expect(el([plane(0, [0, 0, 0], [0, 0, 1])])).toMatchObject({ type: 'plane' });
    expect(el([axis(0, 0)])).toMatchObject({ type: 'axis' });
    expect(el([{ ...axis(0, 0), surface: 'cone' }])).toMatchObject({ type: 'axis' });
    expect(featureElement([plane(0, [0, 0, 0], [0, 0, 1]), plane(1, [0, 0, 5], [0, 0, 1])], 0.01)).toMatchObject({
      code: 'GDT_LOCATION_AMBIGUOUS',
    });
    expect(featureElement([axis(0, 0), axis(5, 0)], 0.01)).toMatchObject({ code: 'GDT_LOCATION_AMBIGUOUS' });
    expect(featureElement([axis(0, 0), axis(0, 0, [1, 0, 0])], 0.01)).toMatchObject({ code: 'GDT_LOCATION_AMBIGUOUS' });
    expect(featureElement([{ index: 0, surface: 'sphere', area: 1, centroid: [0, 0, 0], samples: [] }], 0.01)).toMatchObject({
      code: 'GDT_LOCATION_AMBIGUOUS',
    });
    expect(featureElement([], 0.01)).toMatchObject({ code: 'GDT_LOCATION_AMBIGUOUS' });
  });

  it('measures distances and angles between planes, axes and axis-plane pairs', () => {
    const floor = el([plane(0, [0, 0, 0], [0, 0, 1])]);
    const roof = el([plane(0, [0, 0, 7], [0, 0, -1])]);
    const wall = el([plane(0, [0, 0, 0], [1, 0, 0])]);
    const a = el([axis(0, 0)]);
    const b = el([axis(3, 4)]);
    const tilted = el([axis(0, 0, [0, Math.SQRT1_2, Math.SQRT1_2])]);
    expect(locate(floor, roof, 'distance')).toEqual({ measured: 7 });
    expect(locate(a, b, 'distance')).toEqual({ measured: 5 });
    expect(locate(a, wall, 'distance')).toEqual({ measured: 0 });
    expect(locate(wall, a, 'distance')).toEqual({ measured: 0 });
    expect(locate(floor, wall, 'distance')).toHaveProperty('code', 'GDT_LOCATION_INVALID');
    expect(locate(a, tilted, 'distance')).toHaveProperty('code', 'GDT_LOCATION_INVALID');
    expect(locate(a, floor, 'distance')).toHaveProperty('code', 'GDT_LOCATION_INVALID');
    expect((locate(floor, wall, 'angle') as { measured: number }).measured).toBeCloseTo(90, 9);
    expect((locate(a, tilted, 'angle') as { measured: number }).measured).toBeCloseTo(45, 9);
    expect((locate(a, floor, 'angle') as { measured: number }).measured).toBeCloseTo(90, 9);
  });
});

describe('placement', () => {
  const place = (face: FaceDetail, taken: AnnotationPlacement[] = []): AnnotationPlacement => autoPlacement(face, 100, taken);

  it('follows the Z, X, Y tie-break of the spec for planar features', () => {
    const normalOf = (n: [number, number, number]): number[] =>
      [...place(plane(0, [0, 0, 0], n)).plane.normal].map((c) => Math.round(c * 1e9) / 1e9);
    expect(normalOf([0, 0, -1])).toEqual([0, -1, 0]);
    expect(normalOf([0, 1, 0])).toEqual([1, 0, 0]);
    expect(normalOf([-1, 0, 0])).toEqual([0, 1, 0]);
    expect(Object.is(place(plane(0, [0, 0, 0], [0, 0, -1])).plane.xDir[2], -0)).toBe(false);
  });

  it('puts cylinder frames in the plane perpendicular to the axis with a rim leader, and others on a default plane', () => {
    const cyl: FaceDetail = {
      index: 0,
      surface: 'cylinder',
      area: 1,
      centroid: [1, 2, 3],
      axis: { origin: [1, 2, 0], dir: [0, 0, 1] },
      radius: 4,
      samples: [],
    };
    const p = place(cyl);
    expect(p.plane.normal).toEqual([0, 0, 1]);
    expect(p.position[0]).toBeCloseTo(10.6066017, 6);
    expect(Math.hypot(...((p.leaderTo ?? [0, 0, 0]).map((c, i) => c - [1, 2, 3][i]!) as [number, number, number]))).toBeCloseTo(4, 9);
    expect(place({ index: 0, surface: 'bspline', area: 1, centroid: [0, 0, 0], samples: [] }).plane.normal).toEqual([0, 1, 0]);
    expect(planeAxes([0, 0, 1]).xDir).toEqual([1, 0, 0]);
  });

  it('shifts along x past frames already in the same plane, deterministically', () => {
    const first = place(plane(0, [0, 0, 0], [0, 0, -1]));
    const second = place(plane(1, [0, 0, 0], [0, 0, -1]), [first]);
    expect(second.position[0]).toBeGreaterThan(first.position[0]);
    expect(place(plane(1, [0, 0, 0], [0, 0, -1]), [first])).toEqual(second);
    const elsewhere = place(plane(2, [0, 50, 9], [0, 0, -1]), [first]);
    expect(elsewhere.position).toEqual(first.position);
    const anchor = frameAnchor({ ...first, position: [0, 0] });
    expect(anchor).toEqual(first.plane.origin);
  });
});

describe('text and glyphs', () => {
  const feature = (surface: PmiFeature['surface'] = 'plane', ofSize?: PmiFeature['ofSize']): PmiFeature => ({
    entityId: 'e',
    facesNear: [[0, 0, 0]],
    faceIndices: [0],
    surface,
    ...(ofSize === undefined ? {} : { ofSize }),
  });
  const base = {
    placement: { plane: { origin: [0, 0, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, position: [0, 0], auto: true },
    review: { required: true },
  } as const;
  const fcf = (extra: Partial<GeometricTolerancePmi>): GeometricTolerancePmi => ({
    ...base,
    id: 'f',
    kind: 'geometric_tolerance',
    characteristic: 'position',
    target: { feature: feature() },
    zone: { value: 0.3 },
    materialCondition: 'RFS',
    modifiers: [],
    datums: [],
    ...extra,
  });

  it('renders every characteristic, modifier and datum reference in Unicode and ASCII', () => {
    for (const c of GEOMETRIC_CHARACTERISTICS) {
      expect(characteristicSymbol(c).length).toBeGreaterThan(0);
      expect(characteristicSymbol(c, true)).toBe(characteristicSymbol(c, true).toUpperCase());
      expect(characteristicGlyph(c).length).toBeGreaterThan(0);
    }
    const item = fcf({
      zone: { value: 0.3, spherical: true, projectedLength: 5, unequallyDisposed: 0.1, maxValue: 0.5 },
      materialCondition: 'LMC',
      modifiers: ['tangent_plane', 'all_over'],
      datums: [{ label: 'A', boundary: 'MMB' }, { label: 'B', boundary: 'LMB' }, { label: 'C' }],
    });
    expect(fcfText(item)).toBe('⌖ | SØ0.3 Ⓛ Ⓟ5 Ⓣ ALL OVER UZ 0.1 MAX 0.5 | A Ⓜ | B Ⓛ | C');
    expect(fcfText(item, true)).toBe('POSITION | SØ0.3 (L) (P)5 (T) ALL OVER UZ 0.1 MAX 0.5 | A (M) | B (L) | C');
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
  });

  it('renders sizes, locations, texture, targets and notes', () => {
    const size = (extra: Partial<SizeDimensionPmi>): SizeDimensionPmi => ({
      ...base,
      id: 's',
      kind: 'size_dimension',
      sizeKind: 'diameter',
      tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
      count: 1,
      feature: feature('cylinder', { kind: 'cylinder', measured: 10 }),
      ...extra,
    });
    expect(sizeText(size({}))).toBe('Ø10 ±0.1');
    expect(sizeText(size({ tolerance: { type: 'plusMinus', upper: 0.2, lower: 0 }, count: 3 }))).toBe('3X Ø10 +0.2/0');
    expect(sizeText(size({ sizeKind: 'radius', tolerance: { type: 'plusMinus', upper: 0, lower: -0.2 } }))).toBe('R5 0/-0.2');
    expect(sizeText(size({ sizeKind: 'spherical_diameter', tolerance: { type: 'basic' } }))).toBe('[SØ10]');
    expect(sizeText(size({ feature: feature('cylinder') }))).toBe('Ø? ±0.1');
    expect(sizeText(size({ sizeModifiers: ['E', 'GG'] }), true)).toBe('Ø10 ±0.1 (E) (GG)');
    expect(sizeNominal(size({ sizeKind: 'radius' }))).toBe(5);
    expect(
      pmiText({
        ...base,
        id: 'l',
        kind: 'location_dimension',
        from: feature(),
        to: feature(),
        measure: 'angle',
        measured: 45,
        tolerance: { type: 'basic' },
      }),
    ).toBe('[45°]');
    expect(
      pmiText({
        ...base,
        id: 'l',
        kind: 'location_dimension',
        from: feature(),
        to: feature(),
        measure: 'distance',
        measured: 20,
        tolerance: { type: 'plusMinus', upper: 0.1, lower: -0.1 },
      }),
    ).toBe('20 ±0.1');
    expect(pmiText({ ...base, id: 't', kind: 'surface_texture', feature: feature(), parameter: 'Ra', value: 1.6, unit: 'um' }, true)).toBe(
      'Ra 1.6 um',
    );
    expect(pmiText({ ...base, id: 'd', kind: 'datum_target', label: 'A', targetNumber: 2, targetKind: 'point', feature: feature() })).toBe(
      'A2',
    );
    expect(pmiText({ ...base, id: 'n', kind: 'note', text: 'HI' })).toBe('HI');
    expect(pmiText({ ...base, id: 'd', kind: 'datum_feature', label: 'A', feature: feature() })).toBe('[A]');
  });

  it('places glyphs in paper millimetres with y down', () => {
    const [circle, slash] = placeGlyph(DIAMETER_GLYPH, 10, 20, 10);
    expect(circle).toEqual({ kind: 'circle', center: [15, 25], radius: 3 });
    const points = slash?.kind === 'line' ? slash.points : [];
    expect(points[0]?.[0]).toBeCloseTo(11.8, 9);
    expect(points[0]?.[1]).toBeCloseTo(29.2, 9);
    expect(points[1]?.[1]).toBeCloseTo(20.8, 9);
  });
});
