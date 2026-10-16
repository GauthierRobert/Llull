/**
 * Test helper: judge a measured value against a physics pack's `expected_results.json` case with the PHY-00 judge, and (when
 * `LLULL_PHYSICS_MEASUREMENTS` names a file) append `{ pack, caseId, measured }` so `npm run quality:physics` can report it.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { judgeCase, type Measured } from '@core/commands/vnv/judge';
import type { JsonValue } from '@core/commands/vnv/expected';

type RawCase = { readonly id: string } & Record<string, unknown>;

const cache = new Map<string, ReadonlyMap<string, RawCase>>();

export function packCases(pack: string): ReadonlyMap<string, RawCase> {
  const known = cache.get(pack);
  if (known !== undefined) return known;
  const file = JSON.parse(readFileSync(`docs/physics/${pack}/validation/expected_results.json`, 'utf8')) as { cases: RawCase[] };
  const cases = new Map(file.cases.map((c) => [c.id, c]));
  cache.set(pack, cases);
  return cases;
}

export function packCase(pack: string, caseId: string): RawCase {
  const found = packCases(pack).get(caseId);
  if (found === undefined) throw new Error(`no case ${caseId} in ${pack}`);
  return found;
}

/** The judge must pass the measurement (grade A or B); records it for the benchmark report. */
export function expectCase(pack: string, caseId: string, value: JsonValue, unit?: string): void {
  const expected = packCase(pack, caseId);
  const measured: Measured = { value, unit: unit ?? String(expected['unit']) };
  const target = process.env['LLULL_PHYSICS_MEASUREMENTS'];
  if (target !== undefined && target !== '') appendFileSync(target, `${JSON.stringify({ pack, caseId, measured })}\n`);
  const judgement = judgeCase(expected, measured);
  expect(judgement.verdict, `${caseId}: ${judgement.message}`).toBe('pass');
}
