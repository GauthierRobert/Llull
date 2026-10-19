/**
 * Native `llull-kernel` (OCCT 7.9.2) vs the WASM OCC kernel (OCCT 7.4) on the exchange ops (VC-KRN-25 slice 2): STEP assemblies,
 * STEP import + healing (the committed 07-pack files: three llull parts and NIST CTC-01) and B-rep blobs, both ways (a native blob read
 * by the WASM kernel and the reverse). Tolerances: VC-KRN-04 (volume 1e-4, area 1e-3 relative). Skipped without the binary.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepOccurrence } from '@core/geometry/kernel';
import type { ExactMassProperties, ImportedShapes, ImportShapesOptions, ImportShapesResult } from '@core/geometry/kernelPorts';
import type { ShapeRecipe } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { box, leaf } from './kernelTestSupport';
import { BOOLEANS, entity, handleOf, nativeKernelBinary, parityHarness, relative } from './nativeParitySupport';

const harness = parityHarness();
const PACK = path.resolve(__dirname, '../../docs/aerospace/07-sheet-metal-machined-features/validation/data');
const OPTIONS: ImportShapesOptions = { precision: 0.01, maxTolerance: 1, heal: true, sew: true };
const count = (text: unknown, entity: string): number =>
  typeof text === 'string' ? (text.match(new RegExp(`[=\\s]${entity}\\(`, 'g'))?.length ?? 0) : -1;

/** Exact volume and area of a blob's solid on each kernel (each reads the text into its own B-rep). */
async function blobMass(brep: string): Promise<{ native: ExactMassProperties; wasm: ExactMassProperties }> {
  const sha256 = sha256Hex(brep);
  const recipe: ShapeRecipe = { op: 'brep', blob: sha256, format: 'occt-brep-v1' };
  await harness.native('loadBlob', [sha256, brep]);
  harness.wasm().loadBlob!(sha256, brep);
  const native = (await harness.native('massProperties', [handleOf(recipe)])) as ExactMassProperties;
  const wasm = harness.wasm().massProperties!(harness.wasmHandle(recipe))!;
  return { native, wasm };
}

function expectSameMass({ native, wasm }: { native: ExactMassProperties; wasm: ExactMassProperties }, label: string): void {
  expect(native, label).not.toBeNull();
  expect(relative(native.volume, wasm.volume), `${label} volume`).toBeLessThan(1e-4);
  expect(relative(native.area, wasm.area), `${label} area`).toBeLessThan(1e-3);
}

describe.skipIf(nativeKernelBinary === null)('native vs WASM STEP assembly export', () => {
  it('writes the same product structure: shared parts once, one occurrence per use, nested parts composed', async () => {
    const bolt = { shapes: [leaf(entity('cylinder', { radius: 0.5, height: 4 }))] };
    const bracket = {
      shapes: [BOOLEANS[1]![1]],
      children: [
        { part: bolt, position: [1, 1, 0], rotation: [0, 0, 0] },
        { part: bolt, position: [5, 5, 0], rotation: [0, 0, 0] },
      ],
    };
    const occurrences = [
      { part: bracket, position: [0, 0, 0], rotation: [0, 0, 0] },
      { part: bracket, position: [20, 0, 0], rotation: [0, 0, Math.PI / 2] },
      { part: bolt, position: [-5, 0, 0], rotation: [Math.PI / 2, 0, 0] },
    ] as const;
    const asHandles = (map: (recipe: ShapeRecipe) => unknown): StepOccurrence<unknown>[] => {
      const parts = new Map<object, unknown>();
      const part = (source: { shapes: readonly ShapeRecipe[]; children?: readonly { part: object }[] }): unknown => {
        if (!parts.has(source)) {
          const children = source.children?.map((child) => ({ ...child, part: part(child.part as typeof bolt) }));
          parts.set(source, { shapes: source.shapes.map(map), ...(children === undefined ? {} : { children }) });
        }
        return parts.get(source);
      };
      return occurrences.map((occurrence) => ({ ...occurrence, part: part(occurrence.part) })) as StepOccurrence<unknown>[];
    };
    const fromNative = await harness.native('exportStepAssembly', [asHandles(handleOf)]);
    const fromWasm = harness.wasm().exportStepAssembly!(asHandles((recipe) => harness.wasmHandle(recipe)) as never);
    expect(String(fromNative).startsWith('ISO-10303-21;')).toBe(true);
    for (const name of ['MANIFOLD_SOLID_BREP', 'NEXT_ASSEMBLY_USAGE_OCCURRENCE', 'PRODUCT', 'ITEM_DEFINED_TRANSFORMATION'])
      expect(count(fromNative, name), name).toBe(count(fromWasm, name));
    expect(count(fromNative, 'MANIFOLD_SOLID_BREP')).toBe(2); // the bracket and the bolt, each written once

    const reread = await harness.native('importShapes', ['step', fromNative, OPTIONS]);
    const rereadByWasm = harness.wasm().importShapes!('step', String(fromNative), OPTIONS) as ImportedShapes;
    expect((reread as ImportedShapes).solids).toHaveLength(rereadByWasm.solids.length);
    expect(rereadByWasm.solids).toHaveLength(2 * 3 + 1); // every occurrence is a placed solid on import
  });
});

const FILES = ['ftr_bracket_L.step', 'ftr_joggle_strip.step', 'ftr_machined_plate.step', 'nist_ctc_01_asme1_ap242.stp'];

describe.skipIf(nativeKernelBinary === null)('native vs WASM STEP import + healing', () => {
  it.each(FILES)(
    '%s: same census, solids, faces, health flags and exact volumes',
    async (file) => {
      const text = readFileSync(path.join(PACK, file), 'utf8');
      const fromNative = (await harness.native('importShapes', ['step', text, OPTIONS])) as ImportShapesResult;
      const fromWasm = harness.wasm().importShapes!('step', text, OPTIONS)!;
      expect('solids' in fromWasm, file).toBe(true);
      const [native, wasm] = [fromNative as ImportedShapes, fromWasm as ImportedShapes];
      expect(native.census).toEqual(wasm.census);
      expect(native.skipped).toEqual(wasm.skipped);
      expect(native.solids).toHaveLength(wasm.solids.length);
      for (const [index, solid] of native.solids.entries()) {
        const reference = wasm.solids[index]!;
        const label = `${file} solid ${index}`;
        const flags = ({ validAsRead, validAfterHeal, faces, faceted, freeEdges }: typeof solid): unknown[] => [
          validAsRead,
          validAfterHeal,
          faces,
          faceted,
          freeEdges,
        ];
        expect(flags(solid), label).toEqual(flags(reference));
        expect(solid.maxToleranceMm, label).toBeLessThanOrEqual(Math.max(reference.maxToleranceMm * 10, OPTIONS.precision));
        expect(solid.brep.startsWith('\nCASCADE Topology V1') || solid.brep.startsWith('CASCADE Topology V1'), label).toBe(true);
        expectSameMass(await blobMass(solid.brep), `${label} (native blob)`);
        const ofWasmBlob = await blobMass(reference.brep);
        expect(relative(ofWasmBlob.native.volume, (await blobMass(solid.brep)).wasm.volume), `${label} cross`).toBeLessThan(1e-4);
      }
    },
    120_000,
  );

  it('refuses what the WASM kernel refuses, with the same error codes', async () => {
    const tessellated = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=TESSELLATED_SHAPE_REPRESENTATION($,$,$);\nENDSEC;\nEND-ISO-10303-21;\n';
    // A well-formed AP242 tessellated solid: OCCT 7.9 transfers it (a face with a triangulation and no surface), 7.4 does not.
    const tetrahedron = readFileSync(path.join(__dirname, 'fixtures', 'tessellated-tetrahedron.stp'), 'utf8');
    for (const text of ['not a step file', tessellated, tetrahedron]) {
      const native = (await harness.native('importShapes', ['step', text, OPTIONS])) as { error: string };
      const wasm = harness.wasm().importShapes!('step', text, OPTIONS) as { error: string };
      expect(native.error).toBe(wasm.error);
    }
    expect(await harness.native('importShapes', ['iges', 'x', OPTIONS])).toBeNull();
  });

  it('round-trips its own exports of primitives and booleans', async () => {
    const recipes = [leaf(box([0, 0, 0], [100, 50, 20])), leaf(entity('torus', { ringRadius: 5, tubeRadius: 1 })), BOOLEANS[3]![1]];
    const text = String(await harness.native('exportStep', [recipes.map(handleOf)]));
    const native = (await harness.native('importShapes', ['step', text, OPTIONS])) as ImportedShapes;
    const wasm = harness.wasm().importShapes!('step', text, OPTIONS) as ImportedShapes;
    expect(native.census).toEqual(wasm.census);
    for (const [index, solid] of native.solids.entries()) {
      const exact = (await harness.native('massProperties', [handleOf(recipes[index]!)])) as ExactMassProperties;
      const { native: fromBlob } = await blobMass(solid.brep);
      expect(relative(fromBlob.volume, exact.volume), `solid ${index}`).toBeLessThan(1e-6);
      expect(solid.faces).toBe(wasm.solids[index]!.faces);
    }
  });
});

describe.skipIf(nativeKernelBinary === null)('native B-rep blobs', () => {
  it('evaluates WASM-written brep leaves (also under booleans) once the blob is loaded, refusing a mismatched hash', async () => {
    // A blob no other test loaded: the WASM kernel's healed import of its own export of a one-off solid.
    const solid = harness.wasmHandle(leaf(entity('cylinder', { radius: 7.25, height: 3.5 }, [1, 2, 3])));
    const brep = (harness.wasm().importShapes!('step', harness.wasm().exportStep([solid])!, OPTIONS) as ImportedShapes).solids[0]!.brep;
    const sha256 = sha256Hex(brep);
    const leafRecipe: ShapeRecipe = { op: 'brep', blob: sha256, format: 'occt-brep-v1' };
    const drilled: ShapeRecipe = { op: 'boolean', boolean: 'subtract', a: leafRecipe, b: leaf(entity('sphere', { radius: 3 })) };
    const session = harness.session();
    expect((await session.request('evaluate', [{ key: 'unloaded', recipe: leafRecipe }])).result).toBeNull();
    await session.request('loadBlob', [sha256Hex('something else'), brep]);
    expect((await session.request('evaluate', [{ key: 'still-unloaded', recipe: leafRecipe }])).result).toBeNull();
    await harness.native('loadBlob', [sha256, brep]);
    const forgotten = await session.request('massProperties', [{ key: 'unloaded' }]);
    expect(forgotten.error, 'a key refused before the load is forgotten: the host resends its recipe').toBe('shape not cached: unloaded');
    const rebuilt = (await harness.native('massProperties', [handleOf(leafRecipe)])) as ExactMassProperties;
    harness.wasm().loadBlob!(sha256, brep);
    expect(relative(rebuilt.volume, harness.wasm().massProperties!(harness.wasmHandle(leafRecipe))!.volume)).toBeLessThan(1e-6);
    const cut = (await harness.native('massProperties', [handleOf(drilled)])) as ExactMassProperties;
    expect(relative(cut.volume, harness.wasm().massProperties!(harness.wasmHandle(drilled))!.volume)).toBeLessThan(1e-6);
  });
});
