/** add_analysis_step: one `*STEP` of a nonlinear_static case (load / displacement control, increments, load-case multipliers). */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { refuseNls } from './codes';
import { controlSchema, isInvalidStep, stepText, toControl, validateStep } from './stepSpec';
import { isRefusal, nonlinearCase, nonlinearOf, withNonlinear } from './settings';

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
    const found = nonlinearCase(doc, 'add_analysis_step', analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const nonlinear = nonlinearOf(analysis);
    if (nonlinear.nlgeom === undefined)
      return refuseNls(
        doc,
        'add_analysis_step',
        'NLS_CONTROLS_UNSET',
        `analysis '${analysisId}' has no nlgeom yet: call set_nonlinear_controls first`,
        [analysisId],
        ['analysisId'],
      );
    const valid = validateStep(doc, analysis, 'add_analysis_step', { name, multipliers, amplitude, control: toControl(control) });
    if (isInvalidStep(valid)) return valid;
    const id = nextId('stp');
    const next = { ...nonlinear, steps: { ...nonlinear.steps, [id]: { id, ...valid.step } }, stepOrder: [...nonlinear.stepOrder, id] };
    return changed(
      withNonlinear(doc, analysis, next),
      `add_analysis_step: '${id}' (${name}) is step ${next.stepOrder.length} of '${analysisId}': ${stepText(valid.step.control)}; multipliers ${JSON.stringify(multipliers)}, ${amplitude}.${valid.warning}`,
      [id],
    );
  },
});
