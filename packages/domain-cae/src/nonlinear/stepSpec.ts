/** Control schema and validation shared by add_analysis_step and update_analysis_step. */

import type { AnalysisCase, AnalysisStep, SolutionControl } from '@core/model/analysis';
import { z } from '@core/commands/schema';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { feaTargetSchema, targetDistanceWarning, targetProblem, toTarget } from '../shared/target';
import { refuseNls } from './codes';

const incrementShape = {
  initialIncrement: z.number().describe('First increment as a fraction of the step time (step time = 1), > 0, e.g. 0.05.'),
  minIncrement: z.number().describe('Smallest increment the solver may cut back to, fraction of the step time, > 0, <= initialIncrement.'),
  maxIncrement: z.number().describe('Largest increment, fraction of the step time, >= initialIncrement and <= 1.'),
  maxIncrements: z
    .number()
    .int()
    .describe('Most increments the step may take (*STEP INC); the run stops with an error when reached. >= 1.'),
};

export const controlSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('load').describe('Load control.'), ...incrementShape })
    .describe('Load control: the load-case multipliers of the step ramp up over the step.'),
  z
    .object({
      kind: z.literal('displacement').describe('Displacement control.'),
      target: feaTargetSchema.describe('Faces / edges / points whose nodes are driven (usually a loaded face).'),
      dof: z.enum(['ux', 'uy', 'uz']).describe('Translational direction that is prescribed.'),
      value: z
        .number()
        .describe(
          'Displacement of the target nodes at the END of the step, in DOCUMENT length units (signed); ramps from the previous step value.',
        ),
      ...incrementShape,
    })
    .describe('Displacement control: prescribes the target displacement (it can follow a load peak, load control cannot).'),
  z
    .object({
      kind: z.literal('arc_length').describe('Arc-length control (refused on CalculiX).'),
      initialArcLength: z.number().describe('Initial arc length (not available on CalculiX).'),
      maxSteps: z.number().int().describe('Maximum arc-length steps (not available on CalculiX).'),
    })
    .describe('Arc-length (Riks) control: REFUSED, CalculiX has no such procedure.'),
]);

export type ControlInput = z.output<typeof controlSchema>;

/** Stored control of a validated control input (the target selectors become a plain FeaTarget). */
export const toControl = (control: ControlInput): SolutionControl =>
  control.kind === 'displacement' ? { ...control, target: toTarget(control.target) } : control;

/** Problem text when the increments are not 0 < min <= initial <= max <= 1 with maxIncrements >= 1, else null. */
function incrementProblem(control: Extract<SolutionControl, { readonly initialIncrement: number }>): string | null {
  const { initialIncrement: initial, minIncrement: min, maxIncrement: max, maxIncrements } = control;
  const finite = [initial, min, max].every(Number.isFinite);
  if (!finite || !(min > 0 && min <= initial && initial <= max && max <= 1))
    return `increments must satisfy 0 < minIncrement (${min}) <= initialIncrement (${initial}) <= maxIncrement (${max}) <= 1`;
  return maxIncrements >= 1 ? null : `maxIncrements (${maxIncrements}) must be >= 1`;
}

/** Load cases named by the loads of the case (the multiplier keys). */
const loadCaseNames = (analysis: AnalysisCase): Set<string> =>
  new Set(analysis.loadOrder.flatMap((id) => (analysis.loads[id] === undefined ? [] : [analysis.loads[id].loadCase])));

export interface ValidStep {
  readonly step: Omit<AnalysisStep, 'id'>;
  /** Text appended to the summary when the displacement target is far from the geometry ('' otherwise). */
  readonly warning: string;
}

/**
 * The step `name` / `multipliers` / `amplitude` / `control` as it is stored, or the coded refusal of `command`.
 * @failure arc_length -> NLS_ARC_LENGTH_UNSUPPORTED; bad increments / non-finite value or multiplier -> NLS_CONTROL_INVALID; unknown load case ->
 *   NLS_LOAD_CASE_UNKNOWN; displacement target missing / not a part -> FEA_TARGET_UNRESOLVED / FEA_PART_NOT_IN_ANALYSIS
 */
export function validateStep(
  doc: CadDocument,
  analysis: AnalysisCase,
  command: string,
  input: {
    readonly name: string;
    readonly multipliers: Readonly<Record<string, number>>;
    readonly amplitude: 'ramp' | 'step';
    readonly control: SolutionControl;
  },
): ValidStep | CommandResult {
  const { name, multipliers, amplitude, control } = input;
  const analysisId = analysis.id;
  const fail = (code: string, message: string, ids: readonly string[] = [analysisId], paths: readonly string[] = []): CommandResult =>
    refuseNls(doc, command, code, message, ids, paths);
  if (control.kind === 'arc_length')
    return fail(
      'NLS_ARC_LENGTH_UNSUPPORTED',
      `step '${name}': solver ${analysis.solver} has no arc-length / Riks procedure`,
      [analysisId],
      ['control.kind'],
    );
  const problem = incrementProblem(control);
  if (problem !== null) return fail('NLS_CONTROL_INVALID', `step '${name}': ${problem}`, [analysisId], ['control']);
  if (control.kind === 'displacement' && !Number.isFinite(control.value))
    return fail('NLS_CONTROL_INVALID', `step '${name}': displacement value must be finite`, [analysisId], ['control.value']);
  const known = loadCaseNames(analysis);
  for (const [loadCase, value] of Object.entries(multipliers)) {
    if (!known.has(loadCase))
      return fail(
        'NLS_LOAD_CASE_UNKNOWN',
        `load case '${loadCase}' has no load in '${analysisId}' (load cases: ${[...known].join(', ') || 'none'})`,
        [analysisId],
        [`multipliers.${loadCase}`],
      );
    if (!Number.isFinite(value))
      return fail('NLS_CONTROL_INVALID', `multiplier of '${loadCase}' must be finite`, [analysisId], [`multipliers.${loadCase}`]);
  }
  const target = control.kind === 'displacement' ? control.target : undefined;
  const targetIssue = target === undefined ? null : targetProblem(doc, analysis, target);
  if (target !== undefined && targetIssue !== null)
    return fail(targetIssue.code, `step '${name}': ${targetIssue.message}`, [analysisId, target.entityId], ['control.target']);
  return { step: { name, multipliers, amplitude, control }, warning: target === undefined ? '' : targetDistanceWarning(doc, target) };
}

export const isInvalidStep = (value: ValidStep | CommandResult): value is CommandResult => 'summary' in value;

/** `displacement control ux = 0.01 on 'ent-1'`, `load control` ... plus the increment text, for summaries. */
export function stepText(control: SolutionControl): string {
  const driver =
    control.kind === 'displacement'
      ? `displacement control ${control.dof} = ${control.value} on '${control.target.entityId}'`
      : `${control.kind} control`;
  const increments =
    control.kind === 'arc_length'
      ? ''
      : `, increments ${control.initialIncrement}/${control.minIncrement}/${control.maxIncrement} (initial/min/max), at most ${control.maxIncrements}`;
  return `${driver}${increments}`;
}
