/** check_contact items (PHY-06 §7.1, FR-CNT-17): set-up of the pairs, initial overclosure on the mesh, results of the solve. */

import type { AnalysisCase, FeMeshArtifact, ResultsSummary } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { significantNumber } from '@lib/compactNumber';
import { checkNonlinearItems } from '../nonlinear/check';
import { cntRemediation } from './codes';
import { initialOverclosure } from './overclosure';
import { pairProblem } from './pairRules';
import type { ContactRow } from './reader';

export interface ContactItem {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'fail';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const item = (code: string, severity: ContactItem['severity'], message: string, ids: readonly string[]): ContactItem => ({
  code,
  severity,
  ids,
  message,
  remediation: cntRemediation(code),
});

const n = (value: number): string => significantNumber(value, 4);

/** Entities held by a constraint or driven by a displacement-controlled step. */
function restrainedEntities(analysis: AnalysisCase): Set<string> {
  const held = new Set(Object.values(analysis.constraints).map((constraint) => constraint.target.entityId));
  for (const step of Object.values(analysis.nonlinear?.steps ?? {}))
    if (step.control.kind === 'displacement') held.add(step.control.target.entityId);
  return held;
}

/**
 * Set-up items: the PHY-05 nonlinear items, each pair re-checked against the case (targets, formulation, values, steps), parts held only
 * through contact. Pure: needs no mesh.
 */
export function setupItems(doc: CadDocument, analysis: AnalysisCase): ContactItem[] {
  const items: ContactItem[] = checkNonlinearItems(doc, analysis).map((entry) => ({ ...entry }));
  const settings = analysis.contact;
  if (settings === undefined) return items;
  const held = restrainedEntities(analysis);
  const flagged = new Set<string>();
  for (const pairId of settings.pairOrder) {
    const pair = settings.pairs[pairId];
    if (pair === undefined) continue;
    const bad = pairProblem(doc, analysis, pair, settings.formulation);
    if (bad !== null) items.push(item(bad.code, 'error', `pair '${pair.id}' (${pair.name}): ${bad.message}`, [pair.id]));
    for (const entityId of [pair.slave.entityId, pair.master.entityId])
      if (!held.has(entityId) && !flagged.has(entityId)) {
        flagged.add(entityId);
        items.push(
          item(
            'CNT_RIGID_BODY_BY_CONTACT_ONLY',
            'warning',
            `part '${entityId}' has no constraint: only contact${pair.friction === undefined ? '' : ' / friction'} holds it (start-up instability)`,
            [entityId, pair.id],
          ),
        );
      }
  }
  return items;
}

/**
 * Initial overclosure of every pair on the current mesh beyond its adjust clearance (relative slack 1e-6 of the clearance or of 1 length
 * unit); a pair too large to measure gives no item (the caller notes it).
 */
export function overclosureItems(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  lengthToAnalysis: number,
): { items: ContactItem[]; unmeasured: string[] } {
  const settings = analysis.contact;
  const items: ContactItem[] = [];
  const unmeasured: string[] = [];
  for (const pairId of settings?.pairOrder ?? []) {
    const pair = settings?.pairs[pairId];
    if (pair === undefined) continue;
    const found = initialOverclosure(mesh, pair);
    if (found === null) {
      unmeasured.push(pair.id);
      continue;
    }
    const allowed = pair.adjust?.kind === 'clearance' ? pair.adjust.value * lengthToAnalysis : 0;
    if (found.value > allowed + 1e-6 * Math.max(allowed, 1))
      items.push(
        item(
          'CNT_INITIAL_OVERCLOSURE',
          'warning',
          `pair '${pair.id}' (${pair.name}): slave node ${found.node ?? '?'} starts ${n(found.value)} inside the master (adjust ${n(allowed)})`,
          [pair.id],
        ),
      );
  }
  return { items, unmeasured };
}

/** Result items (`summary` = the trusted results summary): non-convergence, penetration against the tolerance, slip on pairs that must not slip. */
export function resultItems(
  analysis: AnalysisCase,
  summary: ResultsSummary | null,
  rows: readonly ContactRow[],
  tolerance: { readonly value: number; readonly source: string } | undefined,
  lengthToAnalysis: number,
): ContactItem[] {
  const items: ContactItem[] = [];
  const incomplete = summary?.nonlinear?.steps.find((step) => !step.completed);
  if (incomplete !== undefined)
    items.push(
      item(
        'CNT_CONTACT_NOT_CONVERGED',
        'error',
        `step '${incomplete.stepId}' stopped at load factor ${n(incomplete.lastLoadFactor)} after ${incomplete.increments} increment(s)`,
        [incomplete.stepId],
      ),
    );
  if (tolerance === undefined)
    items.push(
      item('CNT_PENETRATION_TOLERANCE_UNSET', 'warning', 'no penetrationTolerance given: penetration is not judged', [analysis.id]),
    );
  for (const row of rows) {
    const pair = analysis.contact?.pairs[row.pairId];
    if (tolerance !== undefined && row.maxPenetration > tolerance.value * lengthToAnalysis)
      items.push(
        item(
          'CNT_PENETRATION_EXCESSIVE',
          'warning',
          `pair '${row.pairId}' step '${row.stepId}': penetration ${n(row.maxPenetration)} > tolerance ${n(tolerance.value * lengthToAnalysis)} (${tolerance.source})`,
          [row.pairId, row.stepId],
        ),
      );
    if (pair?.noSlipRequired === true && row.slidingAreaFraction > 0)
      items.push(
        item(
          'CNT_SLIP',
          'fail',
          `pair '${row.pairId}' step '${row.stepId}': ${n(100 * row.slidingAreaFraction)} % of the slave area slides (max slip ${n(row.maxSlip)})`,
          [row.pairId, row.stepId],
        ),
      );
  }
  return items;
}
