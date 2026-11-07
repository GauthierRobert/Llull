import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const PACK = path.resolve(__dirname, '../../../docs/physics/20-vibroacoustics/validation');

interface ExpectedCase {
  readonly id: string;
  readonly value: unknown;
  readonly tolerance: { readonly rel?: number; readonly abs?: number };
}

const cases = (JSON.parse(readFileSync(path.join(PACK, 'expected_results.json'), 'utf8')) as { cases: ExpectedCase[] }).cases;

/** The pinned case `id` of the validation pack (expected_results.json). */
function expectedCase(id: string): ExpectedCase {
  const found = cases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no validation case ${id}`);
  return found;
}

/** Numeric value(s) of a pinned case as an array. */
export const expectedNumbers = (id: string): number[] => [expectedCase(id).value].flat() as number[];

/** Tolerance of a pinned case (spec: rel 1e-12 on 12-digit values, abs for dB), widened by the 12-significant-digit rounding of the pins. */
export function withinCase(actual: number, expected: number, id: string): boolean {
  const { rel, abs } = expectedCase(id).tolerance;
  return rel === undefined
    ? Math.abs(actual - expected) <= (abs ?? 0)
    : Math.abs(actual - expected) <= Math.max(rel, 1e-11) * Math.abs(expected);
}

/** CSV rows of a pack file as objects keyed by header. */
export function csvRows(file: string): Record<string, number>[] {
  const [header = '', ...rows] = readFileSync(path.join(PACK, file), 'utf8').trim().split(/\r?\n/);
  const keys = header.split(',');
  return rows.map((row) => Object.fromEntries(row.split(',').map((cell, index) => [keys[index] ?? '', Number(cell)])));
}

export const THIRD_NOMINAL_27 = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
  10000,
];

interface FlatParams {
  name: string;
  bandwidth: 'third_octave';
  reference: string;
  bands: { nominalHz: number; splDb: number }[];
  source: { citation: string; grade?: 'A' | 'B' | 'C' };
}

export const flatParams = (name = 'flat130', splDb = 130, grade: 'A' | 'B' | 'C' | 'none' = 'A'): FlatParams => ({
  name,
  bandwidth: 'third_octave' as const,
  reference: '20uPa',
  bands: THIRD_NOMINAL_27.map((nominalHz) => ({ nominalHz, splDb })),
  source: { citation: 'synthetic test input of VC-VAC-06 (not a test level)', ...(grade === 'none' ? {} : { grade }) },
});

/** Runs a command, failing the test setup when it is refused. */
export function run(doc: CadDocument, name: string, params: object): ReturnType<typeof execute> {
  const result = execute(doc, name, params);
  if (result.error !== undefined || result.rejected === true) throw new Error(`${name} refused: ${result.summary}`);
  return result;
}

export const flatDocument = (): CadDocument => run(createEmptyDocument(), 'define_acoustic_spectrum', flatParams()).document;
