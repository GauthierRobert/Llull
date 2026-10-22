/** Reads the SWG validation pack (docs/design/02-sweep-loft-guides/validation): expected values and plans, so tests never hand-type a reference number. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const PACK = resolve(import.meta.dirname, '../../docs/design/02-sweep-loft-guides/validation');

interface PackCase {
  readonly vc: string;
  readonly values?: Record<string, number>;
}

const cases: PackCase[] = (JSON.parse(readFileSync(resolve(PACK, 'expected_results.json'), 'utf8')) as { cases: PackCase[] }).cases;

/** Reference value `key` of validation case `vc` (e.g. `swgValue('VC-SWG-05', 'linear_1_to_0.5_straight')`). */
export function swgValue(vc: string, key: string): number {
  const value = cases.find((c) => c.vc === vc)?.values?.[key];
  if (value === undefined) throw new Error(`no expected value ${vc}/${key}`);
  return value;
}

export interface PlanStep {
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly as?: string;
}

/** A plan of the pack as `build_project` actions. */
export function swgPlan(name: string): PlanStep[] {
  return JSON.parse(readFileSync(resolve(PACK, 'plans', `${name}.json`), 'utf8')) as PlanStep[];
}

interface StepOutcome {
  readonly index: number;
  readonly command: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly affected: string[];
  readonly data?: Record<string, unknown>;
}

/** Runs plan steps (optionally a prefix) through `build_project`; `volumeOf` returns the `mass_properties` volume following the step with alias `as`. */
export function runSwgPlan(
  actions: readonly PlanStep[],
  doc: CadDocument = createEmptyDocument(),
): { document: CadDocument; steps: StepOutcome[]; volumeOf: (alias: string) => number } {
  const result = execute(doc, 'build_project', { actions });
  const steps = (result.data as { steps: StepOutcome[] }).steps;
  const volumeOf = (alias: string): number => {
    const at = actions.findIndex((a) => a.as === alias);
    const volume = steps.find((s) => s.index > at && s.command === 'mass_properties')?.data?.['volume'];
    if (at < 0 || typeof volume !== 'number') throw new Error(`no volume for alias ${alias}`);
    return volume;
  };
  return { document: result.document, steps, volumeOf };
}

/** Relative error |a - b| / |b|. */
export const relError = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
