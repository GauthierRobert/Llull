/**
 * Native `llull-kernel` (OCCT 7.8.1) vs the WASM OCC kernel (opencascade.js, OCCT 7.4) on the ops the sidecar implements — the first
 * slice of VC-KRN-25 (01 KRN TR-KRN-05): primitives, booleans, transforms, exact mass properties, analysis, tessellation sanity and
 * STEP. Runs when the binary is built (`cargo build --release -p llull-kernel` in solver/, or LLULL_KERNEL_BIN / LLULL_NATIVE_DIR);
 * otherwise skipped with the reason logged.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExactMassProperties } from '@core/geometry/kernelPorts';
import type { Entity, MeshData, ShapeRecipe, Vec3 } from '@core/model/types';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { isClosedMesh } from '@kernel-occt/meshClosure';
import { createNodeOcctKernel } from '../src/occtNode';
import { createNativeKernel } from '../src/nativeKernel';
import { nativeBinaryPath, nativeInstallHint } from '../src/native/nativeBinary';
import { decodeMesh, nativeArgs } from '../src/native/kernelProtocol';
import { createKernelSession, spawnKernelChild, type NativeKernelSession } from '../src/native/kernelSession';
import { booleanRecipe, box, common, leaf, volume } from './kernelTestSupport';

const binary = nativeBinaryPath('llull-kernel');
// CI's native-kernel job builds the binary first: there a missing binary is a failure, not a skip.
if (binary === null && process.env['LLULL_REQUIRE_NATIVE_KERNEL'] === '1') throw new Error(nativeInstallHint('llull-kernel'));
if (binary === null) console.warn(`[native parity] skipped: ${nativeInstallHint('llull-kernel')}`);

const entity = (kind: string, fields: Record<string, unknown>, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0]): Entity =>
  ({ id: kind, kind, position, rotation, ...common, ...fields }) as Entity;

const PRIMITIVES: readonly [string, Entity][] = [
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
const plate = box([0, 0, 0], [6, 6, 2]);
const BOOLEANS: readonly [string, ShapeRecipe][] = [
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

const relative = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe.skipIf(binary === null)('native llull-kernel vs WASM OCC parity (VC-KRN-25 slice)', () => {
  let session: NativeKernelSession;
  let wasm: GeometryKernel;

  beforeAll(async () => {
    session = createKernelSession(spawnKernelChild(binary!));
    wasm = await createNodeOcctKernel();
  }, 120_000);
  afterAll(() => session.close());

  const native = async (op: string, recipe: ShapeRecipe): Promise<unknown> => {
    const handle = op === 'evaluate' ? null : { key: recipeKey(recipe), recipe };
    const reply = await session.request(op, nativeArgs(op, op === 'evaluate' ? [recipe] : [handle]));
    expect(reply.error).toBeUndefined();
    return op === 'tessellate' ? decodeMesh(reply.result) : reply.result;
  };
  const wasmMass = (recipe: ShapeRecipe): ExactMassProperties | null => {
    const handle = wasm.evaluate(recipe);
    return handle === null ? null : (wasm.massProperties?.(handle) ?? null);
  };

  const expectMassParity = (fromNative: ExactMassProperties, fromWasm: ExactMassProperties, label: string): void => {
    expect(relative(fromNative.volume, fromWasm.volume), `${label} volume`).toBeLessThan(1e-6);
    expect(relative(fromNative.area, fromWasm.area), `${label} area`).toBeLessThan(1e-6);
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(fromNative.centroid[k]! - fromWasm.centroid[k]!), `${label} centroid`).toBeLessThan(1e-6);
      expect(Math.abs(fromNative.bounds.min[k]! - fromWasm.bounds.min[k]!), `${label} bounds`).toBeLessThan(1e-3);
      expect(Math.abs(fromNative.bounds.max[k]! - fromWasm.bounds.max[k]!), `${label} bounds`).toBeLessThan(1e-3);
    }
    fromNative.inertiaAtCentroid.forEach((value, index) => {
      const scale = Math.max(...fromWasm.inertiaAtCentroid.map(Math.abs));
      expect(Math.abs(value - fromWasm.inertiaAtCentroid[index]!) / scale, `${label} inertia`).toBeLessThan(1e-6);
    });
  };

  it.each(PRIMITIVES)('%s: same exact mass properties', async (label, solid) => {
    const recipe = leaf(solid);
    expect(await native('evaluate', recipe)).toEqual({ key: recipeKey(recipe) });
    const fromWasm = wasmMass(recipe);
    expect(fromWasm, label).not.toBeNull();
    expectMassParity((await native('massProperties', recipe)) as ExactMassProperties, fromWasm!, label);
  });

  it.each(BOOLEANS)('%s: same exact mass properties', async (label, recipe) => {
    const fromWasm = wasmMass(recipe);
    expect(fromWasm, label).not.toBeNull();
    expectMassParity((await native('massProperties', recipe)) as ExactMassProperties, fromWasm!, label);
  });

  it.each([...PRIMITIVES.map(([label, solid]): [string, ShapeRecipe] => [label, leaf(solid)]), ...BOOLEANS])(
    '%s: closed display mesh whose volume matches the exact one',
    async (label, recipe) => {
      const mesh = (await native('tessellate', recipe)) as MeshData;
      expect(isClosedMesh(mesh), label).toBe(true);
      const exact = ((await native('massProperties', recipe)) as ExactMassProperties).volume;
      expect(relative(volume(mesh), exact), label).toBeLessThan(0.06); // display deflection 0.1 / 0.5 rad: a sphere meshes ~5 % small
      const handle = wasm.evaluate(recipe);
      const fromWasm = handle === null ? null : wasm.tessellate(handle);
      expect(relative(volume(mesh), volume(fromWasm!)), `${label} vs WASM mesh`).toBeLessThan(0.03);
    },
  );

  it('analyze agrees on validity, closure and lumps', async () => {
    const twoLumps = booleanRecipe('union', box([0, 0, 0], [1, 1, 1]), box([5, 0, 0], [1, 1, 1]));
    for (const recipe of [twoLumps, BOOLEANS[1]![1]]) {
      const fromNative = (await native('analyze', recipe)) as { valid: boolean; closed: boolean; lumps: unknown[]; volume: number };
      const fromWasm = wasm.analyze?.(wasm.evaluate(recipe)!);
      expect(fromNative).toMatchObject({ valid: fromWasm?.valid, closed: fromWasm?.closed });
      expect(fromNative.lumps).toHaveLength(fromWasm!.lumps.length);
      expect(relative(fromNative.volume, fromWasm!.volume)).toBeLessThan(1e-6);
    }
  });

  it('writes STEP with one solid per shape, like the WASM kernel', async () => {
    const recipes = [leaf(plate), BOOLEANS[1]![1]];
    const reply = await session.request(
      'exportStep',
      nativeArgs('exportStep', [recipes.map((recipe) => ({ key: recipeKey(recipe), recipe }))]),
    );
    const fromWasm = wasm.exportStep(recipes.map((recipe) => wasm.evaluate(recipe)!));
    const solids = (text: unknown): number => (typeof text === 'string' ? (text.match(/MANIFOLD_SOLID_BREP\(/g)?.length ?? 0) : -1);
    expect(String(reply.result).startsWith('ISO-10303-21;')).toBe(true);
    expect(solids(reply.result)).toBe(solids(fromWasm));
  });

  it('refuses what the WASM kernel refuses', async () => {
    const recipe = leaf(entity('sphere', { radius: -1 }));
    expect(await native('evaluate', recipe)).toBeNull();
    expect(wasm.evaluate(recipe)).toBeNull();
  });
});

describe.skipIf(binary === null)('native llull-kernel behind the synchronous proxy', () => {
  it('serves commands end to end: native evaluate / tessellate / mass, WASM for fillet and topology', () => {
    const kernel = createNativeKernel(binary!, { testHooks: true });
    try {
      expect(kernel.start()).toBe(true);
      const drilled = kernel.evaluate(BOOLEANS[1]![1]);
      expect(kernel.massProperties?.(drilled!)?.volume).toBeCloseTo(6 * 6 * 2 - Math.PI * 1.2 * 1.2 * 2, 6);
      expect(isClosedMesh(kernel.tessellate(drilled!))).toBe(true);
      const rounded = kernel.evaluate({ op: 'fillet', source: leaf(plate), edges: [0], size: 0.3 });
      expect(kernel.topology(rounded!)?.faces).toHaveLength(7);
      expect(kernel.info?.()).toMatchObject({ occtVersion: '7.8.1', build: expect.stringContaining('llull-kernel@') });
      kernel.forceFailure('__abort');
      expect(kernel.massProperties?.(drilled!)?.volume).toBeGreaterThan(0);
    } finally {
      kernel.dispose();
    }
  }, 120_000);
});
