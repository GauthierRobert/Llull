/**
 * Native `llull-kernel` (OCCT 7.8.1) vs the WASM OCC kernel (opencascade.js, OCCT 7.4) on the query ops (VC-KRN-25 slice 2): exact
 * topology with the SAME face / edge numbering (fillet and chamfer select edges by these indices), every face-query method and shape
 * distance. Corpus: the 11 primitives and 4 boolean recipes of the first slice. Skipped without the binary (nativeParitySupport.ts).
 */

import { describe, expect, it } from 'vitest';
import type { ShapeDistance, ShapeTopology } from '@core/geometry/kernel';
import type { FaceQueryPort } from '@core/geometry/kernelPorts';
import type { ShapeRecipe, Vec3 } from '@core/model/types';
import { box, leaf } from './kernelTestSupport';
import { CORPUS, entity, expectClose, handleOf, nativeKernelBinary, parityHarness, relative } from './nativeParitySupport';

const harness = parityHarness();

/** Lengths, areas and points: both kernels integrate and evaluate the same B-rep; 1e-6 relative absorbs the 7.4 / 7.8 integrators. */
const TOLERANCE = 1e-6;

const port = (): FaceQueryPort => harness.wasm().faceQuery!;

async function both<T>(method: keyof FaceQueryPort, recipe: ShapeRecipe, ...args: unknown[]): Promise<[unknown, T]> {
  const native = await harness.native(`faceQuery.${method}`, [handleOf(recipe), ...args]);
  const call = port()[method] as (...callArgs: unknown[]) => T;
  return [native, call.apply(port(), [harness.wasmHandle(recipe), ...args])];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * At an umbilic point (sphere, plane: k1 = k2) every tangent direction is principal and OCC returns an arbitrary pair, which differs
 * between 7.4 and 7.8 when round-off decides `IsUmbilic`: check the pair is an orthonormal tangent frame, then drop it from the comparison.
 */
function withoutUmbilicDirections(samples: unknown): unknown {
  if (!Array.isArray(samples)) return samples;
  return samples.map((sample: { k1?: number; k2?: number; dir1?: Vec3; dir2?: Vec3; normal?: Vec3 }) => {
    if (sample.k1 === undefined || sample.k2 === undefined || Math.abs(sample.k1 - sample.k2) > 1e-9 * Math.max(1, Math.abs(sample.k1)))
      return sample;
    const { dir1, dir2, normal } = sample as { dir1: Vec3; dir2: Vec3; normal: Vec3 };
    if (dot(normal, normal) > 0) {
      for (const [a, b] of [
        [dir1, dir2],
        [dir1, normal],
        [dir2, normal],
      ] as const)
        expect(Math.abs(dot(a, b))).toBeLessThan(1e-9);
    }
    return { ...sample, dir1: undefined, dir2: undefined };
  });
}

const FACE_QUERY_CORPUS: readonly [string, ShapeRecipe][] = CORPUS.filter(([label]) =>
  ['box', 'rotated cylinder', 'sphere', 'cone', 'torus', 'revolution', 'subtract', 'nested, placed and scaled'].includes(label),
);

describe.skipIf(nativeKernelBinary === null)('native vs WASM topology (same numbering)', () => {
  it.each(CORPUS)('%s: same faces and edges, index for index', async (label, recipe) => {
    const fromNative = (await harness.native('topology', [handleOf(recipe)])) as ShapeTopology;
    const fromWasm = harness.wasm().topology(harness.wasmHandle(recipe))!;
    expect(fromWasm, label).not.toBeNull();
    expect(relative(fromNative.volume, fromWasm.volume), `${label} volume`).toBeLessThan(TOLERANCE);
    expectClose({ ...fromNative, volume: 0 }, { ...fromWasm, volume: 0 }, TOLERANCE);
  });
});

describe.skipIf(nativeKernelBinary === null)('native vs WASM face-query port', () => {
  it.each(FACE_QUERY_CORPUS)('%s: faceDetails (default and 5 samples) and faceGraph', async (_label, recipe) => {
    for (const options of [undefined, { samples: 5 }]) {
      const [native, wasm] = await both('faceDetails', recipe, ...(options === undefined ? [] : [options]));
      expectClose(native, wasm, TOLERANCE);
    }
    const [native, wasm] = await both('faceGraph', recipe);
    expectClose(native, wasm, TOLERANCE);
  });

  it.each(FACE_QUERY_CORPUS)('%s: per-face geometry, evaluation, curvature, projection and containment', async (_label, recipe) => {
    const faces = harness.wasm().topology(harness.wasmHandle(recipe))!.faces;
    for (const { index } of faces) {
      const [geometry, wasmGeometry] = await both<{ uvBounds: [[number, number], [number, number]] } | null>('faceGeometry', recipe, index);
      expectClose(geometry, wasmGeometry, TOLERANCE);
      const [[u0, v0], [u1, v1]] = wasmGeometry!.uvBounds;
      const uv: [number, number][] = [
        [(u0 + u1) / 2, (v0 + v1) / 2],
        [u0 + (u1 - u0) / 3, v0 + (v1 - v0) / 4],
      ];
      for (const [method, args] of [
        ['evaluateFace', [uv]],
        ['faceSamples', [uv]],
        ['faceSamples', [{ nu: 3, nv: 2 }]],
      ] as const) {
        const [native, wasm] = await both(method, recipe, index, ...args);
        expectClose(withoutUmbilicDirections(native), withoutUmbilicDirections(wasm), TOLERANCE);
      }
      const probes: Vec3[] = [
        [0.5, 0.5, 9],
        [7, 3, 1],
        [-4, 1, 0.5],
      ];
      const [projected, wasmProjected] = await both('projectOnFace', recipe, index, probes);
      expectClose(projected, wasmProjected, TOLERANCE);
      const onFace = (wasmProjected as ({ point: Vec3 } | null)[]).find((entry) => entry !== null)?.point ?? probes[0]!;
      for (const [point, tolerance] of [
        [onFace, undefined],
        [probes[1]!, 0.5],
      ] as const) {
        const [contains, wasmContains] = await both('faceContains', recipe, index, point, ...(tolerance === undefined ? [] : [tolerance]));
        expect(contains).toBe(wasmContains);
      }
    }
  });

  it.each(FACE_QUERY_CORPUS)('%s: signed point distances and nearest faces', async (_label, recipe) => {
    const points: Vec3[] = [
      [0.5, 0.5, 0.5],
      [3, 3, 1],
      [12, -3, 4],
      [-6, 6, -2],
    ];
    const [native, wasm] = await both('distance', recipe, points);
    expectClose(native, wasm, TOLERANCE);
  });

  it('answers null where the WASM kernel does: bad indices and the methods its build lacks', async () => {
    const recipe = leaf(box([0, 0, 0], [1, 1, 1]));
    for (const [method, args] of [
      ['faceGeometry', [6]],
      ['faceGeometry', [-1]],
      ['evaluateFace', [99, [[0, 0]]]],
      ['faceSamples', [0, { nu: 0, nv: 2 }]],
      ['faceSamples', [0, { nu: 100, nv: 100 }]],
      ['tessellateFace', [0, 0.1]],
      ['edgeSamples', [0, 8]],
      ['edgeContinuity', [0, 8]],
      ['bspline', [0]],
    ] as const) {
      const [native, wasm] = await both(method, recipe, ...args);
      expect(wasm, method).toBeNull();
      expect(native, method).toBeNull();
    }
  });
});

describe.skipIf(nativeKernelBinary === null)('native vs WASM shape distance', () => {
  const cube = leaf(box([0, 0, 0], [2, 2, 2]));
  const PAIRS: readonly [string, ShapeRecipe, ShapeRecipe][] = [
    ['apart', cube, leaf(entity('sphere', { radius: 1 }, [6, 1, 1]))],
    ['touching', cube, leaf(box([2, 0, 0], [1, 1, 1]))],
    ['overlapping', cube, leaf(entity('cylinder', { radius: 0.5, height: 4 }, [1, 1, 1]))],
    ['contained', cube, leaf(box([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]))],
    ['containing', leaf(box([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])), cube],
    [
      'boolean result apart',
      CORPUS.find(([label]) => label === 'subtract')![1],
      leaf(entity('torus', { ringRadius: 3, tubeRadius: 0.5 }, [3, 3, 9])),
    ],
  ];

  it.each(PAIRS)('%s: same distance and containment, nearest points on both shapes', async (_label, a, b) => {
    const native = (await harness.native('distance', [handleOf(a), handleOf(b), 100])) as ShapeDistance;
    const wasm = harness.wasm().distance!(harness.wasmHandle(a), harness.wasmHandle(b), 100)!;
    expect(Math.abs(native.distance - wasm.distance)).toBeLessThan(TOLERANCE);
    expect(native.inside).toBe(wasm.inside);
    // Several nearest pairs can tie (parallel faces): check the native pair realises the distance instead of comparing points.
    const gap = Math.hypot(...native.pointA.map((value, k) => value - native.pointB[k]!));
    expect(Math.abs(gap - native.distance)).toBeLessThan(TOLERANCE);
  });
});
