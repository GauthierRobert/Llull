import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Validation pack of 01 DEF: reference data and expected results (docs/design/01-body-deformation/validation). */
const PACK = path.join(process.cwd(), 'docs', 'design', '01-body-deformation', 'validation');

export function packData<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(PACK, 'data', file), 'utf8')) as T;
}

export function packExpected(vc: string): { expected: unknown; tolerance?: unknown } {
  const all = JSON.parse(readFileSync(path.join(PACK, 'expected_results.json'), 'utf8')) as { cases: Array<{ vc: string }> };
  const found = all.cases.find((entry) => entry.vc === vc);
  if (found === undefined) throw new Error(`no expected result for ${vc}`);
  return found as unknown as { expected: unknown; tolerance?: unknown };
}

export function packPlan(file: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(path.join(PACK, 'plans', file), 'utf8')) as Array<Record<string, unknown>>;
}
