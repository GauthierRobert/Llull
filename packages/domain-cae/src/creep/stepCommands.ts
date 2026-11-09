/** set_creep_step / delete_creep_step: the hold of a `creep` case (PHY-11 FR-CRP-01, 03, 05, 13). */

import type { AnalysisCase } from '@core/model/analysis';
import type { CreepOutputTimes, CreepStepSpec } from '@core/model/creep';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { caseOf, withCase } from '../shared/access';
import { temperatureProblem } from '../shared/quantity';
import { analysisIdSchema, quantitySchema } from '../shared/schemas';
import { refuseCrp } from './codes';
import { incrementsOrdered } from './increments';
import { partIssues } from './readiness';

const sig = (value: number): string => significantNumber(value, 6);

/** Named defaults of `set_creep_step` (each is reported in the summary). */
const CREEP_DEFAULTS = {
  /** The hold is split in this many first increments (CalculiX then grows the increment with CETOL). */
  initialIncrementFraction: 1e-3,
  maxIncrements: 1000,
  logOutputCount: 50,
  /** The preload step is this fraction of the hold: it counts in the CalculiX total time, so time hardening (m != 0) sees it. */
  preloadPeriodFraction: 1e-6,
} as const;

const timeSchema = quantitySchema.describe(
  "A time { value, unit } with unit s, min or h (stored in seconds), e.g. { value: 1000, unit: 's' }.",
);

const outputTimesSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('log').describe('Log-spaced output times.'),
      count: z
        .number()
        .int()
        .min(2)
        .max(200)
        .describe('Number of output times between the first increment and the end of the hold, 2 to 200.'),
    })
    .describe('Log-spaced times: the right choice for creep, which changes fastest at the start.'),
  z
    .object({ kind: z.literal('linear').describe('Evenly spaced output times.'), every: timeSchema.describe('Spacing, > 0.') })
    .describe('Evenly spaced times (at most 200 of them).'),
]);

/** Seconds of a time quantity, or the reason it is not one. */
function seconds(quantity: { readonly value: number; readonly unit: string }): number | string {
  if (!['s', 'min', 'h'].includes(quantity.unit.trim())) return `unit '${quantity.unit}' is not s, min or h`;
  const converted = convertValue(quantity.value, quantity.unit, 's');
  return isUnitFailure(converted) ? converted.message : converted.value;
}

type Refuse = (code: string, message: string, path: string) => CommandResult;

interface Resolved {
  readonly spec: CreepStepSpec;
  readonly defaulted: readonly string[];
}

/** Spec of the parameters (time quantities converted, named defaults resolved), or the coded refusal. */
function resolve(params: z.output<typeof stepSchema>, refuse: Refuse): Resolved | CommandResult {
  const defaulted: string[] = [];
  const time = (
    quantity: { readonly value: number; readonly unit: string },
    path: string,
    code = 'CRP_STEP_PARAM_INVALID',
  ): number | CommandResult => {
    const value = seconds(quantity);
    return typeof value === 'string' ? refuse(code, `${path}: ${value}`, path) : value;
  };
  const durationS = time(params.duration, 'duration', 'CRP_DURATION_INVALID');
  if (typeof durationS !== 'number') return durationS;
  if (!(durationS > 0)) return refuse('CRP_DURATION_INVALID', `duration ${sig(durationS)} s must be > 0`, 'duration');
  if (!(params.cetol > 0)) return refuse('CRP_CETOL_INVALID', `cetol ${params.cetol} must be > 0`, 'cetol');
  const optional = (quantity: z.output<typeof timeSchema> | undefined, path: string): number | undefined | CommandResult =>
    quantity === undefined ? undefined : time(quantity, path);
  const initialGiven = optional(params.initialIncrement, 'initialIncrement');
  if (typeof initialGiven === 'object') return initialGiven;
  const minimum = optional(params.minIncrement, 'minIncrement');
  if (typeof minimum === 'object') return minimum;
  const maximum = optional(params.maxIncrement, 'maxIncrement');
  if (typeof maximum === 'object') return maximum;
  const initialIncrementS = initialGiven ?? durationS * CREEP_DEFAULTS.initialIncrementFraction;
  if (initialGiven === undefined) defaulted.push(`initialIncrement ${sig(initialIncrementS)} s (1/1000 of the hold)`);
  const maxIncrements = params.maxIncrements ?? CREEP_DEFAULTS.maxIncrements;
  if (params.maxIncrements === undefined) defaulted.push(`maxIncrements ${maxIncrements}`);
  if (!incrementsOrdered(minimum, initialIncrementS, maximum, durationS))
    return refuse(
      'CRP_STEP_PARAM_INVALID',
      `increments must satisfy 0 < min <= initial (${sig(initialIncrementS)} s) <= max <= duration (${sig(durationS)} s)`,
      'initialIncrement',
    );
  const kelvin = temperatureProblem(params.temperature);
  if (kelvin !== null) return refuse('CRP_STEP_PARAM_INVALID', `temperature: ${kelvin}`, 'temperature');
  const temperatureK = convertValue(params.temperature.value, params.temperature.unit, 'K');
  if (isUnitFailure(temperatureK)) return refuse('CRP_STEP_PARAM_INVALID', `temperature: ${temperatureK.message}`, 'temperature');
  const outputTimes = resolveOutput(params.outputTimes, durationS, refuse, defaulted);
  if ('summary' in outputTimes) return outputTimes;
  const preloadStep = params.preloadStep ?? true;
  if (params.preloadStep === undefined) defaulted.push('preloadStep true');
  const nlgeom = params.nlgeom ?? false;
  if (params.nlgeom === undefined) defaulted.push('nlgeom false');
  return {
    spec: {
      preloadStep,
      preloadPeriodS: preloadStep ? durationS * CREEP_DEFAULTS.preloadPeriodFraction : 0,
      durationS,
      initialIncrementS,
      ...(minimum !== undefined ? { minIncrementS: minimum } : {}),
      ...(maximum !== undefined ? { maxIncrementS: maximum } : {}),
      maxIncrements,
      cetol: params.cetol,
      nlgeom,
      temperature: { kind: 'uniform', valueK: temperatureK.value },
      outputTimes,
    },
    defaulted,
  };
}

function resolveOutput(
  input: z.output<typeof outputTimesSchema> | undefined,
  durationS: number,
  refuse: Refuse,
  defaulted: string[],
): CreepOutputTimes | CommandResult {
  if (input === undefined) {
    defaulted.push(`outputTimes log ${CREEP_DEFAULTS.logOutputCount}`);
    return { kind: 'log', count: CREEP_DEFAULTS.logOutputCount };
  }
  if (input.kind === 'log') return { kind: 'log', count: input.count };
  const every = seconds(input.every);
  if (typeof every === 'string') return refuse('CRP_STEP_PARAM_INVALID', `outputTimes.every: ${every}`, 'outputTimes');
  return every > 0 && every <= durationS && durationS / every <= 200
    ? { kind: 'linear', everyS: every }
    : refuse('CRP_STEP_PARAM_INVALID', `outputTimes.every must be > 0, <= the duration and give at most 200 times`, 'outputTimes');
}

/** The `creep` case `analysisId`, or the coded refusal of `command`. */
export function creepCase(doc: CadDocument, command: string, analysisId: string): { readonly analysis: AnalysisCase } | CommandResult {
  const analysis = caseOf(doc, analysisId);
  if (analysis === undefined)
    return refuseCrp(doc, command, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
  if (analysis.type !== 'creep')
    return refuseCrp(
      doc,
      command,
      'CRP_CASE_TYPE',
      `analysis '${analysisId}' is of type '${analysis.type}', not creep`,
      [analysisId],
      ['analysisId'],
    );
  if (analysis.solver !== 'calculix')
    return refuseCrp(
      doc,
      command,
      'CRP_SOLVER_UNSUPPORTED',
      `creep needs solver calculix, the case has '${analysis.solver}'`,
      [analysisId],
      ['analysisId'],
    );
  return { analysis };
}

export const isRefusal = (value: { readonly analysis: AnalysisCase } | CommandResult): value is CommandResult => 'summary' in value;

const stepSchema = z.object({
  analysisId: analysisIdSchema,
  duration: timeSchema.describe('Length of the hold: how long the loads act, > 0 (the creep strain is read at its end).'),
  initialIncrement: timeSchema
    .optional()
    .describe('First time increment of the hold. Default: 1/1000 of the duration (CalculiX then grows it as the creep rate falls).'),
  minIncrement: timeSchema.optional().describe('Smallest increment the solver may cut back to. Default: CalculiX default.'),
  maxIncrement: timeSchema
    .optional()
    .describe('Largest increment. Default: unlimited (CalculiX default); set it when the solver stalls or the creep rate changes quickly.'),
  maxIncrements: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .optional()
    .describe('Most increments the hold may take (*STEP INC, 1 to 1000000); the run stops with an error when reached. Default 1000.'),
  cetol: z
    .number()
    .describe(
      '*VISCO CETOL: creep strain error allowed per increment (dimensionless, > 0). No default: choose it relative to the elastic strain, e.g. 1e-4 .. 1e-3.',
    ),
  preloadStep: z
    .boolean()
    .optional()
    .describe(
      'true (default): an elastic *STATIC step of 1e-6 x duration applies loads and held displacements first (creep is off in *STATIC); false: the hold step applies them.',
    ),
  nlgeom: z.boolean().optional().describe('Large displacements in both steps. Default false.'),
  temperature: quantitySchema.describe(
    "Uniform hold temperature { value, unit } (degC, K, degF); the creep law is read at it and must be valid there, e.g. { value: 293, unit: 'K' }.",
  ),
  outputTimes: outputTimesSchema.optional().describe('Result output times in the hold. Default log, 50 times.'),
});

/**
 * @affects doc.analysis.cases[analysisId].creep (replaced; affected: [analysisId])
 * @invariant durations stored in seconds, temperature in K, named defaults stored resolved and listed in the summary; every part has an isotropic
 *   elastic model and a time-hardening creep_norton law valid at the temperature; the case is of type creep with solver calculix
 * @failure unknown / non-creep case -> FEA_ANALYSIS_NOT_FOUND / CRP_CASE_TYPE; other solver -> CRP_SOLVER_UNSUPPORTED; duration <= 0 or not a time ->
 *   CRP_DURATION_INVALID; cetol <= 0 -> CRP_CETOL_INVALID; increments / output / temperature -> CRP_STEP_PARAM_INVALID; no part, or a part without
 *   a creep law -> CRP_LAW_MISSING / CRP_NO_VISCOUS_MATERIAL / CRP_LAW_FORM_UNSUPPORTED; law outside its temperature validity ->
 *   CRP_LAW_OUT_OF_RANGE; orthotropic elasticity -> CRP_ORTHOTROPIC_V2 (all refusals, unchanged doc)
 */
export const setCreepStep = defineCommand({
  name: 'set_creep_step',
  description:
    'Set the creep hold of a creep analysis (create_analysis analysisType=creep, CalculiX): the loads and held displacements of the case act for ' +
    '`duration` at a uniform `temperature` while the Norton law eps_dot = A sigma^n t^m of the part materials (add_material_model creep_norton + ' +
    'define_constitutive_set elastic + creep, makeDefault; any timeUnit, converted to the card seconds) lets the part creep or relax. `cetol` (creep strain error per increment) has ' +
    'no default. preloadStep true writes an elastic *STATIC step first (creep is off there) so the hold starts from the elastic state; the hold clock ' +
    'is the CalculiX total time minus that step. Time hardening (m != 0) counts that step: keep m = 0 or accept the shift. All loads of the case act ' +
    '(every load case summed). Returns affected [analysisId] and states every named default used. Next: set_mesh_controls, add_result_probe ' +
    '(quantity ceeq for the creep strain), check_creep, fea_mesh, fea_solve, creep_report.',
  params: stepSchema,
  run: (doc, params): CommandResult => {
    const command = 'set_creep_step';
    const found = creepCase(doc, command, params.analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const refuse: Refuse = (code, message, path) => refuseCrp(doc, command, code, message, [analysis.id], [path]);
    const resolved = resolve(params, refuse);
    if ('summary' in resolved) return resolved;
    const { spec, defaulted } = resolved;
    if (Object.keys(analysis.parts).length === 0)
      return refuse(
        'CRP_NO_VISCOUS_MATERIAL',
        `analysis '${analysis.id}' has no part: set_part_idealization first, so the creep laws can be checked`,
        'analysisId',
      );
    const blocking = partIssues(doc, analysis, spec.temperature.valueK).find((issue) => issue.severity === 'error');
    if (blocking !== undefined) {
      return refuseCrp(doc, command, blocking.code, blocking.message, blocking.ids, ['analysisId']);
    }
    const duration = `${sig(spec.durationS)} s`;
    return changed(
      withCase(doc, { ...analysis, creep: spec }),
      `set_creep_step: '${analysis.id}' hold ${duration} at ${sig(spec.temperature.valueK)} K, initial increment ${sig(spec.initialIncrementS)} s, cetol ${sig(spec.cetol)}, ${spec.preloadStep ? `preload step ${sig(spec.preloadPeriodS)} s (hold clock starts after it)` : 'no preload step'}, output ${spec.outputTimes.kind === 'log' ? `${spec.outputTimes.count} log-spaced` : `every ${sig(spec.outputTimes.everyS)} s`}${defaulted.length > 0 ? `; defaults: ${defaulted.join(', ')}` : ''}.`,
      [analysis.id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].creep (removed; recorded results go stale through the input hash; affected: [analysisId])
 * @failure unknown / non-creep case -> FEA_ANALYSIS_NOT_FOUND / CRP_CASE_TYPE; no step set -> CRP_NOTHING_TO_DELETE
 */
export const deleteCreepStep = defineCommand({
  name: 'delete_creep_step',
  description:
    'Remove the creep hold of a creep analysis (the case keeps its parts, constraints, loads and mesh controls). Recorded results become stale. Use set_creep_step to set a new one.',
  annotations: { destructive: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, { analysisId }): CommandResult => {
    const command = 'delete_creep_step';
    const found = creepCase(doc, command, analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    if (analysis.creep === undefined)
      return refuseCrp(doc, command, 'CRP_NOTHING_TO_DELETE', `analysis '${analysisId}' has no creep step`, [analysisId], ['analysisId']);
    const { creep, ...rest } = analysis;
    void creep;
    return changed(withCase(doc, rest), `delete_creep_step: removed the creep hold of '${analysisId}'.`, [analysisId]);
  },
});
