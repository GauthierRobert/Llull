/**
 * Shared fixtures of the native `llull-kernel` vs WASM OCC parity suites (VC-KRN-25): binary discovery, one sidecar session + one WASM
 * kernel per file, the shape corpus, and a tolerant deep comparison. The suites skip with a logged reason when the binary is not built;
 * `LLULL_REQUIRE_NATIVE_KERNEL=1` (CI) makes a missing binary a failure.
 */

import { afterAll, beforeAll, expect } from 'vitest';
import type { GeometryKernel, ShapeHandle } from '@core/geometry/kernel';
import type { Entity, ShapeRecipe, Vec3 } from '@core/model/types';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { createNodeOcctKernel } from '../src/occtNode';
import { nativeBinaryPath, nativeInstallHint } from '../src/native/nativeBinary';
import { decodeMesh, nativeArgs } from '../src/native/kernelProtocol';
import { createKernelSession, spawnKernelChild, type NativeKernelSession } from '../src/native/kernelSession';
import { booleanRecipe, box, common, leaf } from './kernelTestSupport';

export const nativeKernelBinary = nativeBinaryPath('llull-kernel');
// CI's native-kernel job builds the binary first: there a missing binary is a failure, not a skip.
if (nativeKernelBinary === null && process.env['LLULL_REQUIRE_NATIVE_KERNEL'] === '1') throw new Error(nativeInstallHint('llull-kernel'));
if (nativeKernelBinary === null) console.warn(`[native parity] skipped: ${nativeInstallHint('llull-kernel')}`);

export const entity = (kind: string, fields: Record<string, unknown>, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0]): Entity =>
  ({ id: kind, kind, position, rotation, ...common, ...fields }) as Entity;

export const PRIMITIVES: readonly [string, Entity][] = [
  ['box', box([1, 2, 3], [4, 5, 6])],
  ['rotated box', entity('box', { size: [4, 5, 6] }, [-2, 4, 1], [0.3, -0.5, 1.1])],
  ['cylinder', entity('cylinder', { radius: 2, height: 5 }, [5, -3, 2])],
  ['rotated cylinder', entity('cylinder', { radius: 1.5, height: 4 }, [0, 0, 0], [Math.PI / 2, 0, 0.4])],
  ['sphere', entity('sphere', { radius: 3 }, [1, 1, 1])],
  ['cone', entity('cone', { radius: 2, height: 6 })],
  ['torus', entity('torus', { ringRadius: 5, tubeRadius: 1 }, [0, 0, 2], [0.2, 0, 0])],
  ['wedge', entity('wedge', { size: [3, 4, 5] }, [1, 0, 0])],
  [
    'extrusion',
    entity('extrusion', {
      profile: [
        [0, 0],
        [4, 0],
        [4, 1],
        [1, 1],
        [1, 3],
        [0, 3],
      ],
      depth: 2,
    }),
  ],
  [
    'revolution',
    entity('revolution', {
      profile: [
        [1, 0],
        [2, 0],
        [2, 3],
        [1, 3],
      ],
      axis: [0, 0, 1],
      angle: Math.PI * 1.5,
      segments: 32,
    }),
  ],
  ['pyramid', entity('pyramid', { baseWidth: 4, baseDepth: 3, height: 5 }, [0, 0, 1])],
];

const cylinder = entity('cylinder', { radius: 1.2, height: 8 }, [1, 1, 0]);
export const plate = box([0, 0, 0], [6, 6, 2]);
export const BOOLEANS: readonly [string, ShapeRecipe][] = [
  ['union', booleanRecipe('union', plate, cylinder)],
  ['subtract', booleanRecipe('subtract', plate, cylinder)],
  ['intersect', booleanRecipe('intersect', plate, cylinder)],
  [
    'nested, placed and scaled',
    {
      op: 'scale',
      factor: 1.5,
      source: {
        op: 'place',
        position: [10, 0, 0],
        rotation: [0, 0, 0.7],
        source: booleanRecipe(
          'subtract',
          booleanRecipe('union', plate, box([2, 0, 1], [2, 2, 4])),
          entity('sphere', { radius: 1.5 }, [-2, 0, 1]),
        ),
      },
    },
  ],
];

/** Every primitive leaf and boolean recipe of the corpus, labelled. */
export const CORPUS: readonly [string, ShapeRecipe][] = [
  ...PRIMITIVES.map(([label, solid]): [string, ShapeRecipe] => [label, leaf(solid)]),
  ...BOOLEANS,
];

export const relative = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

export interface ParityHarness {
  readonly session: () => NativeKernelSession;
  readonly wasm: () => GeometryKernel;
  /** Native reply of `op` (KernelOps argument list, handles as `{ key, recipe }`); fails the test on an error reply. */
  native(op: string, args: readonly unknown[]): Promise<unknown>;
  wasmHandle(recipe: ShapeRecipe): ShapeHandle;
}

export const handleOf = (recipe: ShapeRecipe): { key: string; recipe: ShapeRecipe } => ({ key: recipeKey(recipe), recipe });

/** One sidecar and one WASM kernel for the calling file (call at module level, inside the skipped describe's file). */
export function parityHarness(): ParityHarness {
  let session: NativeKernelSession | null = null;
  let wasm: GeometryKernel | null = null;
  beforeAll(async () => {
    if (nativeKernelBinary === null) return;
    session = createKernelSession(spawnKernelChild(nativeKernelBinary));
    wasm = await createNodeOcctKernel();
  }, 120_000);
  afterAll(() => session?.close());
  return {
    session: () => session!,
    wasm: () => wasm!,
    native: async (op, args) => {
      const reply = await session!.request(op, nativeArgs(op, args));
      expect(reply.error, `${op} error`).toBeUndefined();
      return op === 'tessellate' ? decodeMesh(reply.result) : reply.result;
    },
    wasmHandle: (recipe) => {
      const handle = wasm!.evaluate(recipe);
      expect(handle).not.toBeNull();
      return handle!;
    },
  };
}

/**
 * Deep comparison with a numeric tolerance: same keys, same array lengths, equal strings / booleans / null, numbers within `tolerance`
 * (absolute, scaled by max(1, |expected|)). Reports the path of the first difference.
 */
export function expectClose(actual: unknown, expected: unknown, tolerance: number, path = '$'): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const scale = Math.max(1, Math.abs(expected));
    if (!(Math.abs(actual - expected) <= tolerance * scale)) expect.fail(`${path}: ${actual} vs ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) expect.fail(`${path}: not an array (${JSON.stringify(actual)?.slice(0, 80)})`);
    if (actual.length !== expected.length) expect.fail(`${path}: length ${actual.length} vs ${expected.length}`);
    expected.forEach((item, index) => expectClose(actual[index], item, tolerance, `${path}[${index}]`));
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) expect.fail(`${path}: ${JSON.stringify(actual)} vs an object`);
    const keys = (value: object): string[] =>
      Object.keys(value)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort();
    expect(keys(actual), `${path} keys`).toEqual(keys(expected));
    for (const key of keys(expected))
      expectClose((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], tolerance, `${path}.${key}`);
    return;
  }
  if (actual !== expected) expect.fail(`${path}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
}
