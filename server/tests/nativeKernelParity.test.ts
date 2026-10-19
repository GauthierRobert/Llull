/**
 * Native `llull-kernel` (OCCT 7.9.2) vs the WASM OCC kernel (opencascade.js, OCCT 7.4) — the first slice of VC-KRN-25 (01 KRN
 * TR-KRN-05): primitives, booleans, transforms, exact mass properties, analysis, tessellation sanity and STEP, plus the proxy end to end.
 * Query ops: nativeKernelQueryParity.test.ts; exchange ops: nativeKernelExchangeParity.test.ts. Runs when the binary is built
 * (`cargo build --release -p llull-kernel` in solver/, or LLULL_KERNEL_BIN / LLULL_NATIVE_DIR); otherwise skipped with the reason logged.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExactMassProperties, ImportedShapes } from '@core/geometry/kernelPorts';
import type { MeshData, ShapeRecipe } from '@core/model/types';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { sha256Hex } from '@lib/sha256';
import { isClosedMesh } from '@kernel-occt/meshClosure';
import { createNodeOcctKernel } from '../src/occtNode';
import { createNativeKernel } from '../src/nativeKernel';
import { decodeMesh, nativeArgs } from '../src/native/kernelProtocol';
import { createKernelSession, spawnKernelChild, type NativeKernelSession } from '../src/native/kernelSession';
import { booleanRecipe, box, leaf, volume } from './kernelTestSupport';
import { BOOLEANS, entity, nativeKernelBinary, plate, PRIMITIVES, relative } from './nativeParitySupport';

const binary = nativeKernelBinary;

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
  it('serves commands end to end: native evaluate / tessellate / mass / topology / fillet', () => {
    const kernel = createNativeKernel(binary!, { testHooks: true });
    try {
      expect(kernel.start()).toBe(true);
      const drilled = kernel.evaluate(BOOLEANS[1]![1]);
      expect(kernel.massProperties?.(drilled!)?.volume).toBeCloseTo(6 * 6 * 2 - Math.PI * 1.2 * 1.2 * 2, 6);
      expect(isClosedMesh(kernel.tessellate(drilled!))).toBe(true);
      expect(kernel.topology(drilled!)?.faces.map((face) => face.surface)).toEqual([
        'plane',
        'plane',
        'plane',
        'plane',
        'plane',
        'plane',
        'cylinder',
      ]);
      expect(kernel.faceQuery?.faceDetails(drilled!, { samples: 2 })?.[6]).toMatchObject({ surface: 'cylinder', radius: 1.2 });
      const rounded = kernel.evaluate({ op: 'fillet', source: leaf(plate), edges: [0], size: 0.3 });
      expect(kernel.topology(rounded!)?.faces).toHaveLength(7);
      expect(kernel.info?.()).toMatchObject({ occtVersion: '7.9.2', build: expect.stringContaining('llull-kernel@') });
      expect(kernel.info?.().capabilities).toEqual(expect.arrayContaining(['topology', 'faceQuery', 'importShapes', 'brepBlobs']));
      kernel.forceFailure('__abort');
      expect(kernel.massProperties?.(drilled!)?.volume).toBeGreaterThan(0);
    } finally {
      kernel.dispose();
    }
  }, 120_000);

  it('imports STEP natively and evaluates the blob after a worker restart (blob resend)', () => {
    const kernel = createNativeKernel(binary!, { testHooks: true });
    try {
      expect(kernel.start()).toBe(true);
      const step = kernel.exportStep([kernel.evaluate(leaf(entity('cylinder', { radius: 3, height: 7 })))!])!;
      const imported = kernel.importShapes?.('step', step, { precision: 0.01, maxTolerance: 1, heal: true, sew: true }) as ImportedShapes;
      const { brep } = imported.solids[0]!;
      kernel.loadBlob?.(sha256Hex(brep), brep);
      const recipe: ShapeRecipe = { op: 'brep', blob: sha256Hex(brep), format: 'occt-brep-v1' };
      expect(kernel.massProperties?.(kernel.evaluate(recipe)!)?.volume).toBeCloseTo(Math.PI * 9 * 7, 6);
      kernel.forceFailure('__abort'); // the worker and its sidecar restart: the host resends every blob
      expect(kernel.massProperties?.(kernel.evaluate(booleanRecipe('subtract', recipe, box([0, 0, 0], [1, 1, 20])))!)?.volume).toBeCloseTo(
        Math.PI * 9 * 7 - 7,
        6,
      );
    } finally {
      kernel.dispose();
    }
  }, 120_000);
});
