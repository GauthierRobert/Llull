/** Load validation of `AnalysisCase.creep` (PHY-11 TR-CRP-02): shape by zod, then the numeric rules `set_creep_step` enforces. */

import { z } from '@core/commands/schema';
import type { CreepStepSpec } from '@core/model/creep';
import { sliceSchemaErrors } from '@core/plugins/sliceSchema';
import { incrementsOrdered } from './increments';

const positive = z.number().positive().finite();

const stepSchema = z.object({
  preloadStep: z.boolean(),
  preloadPeriodS: z.number().nonnegative().finite(),
  durationS: positive,
  initialIncrementS: positive,
  minIncrementS: positive.optional(),
  maxIncrementS: positive.optional(),
  maxIncrements: z.number().int().min(1),
  cetol: positive,
  nlgeom: z.boolean(),
  temperature: z.object({ kind: z.literal('uniform'), valueK: positive }),
  outputTimes: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('log'), count: z.number().int().min(2).max(200) }),
    z.object({ kind: z.literal('linear'), everyS: positive }),
  ]),
});

/**
 * Errors of the creep step of one raw case (`where` = its path prefix).
 * @invariant only `creep` cases carry a step; the preload period is > 0 exactly when a preload step is written; min <= initial <= max <= duration;
 *   linear output gives at most 200 times
 */
export function creepErrors(analysisCase: Record<string, unknown>, where: string): string[] {
  const raw = analysisCase['creep'];
  if (raw === undefined) return [];
  const at = `${where}.creep`;
  if (analysisCase['type'] !== 'creep') return [`${at}: only creep cases carry a creep step`];
  const shape = sliceSchemaErrors(stepSchema, raw, at);
  if (shape.length > 0) return shape;
  const step = raw as CreepStepSpec;
  const errors: string[] = [];
  if (step.preloadStep !== step.preloadPeriodS > 0) errors.push(`${at}: preloadPeriodS must be > 0 exactly when preloadStep is true`);
  if (!incrementsOrdered(step.minIncrementS, step.initialIncrementS, step.maxIncrementS, step.durationS))
    errors.push(`${at}: increments must satisfy min <= initial <= max <= duration`);
  if (step.outputTimes.kind === 'linear' && (step.outputTimes.everyS > step.durationS || step.durationS / step.outputTimes.everyS > 200))
    errors.push(`${at}.outputTimes: everyS must be <= duration and give at most 200 times`);
  return errors;
}
