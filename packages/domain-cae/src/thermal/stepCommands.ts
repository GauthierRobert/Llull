/** set_initial_temperature / set_thermal_step: the time-integration set-up of a heat_* analysis. */

import type { ThermalStep } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisIdSchema, quantitySchema } from '../shared/schemas';
import { isProblem, problem, thermalCaseOf, withThermal, type Problem } from './access';
import { refuseThermal } from './codes';
import { quantityProblem } from './quantities';

/**
 * @affects doc.analysis.cases[analysisId].thermal.initialTemperature
 * @invariant a finite temperature above absolute zero in a temperature unit
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; non-thermal case -> THM_CASE_TYPE; bad unit -> THM_UNITS_MISMATCH (refusals, unchanged doc)
 */
export const setInitialTemperature = defineCommand({
  name: 'set_initial_temperature',
  description:
    'Set the uniform initial temperature of a heat_steady / heat_transient analysis (value + unit degC | K | degF). MANDATORY for a ' +
    'transient (never defaulted); for a steady case it is only the start of the nonlinear iteration (useful with radiation). ' +
    'Written as *INITIAL CONDITIONS on every node.',
  params: z.object({
    analysisId: analysisIdSchema,
    value: z.number().describe('Initial temperature, in `unit`.'),
    unit: z.string().describe("Temperature unit: 'degC', 'K' or 'degF'."),
  }),
  run: (doc, { analysisId, value, unit }): CommandResult => {
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'set_initial_temperature', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    const bad = quantityProblem('temperature', { value, unit });
    if (bad !== null) return fail(problem('THM_UNITS_MISMATCH', bad, [analysisId], ['unit']));
    return changed(
      withThermal(doc, found, { ...found.thermal, initialTemperature: { value, unit } }),
      `set_initial_temperature: '${analysisId}' starts at ${value} ${unit}.`,
      [analysisId],
    );
  },
});

const positive = (value: number | undefined): boolean => value === undefined || (Number.isFinite(value) && value > 0);

/** Problem text of a merged step for the case type, or null. */
function stepProblem(step: ThermalStep, transient: boolean): string | null {
  const { endTimeS, initialIncrementS: initial, maxIncrementS: max, minIncrementS: min, outputTimesS: times, outputEveryS: every } = step;
  if (!transient) {
    const keys = Object.keys(step);
    return keys.length === 0 ? null : `${keys.join(', ')} only apply to a heat_transient analysis`;
  }
  if (endTimeS === undefined) return 'a transient step needs endTimeS (seconds, > 0)';
  if (![endTimeS, initial, max, min, every].every(positive)) return 'times and increments must be finite numbers > 0';
  if (initial !== undefined && initial > endTimeS) return 'initialIncrementS must not exceed endTimeS';
  if (max !== undefined && min !== undefined && min > max) return 'minIncrementS must not exceed maxIncrementS';
  if (initial !== undefined && max !== undefined && initial > max) return 'initialIncrementS must not exceed maxIncrementS';
  if (initial !== undefined && min !== undefined && initial < min) return 'initialIncrementS must not be below minIncrementS';
  if (times !== undefined && every !== undefined) return 'give outputTimesS or outputEveryS, not both';
  if (times !== undefined) {
    if (times.length === 0 || times.some((t, i) => !(t > 0) || t > endTimeS || (i > 0 && t <= (times[i - 1] ?? 0))))
      return 'outputTimesS must be strictly increasing times in (0, endTimeS]';
  }
  if (step.fixedIncrements === true) {
    if (initial === undefined) return 'fixedIncrements needs initialIncrementS (the constant increment)';
    if (times !== undefined)
      return 'fixedIncrements cannot be combined with outputTimesS (CalculiX DIRECT excludes TIME POINTS); use outputEveryS';
    if (step.maxTemperatureChangePerIncrement !== undefined) return 'fixedIncrements and maxTemperatureChangePerIncrement are exclusive';
    if (every !== undefined && Math.abs(every / initial - Math.round(every / initial)) > 1e-9)
      return 'with fixedIncrements outputEveryS must be a whole multiple of initialIncrementS';
  }
  const deltmx = step.maxTemperatureChangePerIncrement;
  if (deltmx !== undefined && (quantityProblem('temperatureDifference', deltmx) !== null || !(deltmx.value > 0)))
    return 'maxTemperatureChangePerIncrement must be a positive temperature difference in K';
  return null;
}

const stepSchema = {
  endTimeS: z.number().optional().describe('Transient only: end time of the step, seconds, > 0 (required once for a transient).'),
  initialIncrementS: z
    .number()
    .optional()
    .describe('First (or, with fixedIncrements, every) time increment, seconds. Default endTimeS/100 (named in the deck).'),
  maxIncrementS: z.number().optional().describe('Largest allowed increment, seconds.'),
  minIncrementS: z.number().optional().describe('Smallest allowed increment, seconds.'),
  fixedIncrements: z
    .boolean()
    .optional()
    .describe('true: constant increments (*HEAT TRANSFER, DIRECT). Excludes outputTimesS and maxTemperatureChangePerIncrement.'),
  maxTemperatureChangePerIncrement: quantitySchema
    .optional()
    .describe('Largest temperature change per increment as { value, unit: "K" } (DELTMX); the solver shortens increments to respect it.'),
  outputTimesS: z
    .array(z.number())
    .optional()
    .describe('Result times in seconds, strictly increasing within (0, endTimeS]. Excludes outputEveryS.'),
  outputEveryS: z.number().optional().describe('Result interval in seconds (default: every increment). Excludes outputTimesS.'),
};

/**
 * @affects doc.analysis.cases[analysisId].thermal.step (given fields replace the current ones)
 * @invariant transient: endTimeS > 0, 0 < min <= initial <= max <= end, increments and output times consistent, DIRECT excludes TIME POINTS
 * @failure unknown analysis / non-thermal case; steady case with transient fields, bad times -> THM_STEP_INVALID (refusals, unchanged doc)
 */
export const setThermalStep = defineCommand({
  name: 'set_thermal_step',
  description:
    'Set the time stepping of a heat_transient analysis (a heat_steady case needs none): endTimeS, initialIncrementS, minIncrementS, ' +
    'maxIncrementS, fixedIncrements (constant increments), maxTemperatureChangePerIncrement (DELTMX, K) and the result times ' +
    '(outputTimesS or outputEveryS; with fixedIncrements only outputEveryS, a multiple of the increment). Times are in seconds. Only the ' +
    'given fields change. A transient also needs set_initial_temperature and cp + density on the materials.',
  params: z.object({ analysisId: analysisIdSchema, ...stepSchema }),
  run: (doc, { analysisId, ...fields }): CommandResult => {
    const fail = (found: Problem): CommandResult =>
      refuseThermal(doc, 'set_thermal_step', found.code, found.message, found.ids, found.paths);
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return fail(found);
    const given = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as ThermalStep;
    const step: ThermalStep = { ...found.thermal.step, ...given };
    const bad = stepProblem(step, found.analysisCase.type === 'heat_transient');
    if (bad !== null) return fail(problem('THM_STEP_INVALID', bad, [analysisId], Object.keys(given)));
    const text = Object.entries(step)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(', ');
    return changed(
      withThermal(doc, found, { ...found.thermal, step }),
      `set_thermal_step: '${analysisId}' step ${text === '' ? 'empty' : text}.`,
      [analysisId],
    );
  },
});
