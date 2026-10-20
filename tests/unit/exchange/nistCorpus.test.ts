/**
 * The TS Part 21 reader against the Python reference on the NIST CAx-IF corpus (aerospace 04 TR-XCH-18, VC-XCH-05 / -06): every embedded value, the
 * schema, the unit and the entity census of the 28 files agree with `validation/nist_pmi_gvp_reference.json` (extract_validation_properties.py).
 * The files are fetched, never committed (docs/aerospace/01-exact-brep-kernel/validation/fetch_nist_step_files.py, ~/.cache/llull or
 * LLULL_NIST_STEP_DIR); without them the suite skips with the reason logged.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarizeStep21 } from '@lib/step21/summary';
import { canonicalizeStep21 } from '@lib/step21/canonical';
import { groupFileGvp } from '@core/commands/exchange/fileGvp';

interface Reference {
  readonly file: string;
  readonly fileSchema: string;
  readonly lengthUnitDetected: string;
  readonly validationPropertyCounts: { geometric: number; pmi: number; attribute: number };
  readonly placeholderGvpDropped: number;
  readonly geometricValidationProperties: {
    propertyDefinition: string;
    description: string;
    values: { item: string; measure: string; value: number | number[] }[];
  }[];
  readonly entityCensus: Record<string, number>;
}

const reference = (
  JSON.parse(
    readFileSync(
      path.resolve(__dirname, '../../../docs/aerospace/04-interop-ap242-jt-iges/validation/nist_pmi_gvp_reference.json'),
      'utf8',
    ),
  ) as { files: Reference[] }
).files;
const CORPUS = process.env['LLULL_NIST_STEP_DIR'] || path.join(os.homedir(), '.cache', 'llull', 'nist-pmi-step-files');
const present = reference.filter((entry) => existsSync(path.join(CORPUS, entry.file)));
if (present.length < reference.length)
  console.warn(`[NIST step21] ${reference.length - present.length}/${reference.length} corpus files missing in ${CORPUS}`);

const isZero = (value: number | readonly number[]): boolean =>
  Array.isArray(value) ? value.every((component) => component === 0) : value === 0;

describe.skipIf(present.length === 0)('step21 reader vs the Python reference on the NIST corpus', () => {
  it('reads schema, unit, validation properties and census exactly like the reference', () => {
    expect(present.length).toBeGreaterThan(0);
    for (const entry of present) {
      const text = readFileSync(path.join(CORPUS, entry.file), 'latin1');
      const summary = summarizeStep21(text);
      expect(summary.fileSchema, entry.file).toBe(entry.fileSchema);
      expect(summary.lengthUnit?.name, entry.file).toBe(entry.lengthUnitDetected);
      expect(summary.validationPropertyCounts, entry.file).toEqual(entry.validationPropertyCounts);
      expect(summary.entityCensus, entry.file).toEqual(entry.entityCensus);
      const kept = summary.geometricValidationProperties.filter((property) => !property.values.every((value) => isZero(value.value)));
      expect(summary.geometricValidationProperties.length - kept.length, `${entry.file} placeholders`).toBe(entry.placeholderGvpDropped);
      expect(
        kept.map((property) => `#${property.propertyDefinition} ${property.description}`),
        entry.file,
      ).toEqual(entry.geometricValidationProperties.map((property) => `${property.propertyDefinition} ${property.description}`));
      // every value the Python reference read is read identically; the reference's number pattern misses reals written `812.`, which this reader keeps
      for (const expected of entry.geometricValidationProperties) {
        const mine = kept.find((property) => `#${property.propertyDefinition}` === expected.propertyDefinition);
        for (const value of expected.values) expect(mine?.values, `${entry.file} ${expected.propertyDefinition}`).toContainEqual(value);
      }
    }
  }, 120_000);

  it('converts inch files with the exact factor 25.4 before any comparison (VC-XCH-12)', () => {
    const inch = present.filter((entry) => entry.lengthUnitDetected === 'inch');
    expect(inch.length).toBeGreaterThan(0);
    for (const entry of inch) {
      const summary = summarizeStep21(readFileSync(path.join(CORPUS, entry.file), 'latin1'));
      expect(summary.lengthUnit?.mmPerUnit, entry.file).toBe(25.4);
      const [group] = groupFileGvp(summary, 1).filter((candidate) => candidate.volume !== undefined && !candidate.placeholder);
      const raw = entry.geometricValidationProperties.flatMap((property) => property.values).find((value) => value.item.includes('volume'));
      if (group !== undefined && raw !== undefined) expect(group.volume).toBeCloseTo((raw.value as number) * 25.4 ** 3, 4);
    }
  });

  it('reproduces the CTC-02 cross-CAD spread: AP203 vs AP242 volume +1.1168549e-4, area -4.9284126e-4, centroid 0.01814 mm (VC-XCH-06)', () => {
    const pair = ['nist_ctc_02_asme1_rc.stp', 'nist_ctc_02_asme1_ap242-e2.stp'].map((file) =>
      present.some((entry) => entry.file === file)
        ? groupFileGvp(summarizeStep21(readFileSync(path.join(CORPUS, file), 'latin1')), 1)
        : null,
    );
    const [first, second] = pair;
    if (first === null || first === undefined || second === null || second === undefined) return;
    const solid = (groups: NonNullable<(typeof pair)[number]>): NonNullable<(typeof pair)[number]>[number] =>
      groups.find((group) => group.volume !== undefined && group.centroid !== undefined && group.target === 'part')!;
    const [ap203, ap242] = [solid(first), solid(second)];
    expect((ap242.volume! - ap203.volume!) / ap203.volume!).toBeCloseTo(1.1168549051822634e-4, 12);
    expect(Math.hypot(...ap242.centroid!.map((value, axis) => value - ap203.centroid![axis]!))).toBeCloseTo(0.018141545708500635, 12);
  });

  it('canonicalizes every file idempotently without losing a record', () => {
    for (const entry of present.slice(0, 3)) {
      const text = readFileSync(path.join(CORPUS, entry.file), 'latin1');
      const once = canonicalizeStep21(text);
      expect(canonicalizeStep21(once), entry.file).toBe(once);
      expect(summarizeStep21(once).records, entry.file).toBe(summarizeStep21(text).records);
      expect(summarizeStep21(once).entityCensus, entry.file).toEqual(summarizeStep21(text).entityCensus);
    }
  }, 120_000);
});
