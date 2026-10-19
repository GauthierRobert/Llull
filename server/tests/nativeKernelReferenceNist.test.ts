/**
 * VC-KRN-25 (01 KRN TR-KRN-05), NIST half: the native `llull-kernel` (OCCT 7.9.2) imports the 28 NIST PMI STEP files (R20) that
 * `nist_occt_reference.json` measured with OCP 7.9.3.1. That reference measured the whole transferred shape (loose shells, faces,
 * PMI wires and points included), so the import census (solids / shells / faces, `validAsRead`) is compared with it, and the imported
 * solid with `nist_occt_solid_reference.json` + `nist_occt_solid_faces.json` (the first solid of the same healed shape, same 7.9.3
 * libraries): faces / edges / vertices, `validAfterShapeFix`, max tolerance, volume / area / centroid / inertia (VC-KRN-01 tolerances:
 * rel 1e-9, centroid abs 1e-6 mm), per-face area / centroid (VC-KRN-10 cross-build mode); plus the tessellated-only refusal
 * (VC-KRN-05). The import uses import_step_exact's defaults (precision 1e-4 mm, max tolerance 0.1 mm, heal, sew).
 *
 * The files are not committed (42 MB): `python3 -I docs/aerospace/01-exact-brep-kernel/validation/fetch_nist_step_files.py` puts them
 * in ~/.cache/llull/nist-pmi-step-files (or LLULL_NIST_STEP_DIR), sha256-checked. Without them the suite skips with the reason logged;
 * LLULL_REQUIRE_NIST_CORPUS=1 makes that a failure. Without the binary it skips like every native suite.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ShapeTopology } from '@core/geometry/kernel';
import type { ExactMassProperties, FaceDetail, ImportedShapes, ImportShapesOptions } from '@core/geometry/kernelPorts';
import type { ShapeRecipe } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import {
  faceSignature,
  nativeKernelBinary,
  nativeReferenceHarness,
  readReference,
  relative,
  WorstDeviations,
} from './nativeReferenceSupport';

/** Whole-file row of nist_occt_reference.json (measure_step_brep.py): the healed OneShape, loose shells / wires / points included. */
interface FileReference {
  readonly file: string;
  readonly sha256?: string;
  readonly error?: string;
  readonly solids: number;
  readonly shells: number;
  readonly faces: number;
  readonly validAsRead: boolean;
  readonly validAfterShapeFix: boolean;
}
/** Solid-level row of nist_occt_solid_reference.json: the first solid of the same healed shape, what import_step_exact keeps. */
interface SolidReference {
  readonly shells: number;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  readonly validAfterShapeFix: boolean;
  readonly maxToleranceMm: number;
  readonly volumeMm3: number;
  readonly areaMm2: number;
  readonly centroidMm: readonly [number, number, number];
  readonly inertiaRho1Mm5: readonly (readonly number[])[];
  readonly bboxMm: readonly number[];
  readonly signature: string;
}

const reference = readReference<{ ocp: string; files: readonly FileReference[] }>('nist_occt_reference.json');
const solidReference = readReference<{ ocp: string; files: readonly { file: string; solid?: SolidReference }[] }>(
  'nist_occt_solid_reference.json',
);
const CORPUS = process.env['LLULL_NIST_STEP_DIR'] || path.join(os.homedir(), '.cache', 'llull', 'nist-pmi-step-files');
const missing = reference.files.filter(({ file }) => !existsSync(path.join(CORPUS, file))).map(({ file }) => file);
const FETCH = 'python3 -I docs/aerospace/01-exact-brep-kernel/validation/fetch_nist_step_files.py';
if (missing.length > 0 && process.env['LLULL_REQUIRE_NIST_CORPUS'] === '1')
  throw new Error(`NIST STEP corpus incomplete in ${CORPUS} (${missing.length} missing): run ${FETCH}`);
if (missing.length > 0) console.warn(`[VC-KRN-25 NIST] skipped: ${missing.length} reference files missing in ${CORPUS}; run ${FETCH}`);
const runnable = nativeKernelBinary !== null && missing.length === 0;

/** import_step_exact's defaults: document tolerance 1e-4 mm, max(0.1, maxImportTolerance) mm, heal and sew on. */
const OPTIONS: ImportShapesOptions = { precision: 1e-4, maxTolerance: 0.1, heal: true, sew: true };
/**
 * Files whose healed solid is BRepCheck-valid but whose `BRepTools::Write` text blob (`occt-brep-v1`, what documents store) reads back
 * invalid. Measured identical on the WASM kernel (OCCT 7.4) and on plain OCCT 7.9.2 (V1 and V3 text), so it is the text round trip,
 * not the native kernel: a follow-up for the blob format (TR-KRN-21).
 */
const BLOB_LOSES_VALIDITY: readonly string[] = ['nist_stc_07_asme1_ap242-e3.stp'];
/** VC-KRN-06 warns above 0.01 mm: the native healed tolerance must fall on the same side as the reference's. */
const TOLERANCE_WARNING_MM = 0.01;

const faceReference = readReference<{ files: readonly { file: string; faces: readonly (readonly number[])[] }[] }>(
  'nist_occt_solid_faces.json',
);

const harness = nativeReferenceHarness();
const worst = new WorstDeviations();
const sameSignature: string[] = [];
afterAll(() => {
  worst.report(`NIST STEP corpus (${reference.files.length} files)`);
  if (runnable) console.warn(`[VC-KRN-25] face signature (sha256 of the %.6f text) identical on ${sameSignature.length} of 27 files`);
});

/** Native [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] vs the reference's 3 x 3 matrix, relative to its largest diagonal term. */
function inertiaDeviation(native: readonly number[], matrix: readonly (readonly number[])[]): number {
  const cells: readonly [number, number][] = [
    [0, 0],
    [1, 1],
    [2, 2],
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  const scale = Math.max(...[0, 1, 2].map((k) => Math.abs(matrix[k]![k]!)));
  return Math.max(...cells.map(([i, j], index) => Math.abs(native[index]! - matrix[i]![j]!) / scale));
}

const brepFiles = reference.files.filter((row) => row.error === undefined);

describe.skipIf(!runnable)('VC-KRN-25: native kernel vs the OCP 7.9.3 NIST STEP reference (nist_occt_reference.json)', () => {
  it('reads the pinned corpus: 27 B-rep files and one tessellated-only file, every sha256 as measured', () => {
    expect(reference.ocp).toBe('7.9.3.1');
    expect(brepFiles).toHaveLength(27);
    for (const { file, sha256 } of brepFiles) expect(sha256Hex(readFileSync(path.join(CORPUS, file), 'utf8')), file).toBe(sha256);
  });

  it.each(brepFiles.map((row) => [row.file, row] as const))(
    '%s',
    async (file, whole) => {
      const ref = solidReference.files.find((row) => row.file === file)!.solid!;
      const text = readFileSync(path.join(CORPUS, file), 'utf8');
      const imported = (await harness.call('importShapes', ['step', text, OPTIONS])) as ImportedShapes;
      expect('solids' in imported, `${file} imported`).toBe(true);
      // Whole file (the census is taken on the transferred shape, before healing; ShapeFix changes no count on this corpus).
      expect([imported.census.solids, imported.census.shells, imported.census.faces], `${file} census`).toEqual([
        whole.solids,
        whole.shells,
        whole.faces,
      ]);
      expect(imported.solids, `${file} solids`).toHaveLength(whole.solids);
      const solid = imported.solids[0]!;
      expect([solid.validAsRead, solid.validAfterHeal], `${file} validity`).toEqual([whole.validAsRead, ref.validAfterShapeFix]);
      expect(solid.faces, `${file} faces`).toBe(ref.faces);
      expect(solid.maxToleranceMm > TOLERANCE_WARNING_MM, `${file} tolerance class (${solid.maxToleranceMm} mm)`).toBe(
        ref.maxToleranceMm > TOLERANCE_WARNING_MM,
      );
      expect(worst.record('max sub-shape tolerance (mm)', Math.abs(solid.maxToleranceMm - ref.maxToleranceMm), file)).toBeLessThan(1e-12);

      const blob = sha256Hex(solid.brep);
      await harness.call('loadBlob', [blob, solid.brep]);
      const recipe: ShapeRecipe = { op: 'brep', blob, format: 'occt-brep-v1' };
      const topology = (await harness.on('topology', recipe)) as ShapeTopology;
      const counts = [topology.solids, topology.faces.length, topology.edges.length, topology.vertices];
      expect(counts, `${file} solids / faces / edges / vertices`).toEqual([1, ref.faces, ref.edges, ref.vertices]);
      const analysis = (await harness.on('analyze', recipe)) as { valid: boolean; lumps: readonly { volume: number; area: number }[] };
      expect(analysis.lumps, `${file} one lump`).toHaveLength(1);
      // The import report says valid; the B-rep text blob read back may not be (known issue, ratcheted: it fails if it starts to pass).
      expect(analysis.valid, `${file} blob valid`).toBe(
        BLOB_LOSES_VALIDITY.includes(file) ? !ref.validAfterShapeFix : ref.validAfterShapeFix,
      );
      // Like for like: `analyze` integrates with BRepGProp's default (Gauss) rule, as the reference did.
      expect(worst.record('volume (raw BRepGProp)', relative(analysis.lumps[0]!.volume, ref.volumeMm3), file)).toBeLessThan(1e-9);
      expect(worst.record('area (raw BRepGProp)', relative(analysis.lumps[0]!.area, ref.areaMm2), file)).toBeLessThan(1e-9);
      const mass = (await harness.on('massProperties', recipe)) as ExactMassProperties;
      const faces = (await harness.on('faceQuery.faceDetails', recipe, { samples: 1 })) as readonly FaceDetail[];
      expect(worst.record('volume', relative(mass.volume, ref.volumeMm3), file)).toBeLessThan(1e-9);
      expect(worst.record('area', relative(mass.area, ref.areaMm2), file)).toBeLessThan(1e-9);
      const centroid = Math.max(...ref.centroidMm.map((value, k) => Math.abs(mass.centroid[k]! - value)));
      expect(worst.record('centroid (mm)', centroid, file)).toBeLessThan(1e-6);
      expect(worst.record('inertia', inertiaDeviation(mass.inertiaAtCentroid, ref.inertiaRho1Mm5), file)).toBeLessThan(1e-9);
      // The native bounds (BRepBndLib::Add, control-polygon based) enclose the reference's optimal box; they are not equal to it.
      const bounds = [...mass.bounds.min, ...mass.bounds.max];
      ref.bboxMm.forEach((value, k) =>
        expect(k < 3 ? bounds[k]! - value : value - bounds[k]!, `${file} bounds enclose`).toBeLessThan(1e-6),
      );
      worst.record(
        'bounding box excess over the optimal box (mm)',
        Math.max(...ref.bboxMm.map((value, k) => Math.abs(bounds[k]! - value))),
        file,
      );
      // VC-KRN-10 cross-build mode: same faces in the same order, each area / centroid within the VC-KRN-01 tolerances of the
      // reference's 6-decimal values (+ 5e-7 for that rounding). The sha256 signature is reported, not required: values within
      // 1e-15 of zero print as -0.000000 or 0.000000 depending on the build, and a value near a 6th-decimal boundary rounds either way.
      const expected = faceReference.files.find((row) => row.file === file)!.faces;
      expect(faces, `${file} faces`).toHaveLength(expected.length);
      let faceDeviation = 0;
      faces.forEach(({ area, centroid }, index) => {
        const [refArea, ...refCentroid] = expected[index]!;
        const deviation = Math.max(
          (Math.abs(area - refArea!) - 5e-7) / Math.max(1, refArea!) / 1e-9,
          ...centroid.map((value, k) => (Math.abs(value - refCentroid[k]!) - 5e-7) / 1e-6),
        );
        faceDeviation = Math.max(faceDeviation, deviation);
      });
      expect(faceDeviation, `${file} per-face area / centroid (1 = at tolerance)`).toBeLessThanOrEqual(1);
      if (faceSignature(faces, 6) === ref.signature) sameSignature.push(file);
    },
    120_000,
  );

  it('nist_ftc_08_asme1_ap242-e4-tg.stp (tessellated only, no B-rep): refused as tessellated_only, never an empty import', async () => {
    const tessellated = reference.files.find(({ error }) => error !== undefined)!;
    expect(tessellated.file).toBe('nist_ftc_08_asme1_ap242-e4-tg.stp');
    const text = readFileSync(path.join(CORPUS, tessellated.file), 'utf8');
    expect(await harness.call('importShapes', ['step', text, OPTIONS])).toMatchObject({ error: 'tessellated_only' });
  });
});
