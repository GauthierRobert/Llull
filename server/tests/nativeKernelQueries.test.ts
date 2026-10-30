/**
 * Native `llull-kernel` (OCCT 7.9.2) query ops (VC-KRN-25 slice 2), against closed forms and invariants of the B-rep: exact topology
 * (census, Euler characteristic, face areas summing to the exact area; fillet and chamfer select edges by these indices), every
 * face-query method and shape distance. Corpus: the 11 primitives and 4 boolean recipes of the first slice. Skipped without the binary.
 */

import { describe, expect, it } from 'vitest';
import type { ShapeDistance, ShapeTopology } from '@core/geometry/kernel';
import type { ExactMassProperties, FaceDetail, FaceGraph, FaceProjection, SurfaceSample } from '@core/geometry/kernelPorts';
import type { ShapeRecipe, Vec2, Vec3 } from '@core/model/types';
import { box, leaf, nativeKernelBinary } from './kernelTestSupport';
import { CLOSED_FORM, CORPUS, entity, handleOf, relative } from './nativeKernelCorpus';
import { nativeReferenceHarness } from './nativeReferenceSupport';

const harness = nativeReferenceHarness();
const TOLERANCE = 1e-6;
const on = <T>(op: string, recipe: ShapeRecipe, ...rest: unknown[]): Promise<T> => harness.on(op, recipe, ...rest) as Promise<T>;
const query = <T>(method: string, recipe: ShapeRecipe, ...rest: unknown[]): Promise<T> => on<T>(`faceQuery.${method}`, recipe, ...rest);
const len = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Face count and genus of each corpus shape (Euler: vertices - edges + faces = 2 - 2 genus); the nested recipe is not tabulated. */
const CENSUS: Readonly<Record<string, readonly [faces: number, genus: number]>> = {
  box: [6, 0],
  'rotated box': [6, 0],
  cylinder: [3, 0],
  'rotated cylinder': [3, 0],
  sphere: [1, 0],
  cone: [2, 0],
  torus: [1, 1],
  wedge: [5, 0],
  extrusion: [8, 0],
  revolution: [6, 0],
  pyramid: [6, 0], // the base is sewn from two triangles
  union: [10, 0],
  subtract: [7, 1],
  intersect: [3, 0],
};

const FACE_QUERY_CORPUS: readonly [string, ShapeRecipe][] = CORPUS.filter(([label]) =>
  ['box', 'rotated cylinder', 'sphere', 'cone', 'torus', 'revolution', 'subtract', 'nested, placed and scaled'].includes(label),
);

describe.skipIf(nativeKernelBinary === null)('native topology (closed-form census)', () => {
  it.each(CORPUS)('%s: face areas sum to the exact area, Euler characteristic, volume', async (label, recipe) => {
    const topology = await on<ShapeTopology>('topology', recipe);
    const exact = await on<ExactMassProperties>('massProperties', recipe);
    expect(relative(topology.volume, exact.volume), `${label} volume`).toBeLessThan(TOLERANCE);
    expect(
      relative(
        topology.faces.reduce((sum, face) => sum + face.area, 0),
        exact.area,
      ),
      `${label} area`,
    ).toBeLessThan(TOLERANCE);
    const closedForm = CLOSED_FORM[label];
    if (closedForm !== undefined) expect(relative(topology.volume, closedForm[0]), `${label} closed form`).toBeLessThan(TOLERANCE);
    const census = CENSUS[label];
    if (census === undefined) return;
    expect(topology.faces, label).toHaveLength(census[0]);
    // Euler-Poincare: V - E + F - (loops - F) = 2 - 2 genus, over the proper edges (a degenerate pole / apex edge is no edge) and the
    // boundary loops of the faces (a face with a hole has two).
    const graph = await query<FaceGraph>('faceGraph', recipe);
    const properEdges = topology.edges.filter((edge) => !edge.degenerate).length;
    const extraLoops = graph.faces.reduce((sum, face) => sum + face.loops.length - 1, 0);
    expect(topology.vertices - properEdges + topology.faces.length - extraLoops, `${label} Euler`).toBe(2 - 2 * census[1]);
    topology.faces.forEach((face, index) => expect(face.index).toBe(index));
    topology.edges.forEach((edge, index) => expect(edge.index).toBe(index));
  });
});

describe.skipIf(nativeKernelBinary === null)('native face-query port (invariants of the exact B-rep)', () => {
  it.each(FACE_QUERY_CORPUS)('%s: faceDetails and faceGraph tile the surface', async (label, recipe) => {
    const exact = await on<ExactMassProperties>('massProperties', recipe);
    const topology = await on<ShapeTopology>('topology', recipe);
    for (const options of [[], [{ samples: 5 }]]) {
      const details = await query<FaceDetail[]>('faceDetails', recipe, ...options);
      expect(details, label).toHaveLength(topology.faces.length);
      expect(
        relative(
          details.reduce((sum, face) => sum + face.area, 0),
          exact.area,
        ),
        `${label} area`,
      ).toBeLessThan(TOLERANCE);
      if (options.length > 0) details.forEach((face) => expect(face.samples.length).toBeLessThanOrEqual(5));
    }
    const graph = await query<FaceGraph>('faceGraph', recipe);
    expect(graph.faces, label).toHaveLength(topology.faces.length);
    expect(graph.edgeFaces, label).toHaveLength(topology.edges.length);
    expect(graph.edgeConvexity, label).toHaveLength(topology.edges.length);
    for (const faces of graph.edgeFaces) expect(faces.length, label).toBeGreaterThan(0);
    expect(
      relative(
        graph.faces.reduce((sum, face) => sum + face.area, 0),
        exact.area,
      ),
      `${label} graph area`,
    ).toBeLessThan(TOLERANCE);
  });

  it.each(FACE_QUERY_CORPUS)('%s: per-face geometry, evaluation, curvature, projection and containment agree', async (label, recipe) => {
    const topology = await on<ShapeTopology>('topology', recipe);
    for (const { index } of topology.faces) {
      const where = `${label} face ${index}`;
      const geometry = await query<{ uvBounds: [Vec2, Vec2] } | null>('faceGeometry', recipe, index);
      expect(geometry, where).not.toBeNull();
      const [[u0, v0], [u1, v1]] = geometry!.uvBounds;
      const uv: Vec2[] = [
        [(u0 + u1) / 2, (v0 + v1) / 2],
        [u0 + (u1 - u0) / 3, v0 + (v1 - v0) / 4],
      ];
      const evaluated = await query<{ point: Vec3; normal: Vec3 }[]>('evaluateFace', recipe, index, uv);
      expect(evaluated, where).toHaveLength(uv.length);
      for (const { normal } of evaluated) expect(len(normal), `${where} normal`).toBeCloseTo(1, 9);
      const samples = await query<SurfaceSample[]>('faceSamples', recipe, index, uv);
      samples.forEach((sample, k) => {
        expect(len(sub(sample.point, evaluated[k]!.point)), `${where} sample point`).toBeLessThan(1e-9);
        expect(sample.k1, where).toBeGreaterThanOrEqual(sample.k2 - 1e-12);
        expect(Math.abs(sample.gaussian - sample.k1 * sample.k2), `${where} K`).toBeLessThan(1e-9);
        expect(Math.abs(sample.mean - (sample.k1 + sample.k2) / 2), `${where} H`).toBeLessThan(1e-9);
      });
      expect(await query<SurfaceSample[]>('faceSamples', recipe, index, { nu: 3, nv: 2 }), where).toHaveLength(6);
      // Points inside the trimmed face (the uv centre of a face with holes or cut ends may lie off it): the samples of faceDetails.
      const inside = (await query<FaceDetail[]>('faceDetails', recipe, { samples: 3 }))[index]!.samples;
      expect(inside.length, where).toBeGreaterThan(0);
      for (const point of inside) expect(await query('faceContains', recipe, index, point), `${where} contains its sample`).toBe(true);
      const points = inside;
      const projected = await query<(FaceProjection | null)[]>('projectOnFace', recipe, index, points);
      projected.forEach((projection, k) => {
        expect(projection, where).not.toBeNull();
        expect(projection!.distance, `${where} on the face`).toBeLessThan(1e-6);
        expect(len(sub(projection!.point, points[k]!)), `${where} projection`).toBeLessThan(1e-6);
      });
    }
  });

  it('a box and a sphere answer the signed point distances at their closed form', async () => {
    const cube = FACE_QUERY_CORPUS.find(([label]) => label === 'box')![1]; // x -1..3, y -0.5..4.5, z 0..6
    const [inside, outside] = await query<{ distance: number; signed: number }[]>('distance', cube, [
      [1, 2, 3],
      [12, 2, 3],
    ]);
    expect(inside!.distance).toBeCloseTo(2, 9);
    expect(inside!.signed).toBeCloseTo(-2, 9);
    expect(outside!.distance).toBeCloseTo(9, 9);
    expect(outside!.signed).toBeCloseTo(9, 9);
    const ball = FACE_QUERY_CORPUS.find(([label]) => label === 'sphere')![1]; // radius 3 at [1, 1, 1]
    const [near, far] = await query<{ distance: number; signed: number }[]>('distance', ball, [
      [1, 1, 2],
      [11, 1, 1],
    ]);
    expect(near!.signed).toBeCloseTo(-2, 9);
    expect(far!.signed).toBeCloseTo(7, 9);
  });

  it('answers null for bad indices and the methods it does not provide', async () => {
    const recipe = leaf(box([0, 0, 0], [1, 1, 1]));
    for (const [method, args] of [
      ['faceGeometry', [6]],
      ['faceGeometry', [-1]],
      ['evaluateFace', [99, [[0, 0]]]],
      ['faceSamples', [0, { nu: 0, nv: 2 }]],
      ['faceSamples', [0, { nu: 100, nv: 100 }]],
      ['tessellateFace', [0, 0.1]],
      ['edgeSamples', [99, 8]],
      ['edgeContinuity', [99, 8]],
      ['bspline', [99]],
    ] as const)
      expect(await query(method, recipe, ...args), method).toBeNull();
    // bspline is native since 06 DEF 17.12: a box face is a bilinear patch (degree 1 x 1, 2 x 2 poles); an index out of range is the null above
    const patch = await query<{ degreeU: number; degreeV: number; poles: unknown[][] }>('bspline', recipe, 0);
    expect([patch.degreeU, patch.degreeV, patch.poles.length, patch.poles[0]?.length]).toEqual([1, 1, 2, 2]);
  });
});

describe.skipIf(nativeKernelBinary === null)('native shape distance (closed forms)', () => {
  const cube = leaf(box([0, 0, 0], [2, 2, 2])); // -1..1
  const inner = leaf(box([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])); // 0.25..0.75
  const drilledPlate = CORPUS.find(([label]) => label === 'subtract')![1]; // top face at z = 1
  const PAIRS: readonly [string, ShapeRecipe, ShapeRecipe, number, boolean][] = [
    ['apart (sphere of radius 1 centred 5 from the cube face)', cube, leaf(entity('sphere', { radius: 1 }, [6, 1, 1])), 4, false],
    ['touching gap', cube, leaf(box([2, 0, 0], [1, 1, 1])), 0.5, false],
    ['overlapping (the shapes intersect)', cube, leaf(entity('cylinder', { radius: 0.5, height: 4 }, [1, 1, 1])), 0, true],
    ['contained: gap from the inner face to the outer', cube, inner, 0.25, true],
    ['containing', inner, cube, 0.25, true],
    [
      'boolean result apart (torus 8.5 above the plate top)',
      drilledPlate,
      leaf(entity('torus', { ringRadius: 3, tubeRadius: 0.5 }, [3, 3, 9])),
      7.5,
      false,
    ],
  ];

  it.each(PAIRS)('%s', async (_label, a, b, expected, contained) => {
    const result = (await harness.call('distance', [handleOf(a), handleOf(b), 100])) as ShapeDistance;
    if (contained) expect(result.distance).toBeLessThanOrEqual(expected + TOLERANCE);
    else expect(Math.abs(result.distance - expected)).toBeLessThan(TOLERANCE);
    expect(result.inside).toBe(contained);
    // Several nearest pairs can tie (parallel faces): the reported pair must realise the distance.
    expect(Math.abs(len(sub(result.pointA, result.pointB)) - result.distance)).toBeLessThan(TOLERANCE);
  });
});
