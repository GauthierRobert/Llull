/**
 * Native `llull-kernel` (OCCT 7.9.2), first slice (VC-KRN-25, 01 KRN TR-KRN-05): primitives, booleans, transforms, exact mass properties,
 * analysis, tessellation sanity and STEP, against the closed-form volume and area of each corpus shape (nativeKernelCorpus.ts), plus the
 * proxy end to end. Query ops: nativeKernelQueries.test.ts; exchange ops: nativeKernelExchange.test.ts. Runs when the binary is built
 * (`cargo build --release -p llull-kernel` in solver/, or LLULL_KERNEL_BIN / LLULL_NATIVE_DIR); otherwise skipped with the reason logged.
 */

import { describe, expect, it } from 'vitest';
import type { ExactMassProperties, ImportedShapes } from '@core/geometry/kernelPorts';
import type { MeshData, ShapeRecipe } from '@core/model/types';
import { isClosedMesh } from '@core/geometry/meshClosure';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { sha256Hex } from '@lib/sha256';
import { createNativeKernel } from '../src/nativeKernel';
import { booleanRecipe, box, leaf, nativeKernelBinary, volume } from './kernelTestSupport';
import { BOOLEANS, CLOSED_FORM, CORPUS, entity, PRIMITIVES, plate, relative } from './nativeKernelCorpus';
import { nativeReferenceHarness } from './nativeReferenceSupport';

const harness = nativeReferenceHarness();
const mass = (recipe: ShapeRecipe): Promise<ExactMassProperties> => harness.on('massProperties', recipe) as Promise<ExactMassProperties>;
/** The exact shape with its scale / placement peeled off: the nested recipe's unscaled core. */
const nested = BOOLEANS[3]![1] as Extract<ShapeRecipe, { op: 'scale' }>;
const core = (nested.source as Extract<ShapeRecipe, { op: 'place' }>).source;

describe.skipIf(nativeKernelBinary === null)('native llull-kernel: closed-form exact properties (VC-KRN-25 slice)', () => {
  it.each([...PRIMITIVES.map(([label, solid]): [string, ShapeRecipe] => [label, leaf(solid)]), ...BOOLEANS.slice(0, 3)])(
    '%s: exact volume and area at the closed form',
    async (label, recipe) => {
      expect(await harness.call('evaluate', [recipe])).toEqual({ key: recipeKey(recipe) });
      const [expectedVolume, expectedArea] = CLOSED_FORM[label]!;
      const exact = await mass(recipe);
      expect(relative(exact.volume, expectedVolume), `${label} volume`).toBeLessThan(1e-6);
      expect(relative(exact.area, expectedArea), `${label} area`).toBeLessThan(1e-6);
    },
  );

  it.each(PRIMITIVES.filter(([label]) => ['box', 'rotated box', 'cylinder', 'rotated cylinder', 'sphere', 'torus'].includes(label)))(
    '%s: centroid at its position (centred solids, rotated about the centre)',
    async (label, solid) => {
      const { centroid } = await mass(leaf(solid));
      solid.position.forEach((value, k) => expect(Math.abs(centroid[k]! - value), label).toBeLessThan(1e-6));
    },
  );

  it('the nested, placed and scaled recipe obeys the scale laws (volume x 1.5^3, area x 1.5^2) and inclusion-exclusion', async () => {
    const [inner, scaled] = [await mass(core), await mass(nested)];
    expect(relative(scaled.volume, inner.volume * 1.5 ** 3)).toBeLessThan(1e-9);
    expect(relative(scaled.area, inner.area * 1.5 ** 2)).toBeLessThan(1e-9);
    const parts = core as Extract<ShapeRecipe, { op: 'boolean' }>;
    const union = parts.a as Extract<ShapeRecipe, { op: 'boolean' }>;
    const [a, b, joined, common] = [
      await mass(union.a),
      await mass(union.b),
      await mass(union),
      await mass({ ...union, boolean: 'intersect' } as ShapeRecipe),
    ];
    expect(relative(joined.volume + common.volume, a.volume + b.volume)).toBeLessThan(1e-9);
  });

  it.each(CORPUS)('%s: closed display mesh whose volume matches the exact one', async (label, recipe) => {
    const mesh = (await harness.on('tessellate', recipe)) as MeshData;
    expect(isClosedMesh(mesh), label).toBe(true);
    const exact = (await mass(recipe)).volume;
    expect(relative(volume(mesh), exact), label).toBeLessThan(0.06); // display deflection 0.1 / 0.5 rad: a sphere meshes ~5 % small
  });

  it('analyze reports validity, closure and one lump per solid', async () => {
    const twoLumps = booleanRecipe('union', box([0, 0, 0], [1, 1, 1]), box([5, 0, 0], [1, 1, 1]));
    const drilled = (await harness.on('analyze', BOOLEANS[1]![1])) as { valid: boolean; closed: boolean; lumps: unknown[]; volume: number };
    expect(drilled).toMatchObject({ valid: true, closed: true });
    expect(drilled.lumps).toHaveLength(1);
    expect(relative(drilled.volume, CLOSED_FORM['subtract']![0])).toBeLessThan(1e-6);
    const split = (await harness.on('analyze', twoLumps)) as { valid: boolean; lumps: unknown[]; volume: number };
    expect(split.valid).toBe(true);
    expect(split.lumps).toHaveLength(2);
    expect(split.volume).toBeCloseTo(2, 9);
  });

  it('writes STEP with one solid per shape', async () => {
    const recipes = [leaf(plate), BOOLEANS[1]![1]];
    const text = await harness.call('exportStep', [recipes.map((recipe) => ({ key: recipeKey(recipe), recipe }))]);
    expect(String(text).startsWith('ISO-10303-21;')).toBe(true);
    expect(String(text).match(/MANIFOLD_SOLID_BREP\(/g)).toHaveLength(2);
  });

  it('refuses a sphere with a negative radius', async () => {
    expect(await harness.call('evaluate', [leaf(entity('sphere', { radius: -1 }))])).toBeNull();
  });
});

describe.skipIf(nativeKernelBinary === null)('native llull-kernel behind the synchronous proxy', () => {
  it('serves commands end to end: native evaluate / tessellate / mass / topology / fillet', () => {
    const kernel = createNativeKernel(nativeKernelBinary!, { testHooks: true });
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
    const kernel = createNativeKernel(nativeKernelBinary!, { testHooks: true });
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
