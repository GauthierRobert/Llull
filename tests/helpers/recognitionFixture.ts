/**
 * Face-graph fixtures captured once from the live OCC kernel (tests/fixtures/recognition/*.json): the plate / bracket / joggle STEP files of
 * the 07 pack and authored variants. They let the pure recognition and the recognition-based commands run in the unit suite without WASM.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GeometryKernel, ShapeTopology } from '@core/geometry/kernel';
import type { FaceDetail, FaceGraph, SurfaceSample } from '@core/geometry/kernelPorts';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import type { Orientation } from '@core/geometry/recognition/model';
import type { RecognizeOptions } from '@core/geometry/recognition/types';
import type { Vec3 } from '@core/model/types';

export interface RecognitionFixture {
  readonly graph: FaceGraph;
  readonly topology: ShapeTopology;
  readonly outward: ReadonlyArray<Vec3 | null>;
  readonly cavity: ReadonlyArray<boolean | null>;
}

export type FixtureName =
  | 'machinedPlate'
  | 'bracketL'
  | 'joggleStrip'
  | 'pocketFillet'
  | 'flatAndShallow'
  | 'openPocket'
  | 'filletChamfer'
  | 'splitBlind';

export const loadFixture = (name: FixtureName): RecognitionFixture =>
  JSON.parse(readFileSync(path.resolve(__dirname, `../fixtures/recognition/${name}.json`), 'utf8')) as RecognitionFixture;

export const orientationOf = (fixture: RecognitionFixture): Orientation => ({
  outward: (face) => fixture.outward[face] ?? null,
  cavity: (face) => fixture.cavity[face] ?? null,
});

/** Options of a default recognition run over a fixture (tolerances of the command defaults). */
export const RECOGNIZE_DEFAULTS: RecognizeOptions = {
  kinds: ['hole', 'pocket', 'fillet', 'chamfer', 'bend'],
  mergeSplitFaces: true,
  angularTolerance: (1e-4 * Math.PI) / 180,
  lengthTolerance: 1e-5,
};

/** A kernel whose every shape is the fixture: topology and the face-query port answer from the captured data. */
export function fixtureKernel(fixture: RecognitionFixture): GeometryKernel {
  const nothing = (): null => null;
  const details = (): readonly FaceDetail[] =>
    fixture.graph.faces.map((face) => ({
      index: face.index,
      surface: fixture.topology.faces[face.index]?.surface ?? 'other',
      area: face.area,
      centroid: [0, 0, 0],
      ...(fixture.outward[face.index] == null ? {} : { normal: fixture.outward[face.index] as Vec3 }),
      samples: [],
    }));
  const sample = (face: number): SurfaceSample => ({
    u: 0,
    v: 0,
    point: [0, 0, 0],
    normal: [0, 0, 1],
    k1: 0,
    k2: 0,
    dir1: [1, 0, 0],
    dir2: [0, 1, 0],
    gaussian: 0,
    mean: fixture.cavity[face] === true ? -1 : 1,
    degenerate: fixture.cavity[face] === null,
  });
  return kernelFromOps<object>({
    name: 'fixture',
    solid: () => ({}),
    boolean: nothing,
    fillet: nothing,
    blend: nothing,
    chamfer: nothing,
    shell: nothing,
    place: () => ({}),
    scale: () => ({}),
    tessellate: nothing,
    topology: () => fixture.topology,
    exportStep: nothing,
    release: () => undefined,
    faceQuery: {
      faceDetails: details,
      faceContains: () => true,
      faceGraph: () => fixture.graph,
      faceGeometry: nothing,
      projectOnFace: nothing,
      evaluateFace: nothing,
      tessellateFace: nothing,
      faceSamples: (_shape, face) => [sample(face)],
      edgeSamples: nothing,
      edgeContinuity: nothing,
      distance: nothing,
      bspline: nothing,
    },
  });
}
