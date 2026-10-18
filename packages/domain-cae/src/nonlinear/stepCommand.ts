/** add_analysis_step: one `*STEP` of a nonlinear_static case (load / displacement control, increments, load-case multipliers). */

import type { AnalysisCase, SolutionControl } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { feaTargetSchema, targetDistanceWarning, targetProblem, toTarget } from '../shared/target';
import { refuseNls } from './codes';
import { isRefusal, nonlinearCase, nonlinearOf, withNonlinear } from './settings';

const incrementShape = {
  initialIncrement: z.number().describe('First increment as a fraction of the step time (step time = 1), > 0, e.g. 0.05.'),
  minIncrement: z.number().describe('Smallest increment the solver may cut back to, fraction of the step time, > 0, <= initialIncrement.'),
  maxIncrement: z.number().describe('Largest increment, fraction of the step time, >= initialIncrement and <= 1.'),
  maxIncrements: z
    .number()
    .int()
    .describe('Most increments the step may take (*STEP INC); the run stops with an error when reached. >= 1.'),
};

const controlSchema = z.discriminatedUnion('kind', [
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

type ControlInput = z.output<typeof controlSchema>;

/** Problem text when the increments are not 0 < min <= initial <= max <= 1 with maxIncrements >= 1, else null. */
function incrementProblem(control: Extract<ControlInput, { readonly initialIncrement: number }>): string | null {
  const { initialIncrement: initial, minIncrement: min, maxIncrement: max, maxIncrements } = control;
  const finite = [initial, min, max].every(Number.isFinite);
  if (!finite || !(min > 0 && min <= initial && initial <= max && max <= 1))
    return `increments must satisfy 0 < minIncrement (${min}) <= initialIncrement (${initial}) <= maxIncrement (${max}) <= 1`;
  return maxIncrements >= 1 ? null : `maxIncrements (${maxIncrements}) must be >= 1`;
}

/** Load cases named by the loads of the case (the multiplier keys). */
const loadCaseNames = (analysis: AnalysisCase): Set<string> =>
  new Set(analysis.loadOrder.flatMap((id) => (analysis.loads[id] === undefined ? [] : [analysis.loads[id].loadCase])));

/**
 * @affects doc.analysis.cases[analysisId].nonlinear.steps (adds 1 step, id `stp-<step>.<k>`, appended to stepOrder; affected: [stepId])
 * @invariant steps run in creation order, each of step time 1; a load case absent from multipliers keeps its previous value (0 in the first step)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; nlgeom not stated -> NLS_CONTROLS_UNSET;
 *   arc_length -> NLS_ARC_LENGTH_UNSUPPORTED; bad increments / non-finite value or multiplier -> NLS_CONTROL_INVALID; unknown load case ->
 *   NLS_LOAD_CASE_UNKNOWN; displacement target missing / not a part -> FEA_TARGET_UNRESOLVED / FEA_PART_NOT_IN_ANALYSIS (refusals, unchanged doc)
 */
export const addAnalysisStep = defineCommand({
  name: 'add_analysis_step',
  description:
    'Append a step to a nonlinear_static analysis (needs set_nonlinear_controls first). Each step has step time 1 and is one CalculiX ' +
    '*STEP with *STATIC automatic incrementation. multipliers: factor per LOAD CASE (the loadCase of add_fea_load) reached at the END of ' +
    'the step, ramped from the previous value; a load case you leave out keeps its previous value (0 in the first step), 0 removes it, so ' +
    'load -> unload -> reload is three steps. amplitude: "ramp" (default, linear over the step) or "step" (full value from the first ' +
    'increment). control.kind "load": loads ramp, with increments { initialIncrement, minIncrement, maxIncrement, maxIncrements } as ' +
    'fractions of the step time. control.kind "displacement": also prescribes target (faces/points) + dof + value (document length units, ' +
    'at the end of the step); use it to trace past a load peak (limit load of a perfectly plastic part). "arc_length" is refused: ' +
    'CalculiX has no Riks procedure. Returns the step id in affected[0].',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name of the step, e.g. "push" or "unload".'),
    multipliers: z
      .record(z.string(), z.number())
      .describe('Load-case name -> multiplier on the load values at the END of the step (e.g. { LC1: 166 }); {} = no load change.'),
    amplitude: z.enum(['ramp', 'step']).optional().describe('"ramp" (default) or "step" (full multiplier from the first increment).'),
    control: controlSchema.describe(
      'How the step is driven: { kind: "load", ...increments } or { kind: "displacement", target, dof, value, ...increments } (arc_length is refused).',
    ),
  }),
  run: (doc, { analysisId, name, multipliers, amplitude = 'ramp', control }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId], paths: readonly string[] = []): CommandResult =>
      refuseNls(doc, 'add_analysis_step', code, message, ids, paths);
    const found = nonlinearCase(doc, 'add_analysis_step', analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const nonlinear = nonlinearOf(analysis);
    if (nonlinear.nlgeom === undefined)
      return fail(
        'NLS_CONTROLS_UNSET',
        `analysis '${analysisId}' has no nlgeom yet: call set_nonlinear_controls first`,
        [analysisId],
        ['analysisId'],
      );
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
    const target = control.kind === 'displacement' ? toTarget(control.target) : undefined;
    const targetIssue = target === undefined ? null : targetProblem(doc, analysis, target);
    if (target !== undefined && targetIssue !== null)
      return fail(targetIssue.code, `step '${name}': ${targetIssue.message}`, [analysisId, target.entityId], ['control.target']);
    const warning = target === undefined ? '' : targetDistanceWarning(doc, target);
    const stored: SolutionControl = control.kind === 'load' ? control : { ...control, target: toTarget(control.target) };
    const id = nextId('stp');
    const next = {
      ...nonlinear,
      steps: { ...nonlinear.steps, [id]: { id, name, multipliers, amplitude, control: stored } },
      stepOrder: [...nonlinear.stepOrder, id],
    };
    const driver =
      stored.kind === 'displacement'
        ? `displacement control ${stored.dof} = ${stored.value} on '${stored.target.entityId}'`
        : `${stored.kind} control`;
    const increments = `, increments ${stored.initialIncrement}/${stored.minIncrement}/${stored.maxIncrement} (initial/min/max), at most ${stored.maxIncrements}`;
    return changed(
      withNonlinear(doc, analysis, next),
      `add_analysis_step: '${id}' (${name}) is step ${next.stepOrder.length} of '${analysisId}': ${driver}${increments}; multipliers ${JSON.stringify(multipliers)}, ${amplitude}.${warning}`,
      [id],
    );
  },
});
