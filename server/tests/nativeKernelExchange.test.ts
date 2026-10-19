/**
 * Native `llull-kernel` (OCCT 7.9.2) exchange ops (VC-KRN-25 slice 2): STEP assemblies, STEP import + healing (the committed 07-pack files:
 * three llull parts with analytic volumes and NIST CTC-01) and B-rep blobs. Expectations are closed forms: the analytic volumes of
 * `expected_test_parts.json`, the ADVANCED_FACE count of each file, the product structure that was written. Tolerances: VC-KRN-04
 * (volume 1e-4, area 1e-3 relative). Skipped without the binary.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepOccurrence } from '@core/geometry/kernel';
import type { ExactMassProperties, ImportedShapes, ImportShapesOptions, ImportShapesResult } from '@core/geometry/kernelPorts';
import type { ShapeRecipe } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { box, leaf, nativeKernelBinary } from './kernelTestSupport';
import { BOOLEANS, CLOSED_FORM, entity, handleOf, relative } from './nativeKernelCorpus';
import { nativeReferenceHarness } from './nativeReferenceSupport';

const harness = nativeReferenceHarness();
const PACK = path.resolve(__dirname, '../../docs/aerospace/07-sheet-metal-machined-features/validation/data');
const OPTIONS: ImportShapesOptions = { precision: 0.01, maxTolerance: 1, heal: true, sew: true };
const count = (text: unknown, entityName: string): number =>
  typeof text === 'string' ? (text.match(new RegExp(`[=\\s]${entityName}\\(`, 'g'))?.length ?? 0) : -1;

/** Exact mass of the solid a blob holds. */
async function blobMass(brep: string): Promise<ExactMassProperties> {
  const sha256 = sha256Hex(brep);
  await harness.call('loadBlob', [sha256, brep]);
  return (await harness.on('massProperties', { op: 'brep', blob: sha256, format: 'occt-brep-v1' })) as ExactMassProperties;
}

describe.skipIf(nativeKernelBinary === null)('native STEP assembly export', () => {
  it('writes the product structure: shared parts once, one occurrence per use, nested parts composed', async () => {
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
    const parts = new Map<object, unknown>();
    const part = (source: { shapes: readonly ShapeRecipe[]; children?: readonly { part: object }[] }): unknown => {
      if (!parts.has(source)) {
        const children = source.children?.map((child) => ({ ...child, part: part(child.part as typeof bolt) }));
        parts.set(source, { shapes: source.shapes.map(handleOf), ...(children === undefined ? {} : { children }) });
      }
      return parts.get(source);
    };
    const handles = occurrences.map((occurrence) => ({ ...occurrence, part: part(occurrence.part) })) as StepOccurrence<unknown>[];
    const written = await harness.call('exportStepAssembly', [handles]);
    expect(String(written).startsWith('ISO-10303-21;')).toBe(true);
    expect(count(written, 'MANIFOLD_SOLID_BREP'), 'the bracket and the bolt, each written once').toBe(2);
    // 3 top-level uses (two brackets, one bolt), the bracket's two bolts (written once, reused by both brackets) and the bracket's own
    // solid, which sits in its own sub-product beside them.
    expect(count(written, 'NEXT_ASSEMBLY_USAGE_OCCURRENCE')).toBe(6);
    expect(count(written, 'ITEM_DEFINED_TRANSFORMATION')).toBe(6);
    const reread = (await harness.call('importShapes', ['step', written, OPTIONS])) as ImportedShapes;
    expect(reread.solids, 'every occurrence is a placed solid on import').toHaveLength(2 * 3 + 1);
  });
});

/** Analytic volume (`expected_test_parts.json`) of each llull part; the NIST file's volumes are in nativeKernelReferenceNist. */
const FILES: readonly [string, number | null][] = [
  ['ftr_bracket_L.step', 5279.716754404115],
  ['ftr_joggle_strip.step', 2184.347213509194],
  ['ftr_machined_plate.step', 55978.529152795934],
  ['nist_ctc_01_asme1_ap242.stp', null],
];

describe.skipIf(nativeKernelBinary === null)('native STEP import + healing', () => {
  it.each(FILES)(
    '%s: one health-checked solid per body, every ADVANCED_FACE, the analytic volume, a blob that rebuilds it',
    async (file, volume) => {
      const text = readFileSync(path.join(PACK, file), 'utf8');
      const imported = (await harness.call('importShapes', ['step', text, OPTIONS])) as ImportShapesResult;
      expect('solids' in imported, file).toBe(true);
      const { solids, census } = imported as ImportedShapes;
      expect(solids.length, file).toBeGreaterThan(0);
      expect(census, file).toBeDefined();
      expect(
        solids.reduce((sum, solid) => sum + solid.faces, 0),
        `${file} faces`,
      ).toBe(count(text, 'ADVANCED_FACE'));
      for (const [index, solid] of solids.entries()) {
        const label = `${file} solid ${index}`;
        expect(solid.validAfterHeal, label).toBe(true);
        expect(solid.maxToleranceMm, label).toBeLessThanOrEqual(OPTIONS.precision * 10);
        expect(solid.brep.startsWith('\nCASCADE Topology V1') || solid.brep.startsWith('CASCADE Topology V1'), label).toBe(true);
        const mass = await blobMass(solid.brep);
        expect(mass.volume, label).toBeGreaterThan(0);
        if (volume !== null) expect(relative(mass.volume, volume), `${label} analytic volume`).toBeLessThan(1e-6);
      }
    },
    120_000,
  );

  it('refuses text that holds no B-rep, with its error code', async () => {
    const tessellated = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=TESSELLATED_SHAPE_REPRESENTATION($,$,$);\nENDSEC;\nEND-ISO-10303-21;\n';
    for (const text of ['not a step file', tessellated]) {
      const refused = (await harness.call('importShapes', ['step', text, OPTIONS])) as { error: string };
      expect(typeof refused.error, text).toBe('string');
      expect(refused.error.length, text).toBeGreaterThan(0);
    }
    // A well-formed AP242 tessellated solid: OCCT 7.9 transfers it (a face with a triangulation and no surface).
    const tetrahedron = readFileSync(path.join(__dirname, 'fixtures', 'tessellated-tetrahedron.stp'), 'utf8');
    expect(((await harness.call('importShapes', ['step', tetrahedron, OPTIONS])) as { error: string }).error).toEqual(expect.any(String));
    expect(await harness.call('importShapes', ['iges', 'x', OPTIONS])).toBeNull();
  });

  it('round-trips its own exports of primitives and booleans', async () => {
    const recipes = [leaf(box([0, 0, 0], [100, 50, 20])), leaf(entity('torus', { ringRadius: 5, tubeRadius: 1 })), BOOLEANS[3]![1]];
    const text = String(await harness.call('exportStep', [recipes.map(handleOf)]));
    const imported = (await harness.call('importShapes', ['step', text, OPTIONS])) as ImportedShapes;
    expect(imported.solids).toHaveLength(recipes.length);
    for (const [index, solid] of imported.solids.entries()) {
      const exact = (await harness.on('massProperties', recipes[index]!)) as ExactMassProperties;
      expect(relative((await blobMass(solid.brep)).volume, exact.volume), `solid ${index}`).toBeLessThan(1e-6);
    }
    expect(relative((await blobMass(imported.solids[1]!.brep)).volume, CLOSED_FORM['torus']![0])).toBeLessThan(1e-6);
  });
});

describe.skipIf(nativeKernelBinary === null)('native B-rep blobs', () => {
  it('evaluates brep leaves (also under booleans) once the blob is loaded, refusing a mismatched hash', async () => {
    // A blob no other test loaded: the healed import of the export of a one-off solid.
    const one = leaf(entity('cylinder', { radius: 7.25, height: 3.5 }, [1, 2, 3]));
    const step = String(await harness.call('exportStep', [[handleOf(one)]]));
    const brep = ((await harness.call('importShapes', ['step', step, OPTIONS])) as ImportedShapes).solids[0]!.brep;
    const sha256 = sha256Hex(brep);
    const leafRecipe: ShapeRecipe = { op: 'brep', blob: sha256, format: 'occt-brep-v1' };
    const drilled: ShapeRecipe = { op: 'boolean', boolean: 'subtract', a: leafRecipe, b: leaf(entity('sphere', { radius: 3 })) };
    const fresh = harness.fresh();
    expect(await fresh.call('evaluate', [leafRecipe]), 'not loaded yet').toBeNull();
    await fresh.call('loadBlob', [sha256Hex('something else'), brep]);
    expect(await fresh.call('evaluate', [leafRecipe]), 'still unloaded: the hash does not match').toBeNull();
    await fresh.call('loadBlob', [sha256, brep]);
    const rebuilt = (await fresh.on('massProperties', leafRecipe)) as ExactMassProperties;
    expect(relative(rebuilt.volume, Math.PI * 7.25 * 7.25 * 3.5)).toBeLessThan(1e-6);
    const cut = (await fresh.on('massProperties', drilled)) as ExactMassProperties;
    // The sphere (radius 3 at the origin) pokes into the cylinder (z from 1.25 up, radius 7.25 about [1, 2]) by a cap of height 1.75.
    const cap = (Math.PI * 1.75 ** 2 * (3 * 3 - 1.75)) / 3;
    expect(relative(cut.volume, rebuilt.volume - cap)).toBeLessThan(1e-6);
  });
});
