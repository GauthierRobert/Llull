/** PHY-05 §5.1 deck sections of a nonlinear_static case: amplitudes, one `*STEP` per analysis step, controls, output and print requests. */

import type { AnalysisStep, ConvergencePreset, NonlinearSettings } from '@core/model/analysis';
import { findSet, setMembers } from '@core/model/materialLaws/combination';
import { isDeckRefusal, safeName, type DeckContext, type DeckRefusal, type DeckSections } from '../decks/context';
import { commentText, linesText, num, row } from '../decks/format';
import { mechanicalStepLines } from '../decks/mechanical';
import { partSetId } from '../decks/constitutive';
import { FIELD_KEYS, TIME_KEYS, nonlinearValueProblems } from './shape';
import { hyperelasticParts } from './settings';
import { multiplierHistory } from './history';

const DOF_NUMBER = { ux: 1, uy: 2, uz: 3 } as const;

const refuse = (code: string, message: string, ids: readonly string[] = []): DeckRefusal => ({ code, message, ids });

const hasNodes = (ctx: DeckContext, key: string): boolean => (ctx.mesh.nodeSets[key]?.length ?? 0) > 0;

/**
 * Refusal when the case cannot be written: nlgeom unstated, no step, one material used with two different sets, an elastic-only override
 * of a default that has more, a probe pointing at a deleted load / constraint, or a driven / probed target the mesh did not resolve.
 */
function problem(ctx: DeckContext, nonlinear: NonlinearSettings): DeckRefusal | null {
  const id = ctx.analysisId;
  if (nonlinear.nlgeom === undefined)
    return refuse('NLS_NLGEOM_UNSET', `analysis '${id}' has no nlgeom: call set_nonlinear_controls`, [id]);
  const invalid = nonlinearValueProblems(nonlinear, 'nonlinear')[0];
  if (invalid !== undefined) return refuse('NLS_CONTROL_INVALID', invalid, [id]);
  const hyper = nonlinear.nlgeom ? [] : hyperelasticParts(ctx.doc, ctx.analysis, nonlinear.constitutiveSets);
  if (hyper.length > 0)
    return refuse(
      'NLS_CONTROL_INVALID',
      `nlgeom is false but part(s) ${hyper.join(', ')} use a hyperelastic set (CalculiX forces NLGEOM)`,
      [id, ...hyper],
    );
  if (nonlinear.stepOrder.length === 0) return refuse('NLS_NO_STEPS', `analysis '${id}' has no step: add_analysis_step`, [id]);
  const setOfMaterial = new Map<string, string | undefined>();
  for (const entityId of Object.keys(ctx.analysis.parts)) {
    const material = ctx.materialOf(entityId);
    const materialId = ctx.materialId(entityId);
    if (material === null || materialId === undefined) continue;
    const chosen = partSetId(ctx, entityId, material.defaultConstitutiveSet);
    if (Object.hasOwn(nonlinear.constitutiveSets, entityId) && findSet(material.constitutiveSets, chosen) === undefined)
      return refuse('NLS_MATERIAL_MODEL_MISSING', `part '${entityId}': constitutive set '${chosen}' no longer exists on '${materialId}'`, [
        entityId,
      ]);
    if (setOfMaterial.has(materialId) && setOfMaterial.get(materialId) !== chosen)
      return refuse('NLS_MATERIAL_SET_CONFLICT', `parts sharing material '${materialId}' select different constitutive sets`, [entityId]);
    setOfMaterial.set(materialId, chosen);
    const set = findSet(material.constitutiveSets, chosen);
    const slots = set === undefined ? {} : setMembers(set, material.materialModels ?? []);
    if (
      chosen !== material.defaultConstitutiveSet &&
      Object.keys(slots).every((slot) => slot === 'elastic') &&
      Object.keys(slots).length > 0
    )
      return refuse(
        'NLS_MATERIAL_SET_CONFLICT',
        `part '${entityId}': set '${chosen}' is elastic-only but not the default of '${materialId}'; make it the default (define_constitutive_set makeDefault)`,
        [entityId],
      );
  }
  for (const stepId of nonlinear.stepOrder) {
    const control = nonlinear.steps[stepId]?.control;
    if (control?.kind === 'arc_length')
      return refuse('NLS_ARC_LENGTH_UNSUPPORTED', `step '${stepId}': CalculiX has no arc-length / Riks procedure`, [stepId]);
    if (control?.kind === 'displacement' && !hasNodes(ctx, `S_${stepId}`))
      return refuse('FEA_TARGET_UNRESOLVED', `step '${stepId}': the displacement target has no nodes in the mesh`, [stepId]);
  }
  for (const probeId of nonlinear.probeOrder) {
    const probe = nonlinear.probes[probeId];
    if (probe === undefined) continue;
    if (probe.load.kind === 'load' && !Object.hasOwn(ctx.analysis.loads, probe.load.loadId))
      return refuse('NLS_PROBE_REFERENCE_UNKNOWN', `curve probe '${probeId}': load '${probe.load.loadId}' no longer exists`, [probeId]);
    if (probe.load.kind === 'reaction' && !Object.hasOwn(ctx.analysis.constraints, probe.load.constraintId))
      return refuse('NLS_PROBE_REFERENCE_UNKNOWN', `curve probe '${probeId}': constraint '${probe.load.constraintId}' no longer exists`, [
        probeId,
      ]);
    if (probe.load.kind === 'reaction' && !hasNodes(ctx, `C_${probe.load.constraintId}`))
      return refuse('FEA_TARGET_UNRESOLVED', `curve probe '${probeId}': constraint '${probe.load.constraintId}' has no nodes in the mesh`, [
        probeId,
      ]);
    if (!hasNodes(ctx, `N_${probeId}`))
      return refuse('FEA_TARGET_UNRESOLVED', `curve probe '${probeId}': no mesh node near its point`, [probeId]);
  }
  return null;
}

/** `*CONTROLS` cards of a custom convergence preset: values in the CalculiX column order, unset ones left blank (solver default). */
function controlLines(preset: ConvergencePreset): string[] {
  if (preset.name !== 'custom') return [];
  const line = (keys: readonly string[], values: Readonly<Record<string, number | undefined>> | undefined): string => {
    const cells = keys.map((key) => (values?.[key] === undefined ? '' : num(values[key])));
    while (cells.length > 0 && cells.at(-1) === '') cells.pop();
    return row(...cells);
  };
  const lines: string[] = [];
  if (preset.field !== undefined) lines.push('*CONTROLS, PARAMETERS=FIELD', line(FIELD_KEYS, preset.field));
  if (preset.timeIncrementation !== undefined)
    lines.push('*CONTROLS, PARAMETERS=TIME INCREMENTATION', line(TIME_KEYS, preset.timeIncrementation));
  return lines;
}

/** `FREQUENCY` parameter text (with leading comma) of the output requests of one step. */
function frequency(nonlinear: NonlinearSettings, step: AnalysisStep): string {
  const { outputIncrements } = nonlinear;
  if (outputIncrements === 'all') return '';
  const every =
    outputIncrements === 'last_per_step'
      ? step.control.kind === 'arc_length'
        ? 1
        : step.control.maxIncrements + 1
      : outputIncrements.every;
  return every <= 1 ? '' : `, FREQUENCY=${every}`;
}

/** Identity of what a step drives: displacement steps on the same target and dof continue it (the value ramps), anything else is a different drive. */
const driveOf = (step: AnalysisStep | undefined): string | null =>
  step?.control.kind === 'displacement' ? JSON.stringify([step.control.target, step.control.dof]) : null;

/** A displacement drive persists into later steps: when the next step drives something else (or nothing) the constraints are restated with OP=NEW. */
const needsReset = (previous: AnalysisStep | undefined, step: AnalysisStep): boolean => {
  const before = driveOf(previous);
  return before !== null && before !== driveOf(step);
};

const amplitudeName = (step: AnalysisStep): string => `A_${safeName(step.id)}`;

/** `*NODE PRINT` requests of the curve probes: displacement of the nearest node, summed reaction (`TOTALS=ONLY`) of the constraint nodes. */
function printLines(ctx: DeckContext, nonlinear: NonlinearSettings, rate: string): string[] {
  const lines: string[] = [];
  const written = new Set<string>();
  const once = (key: string, header: string, component: string): void => {
    if (written.has(`${key}:${component}`)) return;
    written.add(`${key}:${component}`);
    lines.push(header, component);
  };
  for (const probeId of nonlinear.probeOrder) {
    const probe = nonlinear.probes[probeId];
    if (probe === undefined) continue;
    once(`N_${probeId}`, `*NODE PRINT, NSET=${ctx.nset(`N_${probeId}`)}${rate}`, 'U');
    if (probe.load.kind === 'reaction')
      once(`C_${probe.load.constraintId}`, `*NODE PRINT, NSET=${ctx.nset(`C_${probe.load.constraintId}`)}, TOTALS=ONLY${rate}`, 'RF');
  }
  return lines;
}

/**
 * The nonlinear static procedure: one `*STEP[, NLGEOM], INC=<maxIncrements>` per analysis step with `*STATIC` automatic incrementation
 * (`initial, 1, min, max`), the constraints in step 1, loads as `*CLOAD` / `*DLOAD` scaled by the step multipliers (modified in place so they ramp from
 * the previous step value, or with a `step` amplitude from the first increment), `*BOUNDARY` on the displacement-controlled target,
 * `*NODE FILE U, RF`, `*EL FILE S, E, PEEQ` and the curve-probe prints. Results of analysis step n are CalculiX step n.
 * @invariant a case without `nonlinear` is never written here; pure and byte-deterministic
 * @failure NLS_NLGEOM_UNSET, NLS_NO_STEPS, NLS_MATERIAL_SET_CONFLICT, NLS_PROBE_REFERENCE_UNKNOWN, FEA_TARGET_UNRESOLVED; mechanical refusals
 */
export function nonlinearSteps(ctx: DeckContext): DeckSections {
  const { nonlinear } = ctx.analysis;
  if (nonlinear === undefined)
    return refuse('NLS_NLGEOM_UNSET', `analysis '${ctx.analysisId}' has no nonlinear settings`, [ctx.analysisId]);
  const refusal = problem(ctx, nonlinear);
  if (refusal !== null) return refusal;
  const steps = nonlinear.stepOrder.flatMap((id) => (nonlinear.steps[id] === undefined ? [] : [nonlinear.steps[id]]));
  const history = multiplierHistory(nonlinear);
  const lines: string[] = [];
  for (const step of steps.filter((entry) => entry.amplitude === 'step'))
    lines.push(`*AMPLITUDE, NAME=${amplitudeName(step)}`, row(0, 1, 1, 1));
  for (const [index, step] of steps.entries()) {
    const control = step.control;
    if (control.kind === 'arc_length') continue;
    const end = history[index]?.end ?? {};
    const mechanical = mechanicalStepLines(ctx, undefined, {
      scale: (load) => end[load.loadCase] ?? 0,
      parameters: step.amplitude === 'step' ? `, AMPLITUDE=${amplitudeName(step)}` : '',
      boundary: index === 0 || needsReset(steps[index - 1], step),
    });
    if (isDeckRefusal(mechanical)) return mechanical;
    const rate = frequency(nonlinear, step);
    lines.push(`** step ${commentText(step.id)} ${commentText(step.name)}`);
    lines.push(`*STEP${nonlinear.nlgeom === true ? ', NLGEOM' : ''}, INC=${control.maxIncrements}`);
    lines.push('*STATIC', row(control.initialIncrement, 1, control.minIncrement, control.maxIncrement));
    lines.push(...controlLines(nonlinear.convergence));
    lines.push(...mechanical.text.split('\n').filter((line) => line !== ''));
    if (control.kind === 'displacement') {
      const dof = DOF_NUMBER[control.dof];
      lines.push(`*BOUNDARY${step.amplitude === 'step' ? `, AMPLITUDE=${amplitudeName(step)}` : ''}`);
      lines.push(row(ctx.nset(`S_${step.id}`), dof, dof, control.value * ctx.lengthToAnalysis));
    }
    lines.push(`*NODE FILE${rate}`, 'U, RF', `*EL FILE${rate}`, 'S, E, PEEQ', ...printLines(ctx, nonlinear, rate), '*END STEP');
  }
  return { text: linesText(lines) };
}
