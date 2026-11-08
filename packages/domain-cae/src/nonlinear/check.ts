/** Set-up completeness items of a nonlinear_static case (PHY-05 §7.1), appended to `check_analysis`. */

import type { AnalysisCase } from '@core/model/analysis';
import { findSet } from '@core/model/materialLaws/combination';
import type { CadDocument } from '@core/model/types';
import { nlsRemediation } from './codes';
import { hyperelasticParts } from './settings';
import { nonlinearValueProblems } from './shape';
import { imperfectionsOf } from './imperfectionShape';
import { analysisOf } from '../shared/access';
import { stateOf } from '../shared/state';

export interface NonlinearCheckItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const item = (code: string, message: string, ids: readonly string[], severity: 'error' | 'warning' = 'error'): NonlinearCheckItem => ({
  code,
  severity,
  ids,
  message,
  remediation: nlsRemediation(code),
});

/** Solved buckling cases that share at least one part with `analysis` (they hint at buckling-type collapse). */
function solvedBucklingSharingParts(doc: CadDocument, analysis: AnalysisCase): string[] {
  const parts = new Set(Object.keys(analysis.parts));
  return analysisOf(doc)
    .caseOrder.flatMap((caseId) => {
      const other = analysisOf(doc).cases[caseId];
      return other === undefined ? [] : [other];
    })
    .filter(
      (other) => other.type === 'buckling' && Object.keys(other.parts).some((part) => parts.has(part)) && stateOf(doc, other) === 'solved',
    )
    .map((other) => other.id);
}

/**
 * Errors that stop the deck from being written: nlgeom unstated, no step, a part without a resolvable constitutive set, a probe pointing at a
 * deleted load / constraint, an arc-length step; warning NLS_IMPERFECTION_MISSING for an NLGEOM case without imperfection next to a solved buckling
 * case of the same part.
 * @invariant empty for every case that is not nonlinear_static
 */
export function checkNonlinearItems(doc: CadDocument, analysis: AnalysisCase): NonlinearCheckItem[] {
  if (analysis.type !== 'nonlinear_static') return [];
  const nonlinear = analysis.nonlinear;
  const id = analysis.id;
  if (nonlinear === undefined) return [item('NLS_NLGEOM_UNSET', 'no nonlinear controls yet: call set_nonlinear_controls', [id])];
  const items: NonlinearCheckItem[] = [];
  if (nonlinear.nlgeom === undefined) items.push(item('NLS_NLGEOM_UNSET', 'nlgeom is not stated: call set_nonlinear_controls', [id]));
  if (nonlinear.stepOrder.length === 0) items.push(item('NLS_NO_STEPS', 'the analysis has no step: add_analysis_step', [id]));
  for (const stepId of nonlinear.stepOrder)
    if (nonlinear.steps[stepId]?.control.kind === 'arc_length')
      items.push(item('NLS_ARC_LENGTH_UNSUPPORTED', `step '${stepId}' uses arc-length control, which CalculiX does not have`, [stepId]));
  for (const entityId of Object.keys(analysis.parts)) {
    const materialId = doc.entities[entityId]?.materialId;
    const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
    const selected = Object.hasOwn(nonlinear.constitutiveSets, entityId) ? nonlinear.constitutiveSets[entityId] : undefined;
    // a part without a selection keeps the elastic cards of its material (record default set or property models), which the deck accepts
    if (material !== undefined && selected !== undefined && findSet(material.constitutiveSets, selected) === undefined)
      items.push(
        item('NLS_MATERIAL_MODEL_MISSING', `part '${entityId}': constitutive set '${selected}' does not exist on '${materialId}'`, [
          entityId,
        ]),
      );
  }
  const invalid = nonlinearValueProblems(nonlinear, 'nonlinear')[0];
  if (invalid !== undefined) items.push(item('NLS_CONTROL_INVALID', invalid, [id]));
  const hyper = nonlinear.nlgeom === false ? hyperelasticParts(doc, analysis, nonlinear.constitutiveSets) : [];
  if (hyper.length > 0)
    items.push(
      item('NLS_CONTROL_INVALID', `nlgeom is false but part(s) ${hyper.join(', ')} use a hyperelastic set (CalculiX forces NLGEOM)`, [
        id,
        ...hyper,
      ]),
    );
  const buckled = nonlinear.nlgeom === true && imperfectionsOf(nonlinear).length === 0 ? solvedBucklingSharingParts(doc, analysis) : [];
  if (buckled.length > 0)
    items.push(
      item(
        'NLS_IMPERFECTION_MISSING',
        `solved buckling case(s) ${buckled.join(', ')} analyse the same part(s) and this NLGEOM case has no imperfection: a perfect model does not leave the straight path`,
        [id, ...buckled],
        'warning',
      ),
    );
  for (const probeId of nonlinear.probeOrder) {
    const load = nonlinear.probes[probeId]?.load;
    const missing =
      load?.kind === 'load'
        ? !Object.hasOwn(analysis.loads, load.loadId)
        : load !== undefined && !Object.hasOwn(analysis.constraints, load.constraintId);
    if (missing)
      items.push(
        item('NLS_PROBE_REFERENCE_UNKNOWN', `curve probe '${probeId}' points at a load or constraint that no longer exists`, [probeId]),
      );
  }
  return items;
}
