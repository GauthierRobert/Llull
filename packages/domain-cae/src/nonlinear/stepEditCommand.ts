/** update_analysis_step and delete_analysis_step: edit or remove one `*STEP` of a nonlinear_static case. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisIdSchema } from '../shared/schemas';
import { refuseNls } from './codes';
import { isRefusal, nonlinearCase, nonlinearOf, withNonlinear } from './settings';
import { controlSchema, isInvalidStep, stepText, toControl, validateStep } from './stepSpec';

const stepIdSchema = z
  .string()
  .describe('Id of the step (affected[0] of add_analysis_step, e.g. stp-9.1); list the steps with describe_analysis.');

/**
 * @affects doc.analysis.cases[analysisId].nonlinear.steps[stepId] (replaced in place, same id and position; affected: [stepId])
 * @invariant only the fields given change; the merged step passes the add_analysis_step validation; a change other than the name turns the recorded results stale (input hash); a name-only edit keeps them
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; unknown step -> NLS_STEP_NOT_FOUND; no field
 *   given, bad increments / multipliers -> NLS_CONTROL_INVALID; arc_length -> NLS_ARC_LENGTH_UNSUPPORTED; unknown load case -> NLS_LOAD_CASE_UNKNOWN;
 *   unresolved displacement target -> FEA_TARGET_UNRESOLVED / FEA_PART_NOT_IN_ANALYSIS (refusals, unchanged doc)
 */
export const updateAnalysisStep = defineCommand({
  name: 'update_analysis_step',
  description:
    'Edit one step of a nonlinear_static analysis in place (same id, same position). Give only the fields to change: name; multipliers ' +
    '(REPLACES the whole load-case -> end-of-step multiplier record of the step); amplitude "ramp" | "step"; control (REPLACES the whole control: ' +
    '{ kind: "load", ...increments } or { kind: "displacement", target, dof, value, ...increments }, same rules as add_analysis_step; arc_length is ' +
    'refused). The edited step is validated like a new one. A change of multipliers, amplitude or control makes the recorded results stale (run fea_mesh and fea_solve again); a name-only edit keeps them (names are presentation).',
  params: z.object({
    analysisId: analysisIdSchema,
    stepId: stepIdSchema,
    name: z.string().min(1).optional().describe('New display name of the step.'),
    multipliers: z
      .record(z.string(), z.number())
      .optional()
      .describe('New load-case name -> multiplier record at the END of the step; replaces the old one entirely ({} = no load change).'),
    amplitude: z
      .enum(['ramp', 'step'])
      .optional()
      .describe('New amplitude: "ramp" (linear over the step) or "step" (full value from the first increment).'),
    control: controlSchema
      .optional()
      .describe(
        'New control, replacing the old one entirely: { kind: "load", ...increments } or { kind: "displacement", target, dof, value, ...increments }.',
      ),
  }),
  run: (doc, { analysisId, stepId, name, multipliers, amplitude, control }): CommandResult => {
    const found = nonlinearCase(doc, 'update_analysis_step', analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const nonlinear = nonlinearOf(analysis);
    const current = Object.hasOwn(nonlinear.steps, stepId) ? nonlinear.steps[stepId] : undefined;
    if (current === undefined)
      return refuseNls(
        doc,
        'update_analysis_step',
        'NLS_STEP_NOT_FOUND',
        `'${analysisId}' has no step '${stepId}' (steps: ${nonlinear.stepOrder.join(', ') || 'none'})`,
        [analysisId, stepId],
        ['stepId'],
      );
    if (name === undefined && multipliers === undefined && amplitude === undefined && control === undefined)
      return refuseNls(
        doc,
        'update_analysis_step',
        'NLS_CONTROL_INVALID',
        'nothing to update: give at least one of name, multipliers, amplitude, control',
        [analysisId, stepId],
        ['name'],
      );
    const valid = validateStep(doc, analysis, 'update_analysis_step', {
      name: name ?? current.name,
      multipliers: multipliers ?? current.multipliers,
      amplitude: amplitude ?? current.amplitude,
      control: control === undefined ? current.control : toControl(control),
    });
    if (isInvalidStep(valid)) return valid;
    const next = { ...nonlinear, steps: { ...nonlinear.steps, [stepId]: { id: stepId, ...valid.step } } };
    return changed(
      withNonlinear(doc, analysis, next),
      `update_analysis_step: '${stepId}' of '${analysisId}' is now '${valid.step.name}': ${stepText(valid.step.control)}; multipliers ${JSON.stringify(valid.step.multipliers)}, ${valid.step.amplitude}.${valid.warning}`,
      [stepId],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].nonlinear.steps / stepOrder (removes 1 step; affected: [stepId]); later steps keep their ids and shift up
 * @invariant a case left without a step stays valid data (check_nonlinear reports NLS_NO_STEPS); the recorded results turn stale
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; unknown step -> NLS_STEP_NOT_FOUND
 */
export const deleteAnalysisStep = defineCommand({
  name: 'delete_analysis_step',
  description:
    'Remove one step from a nonlinear_static analysis. The later steps keep their ids and now start from the multipliers reached by the ' +
    'previous remaining step (load-case multipliers carry over). Recorded results turn stale: run fea_mesh and fea_solve again. A case ' +
    'without any step is reported by check_nonlinear (NLS_NO_STEPS) until add_analysis_step.',
  annotations: { destructive: true },
  params: z.object({ analysisId: analysisIdSchema, stepId: stepIdSchema }),
  run: (doc, { analysisId, stepId }): CommandResult => {
    const found = nonlinearCase(doc, 'delete_analysis_step', analysisId);
    if (isRefusal(found)) return found;
    const nonlinear = nonlinearOf(found.analysis);
    if (!nonlinear.stepOrder.includes(stepId))
      return refuseNls(
        doc,
        'delete_analysis_step',
        'NLS_STEP_NOT_FOUND',
        `'${analysisId}' has no step '${stepId}' (steps: ${nonlinear.stepOrder.join(', ') || 'none'})`,
        [analysisId, stepId],
        ['stepId'],
      );
    const steps = Object.fromEntries(Object.entries(nonlinear.steps).filter(([id]) => id !== stepId));
    const stepOrder = nonlinear.stepOrder.filter((id) => id !== stepId);
    return changed(
      withNonlinear(doc, found.analysis, { ...nonlinear, steps, stepOrder }),
      `delete_analysis_step: removed '${stepId}' from '${analysisId}' (${stepOrder.length} step(s) left).`,
      [stepId],
    );
  },
});
