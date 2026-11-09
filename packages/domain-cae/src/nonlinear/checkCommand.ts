/** check_nonlinear: readiness and guardrails of a nonlinear_static case (PHY-05 FR-NLS-10, TR §7.1). */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { toMetres } from '@core/model/units';
import { analysisLengthMetres } from '../shared/defaults';
import { maxOverNodes } from '../results/fields';
import { permanentSetOf, permanentSetVerdict } from './permanentSet';
import { estimatedRotation } from './smallDeformation';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { NOT_APPROVED } from '../contact/codes';
import { analysisIdSchema } from '../shared/schemas';
import { trustedRecord } from '../shared/trust';
import type { NonlinearCheckItem } from './check';
import { nlsRemediation } from './codes';
import { snapBackDetected, unloadingStep } from './curveRules';
import { extractCurves } from './curves';
import { unverifiedReasons } from './limitLoadQuery';
import { isRefusal, nonlinearCase } from './settings';

const item = (code: string, message: string, ids: readonly string[], severity: 'error' | 'warning' = 'warning'): NonlinearCheckItem => ({
  code,
  severity,
  ids,
  message,
  remediation: nlsRemediation(code),
});

/** The `check_analysis` items (parts, supports, mesh, stale results and the nonlinear set-up items), composed through `execute`. */
function baseItems(doc: CadDocument, analysisId: string, ctx: ExecutionContext | undefined): NonlinearCheckItem[] {
  const items = (execute(doc, 'check_analysis', { analysisId }, ctx).data as { items?: readonly NonlinearCheckItem[] } | undefined)?.items;
  return items === undefined ? [] : [...items];
}

/** Warnings that need no solved results: unverified material data, nlgeom off without a threshold, an unloading step without a permanent-set limit. */
function setupWarnings(doc: CadDocument, analysis: AnalysisCase): NonlinearCheckItem[] {
  const nonlinear = analysis.nonlinear;
  const items: NonlinearCheckItem[] = [];
  const reasons = unverifiedReasons(doc, analysis);
  if (reasons.length > 0)
    items.push(item('NLS_MATERIAL_MODEL_UNVERIFIED', `material data is unverified: ${reasons.join('; ')}`, Object.keys(analysis.parts)));
  const limits = nonlinear?.thresholds;
  if (nonlinear?.nlgeom === false && limits?.smallRotation === undefined && limits?.strain === undefined)
    items.push(
      item(
        'NLS_THRESHOLD_UNSET',
        'nlgeom is false and no small-rotation / strain threshold is stated to judge it (set_nonlinear_controls thresholds, with a source)',
        [analysis.id],
      ),
    );
  const unload = nonlinear === undefined ? undefined : unloadingStep(nonlinear);
  if (unload !== undefined && limits?.permanentDisplacement === undefined && limits?.permanentPeeq === undefined)
    items.push(
      item(
        'NLS_PERMANENT_SET_THRESHOLD_UNSET',
        `step '${unload}' unloads the case but no permanent-set limit is stated (set_nonlinear_controls thresholds)`,
        [unload],
      ),
    );
  return items;
}

/** Findings against the stated thresholds on verified results: permanent set exceeded (error) and nlgeom false beyond the small-deformation limits (warning). */
function thresholdItems(doc: CadDocument, analysis: AnalysisCase, mesh: FeMeshArtifact, results: FeResultsArtifact): NonlinearCheckItem[] {
  const nonlinear = analysis.nonlinear;
  if (nonlinear === undefined) return [];
  const items: NonlinearCheckItem[] = [];
  const set = permanentSetOf(nonlinear, mesh, results);
  if (set !== null) {
    const verdict = permanentSetVerdict(set, nonlinear.thresholds, toMetres(doc, 1) / analysisLengthMetres(analysis.unitSystem));
    if (verdict.displacementExceeded === true || verdict.peeqExceeded === true)
      items.push(
        item(
          'NLS_PERMANENT_SET_EXCEEDED',
          `residual state after '${set.stepId}' exceeds the stated limit: displacement ${set.maxDisplacement?.value ?? 'n/a'} (limit ${nonlinear.thresholds?.permanentDisplacement?.value ?? 'none'} document units), equivalent plastic strain ${set.maxPeeq?.value ?? 'n/a'} (limit ${nonlinear.thresholds?.permanentPeeq?.value ?? 'none'}); a qualified reviewer decides`,
          [set.stepId],
          'error',
        ),
      );
  }
  if (nonlinear.nlgeom === false) {
    const rotation = estimatedRotation(mesh, results);
    const peeq = results.steps.reduce(
      (best, step) => Math.max(best, maxOverNodes(step.fields['PE'], (values) => values[0] ?? 0)?.value ?? 0),
      0,
    );
    const { smallRotation, strain } = nonlinear.thresholds ?? {};
    const reasons = [
      ...(smallRotation !== undefined && rotation !== null && rotation > smallRotation.value
        ? [
            `estimated rotation ${rotation} rad (atan of the largest displacement over the largest part extent, an estimate) exceeds ${smallRotation.value} rad`,
          ]
        : []),
      ...(strain !== undefined && peeq > strain.value ? [`equivalent plastic strain ${peeq} exceeds ${strain.value}`] : []),
    ];
    if (reasons.length > 0) items.push(item('NLS_NLGEOM_RECOMMENDED', `nlgeom is false but ${reasons.join('; ')}`, [analysis.id]));
  }
  return items;
}

/**
 * @affects nothing (read-only query; data = status, state, items, notes, reviewRequired)
 * @invariant the check_analysis items first (they include the nonlinear set-up items NLS_NLGEOM_UNSET, NLS_NO_STEPS, NLS_ARC_LENGTH_UNSUPPORTED,
 *   NLS_MATERIAL_MODEL_MISSING, NLS_PROBE_REFERENCE_UNKNOWN, NLS_IMPERFECTION_MISSING ...), then warnings (NLS_MATERIAL_MODEL_UNVERIFIED,
 *   NLS_THRESHOLD_UNSET, NLS_PERMANENT_SET_THRESHOLD_UNSET) and, on verified results, NLS_SNAP_BACK_DETECTED;
 *   status fail on any error, warn on warnings only; reviewRequired always
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR (refusals, unchanged doc)
 */
export const checkNonlinear = defineCommand({
  name: 'check_nonlinear',
  description:
    'Check a nonlinear_static analysis end to end and return data { analysisId, state, status pass | warn | fail, items [{ code, severity: error | ' +
    'warning, ids, message, remediation }], notes, reviewRequired: true }: the check_analysis items (parts, supports, mesh, stale results) plus the ' +
    'nonlinear ones - nlgeom not stated (NLS_NLGEOM_UNSET), no step (NLS_NO_STEPS), arc-length step (NLS_ARC_LENGTH_UNSUPPORTED), missing constitutive ' +
    'set (NLS_MATERIAL_MODEL_MISSING), probe pointing at a deleted load / constraint (NLS_PROBE_REFERENCE_UNKNOWN), invalid controls ' +
    '(NLS_CONTROL_INVALID), an NLGEOM case without imperfection next to a solved buckling case of the same part (NLS_IMPERFECTION_MISSING, warning), ' +
    'unverified material data (NLS_MATERIAL_MODEL_UNVERIFIED, warning, not suppressible), nlgeom false without a threshold (NLS_THRESHOLD_UNSET, ' +
    'warning), an unloading step without a permanent-set limit (NLS_PERMANENT_SET_THRESHOLD_UNSET, warning), and, on verified results, the residual state beyond a stated permanent-set limit (NLS_PERMANENT_SET_EXCEEDED, error), nlgeom false beyond a stated small-rotation / strain limit (NLS_NLGEOM_RECOMMENDED, warning) and a snap-back ' +
    'indicator on a displacement-controlled curve (NLS_SNAP_BACK_DETECTED, warning). No threshold is invented: the owner or a company rule supplies ' +
    'them. Run it before fea_mesh / fea_solve and at the end of every job. Always reviewRequired: computed by llull, not approved.',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, { analysisId }, ctx): CommandResult => {
    const found = nonlinearCase(doc, 'check_nonlinear', analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    const trust = trustedRecord(doc, analysis, ctx?.feaArtifacts);
    const notes: string[] = [];
    const resultItems: NonlinearCheckItem[] = [];
    if (trust.state !== 'solved' || trust.resultsArtifact === null || trust.meshArtifact === null || analysis.nonlinear === undefined)
      notes.push(`result checks skipped: no current verified results (state ${trust.state})`);
    else {
      for (const curve of extractCurves(analysis, trust.resultsArtifact))
        if (snapBackDetected(analysis.nonlinear, curve))
          resultItems.push(
            item('NLS_SNAP_BACK_DETECTED', `curve '${curve.name}' turns back on a displacement-controlled step`, [curve.probeId]),
          );
      resultItems.push(...thresholdItems(doc, analysis, trust.meshArtifact, trust.resultsArtifact));
      notes.push('strain-beyond-hardening-curve, elongation and plastic-mesh-adequacy guardrails are not evaluated by this version');
    }
    const items = [...baseItems(doc, analysisId, ctx), ...setupWarnings(doc, analysis), ...resultItems];
    const errors = items.filter((entry) => entry.severity === 'error').length;
    const status = errors > 0 ? 'fail' : items.length > 0 ? 'warn' : 'pass';
    return report(
      doc,
      `check_nonlinear: '${analysisId}' ${status} (${errors} error(s), ${items.length - errors} warning(s)${items.length > 0 ? `: ${[...new Set(items.map((entry) => entry.code))].join(', ')}` : ''}). ${NOT_APPROVED}`,
      { analysisId, state: trust.state, status, items, notes, reviewRequired: true },
    );
  },
});
