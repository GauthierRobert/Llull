/** check_analysis items of the structural lane (05 §7.1): supports, mesh adequacy, modal and buckling set-up and results. */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { buildDeckContext } from '../decks/context';
import { partAdequacy, MIN_ELEMENTS_ACROSS } from '../results/adequacy';
import { eigenReport } from '../results/eigenReport';
import { partRestraints } from '../results/restraint';
import { feRemediation } from '../shared/feCodes';
import type { Trust } from '../shared/trust';

export interface StructureItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

const item = (code: string, severity: StructureItem['severity'], message: string, ids: readonly string[]): StructureItem => ({
  code,
  severity,
  ids,
  message,
  remediation: feRemediation(code),
});

/** Modal / buckling set-up: supports, the reference load and what the solver ignores. */
function eigenSetupItems(analysis: AnalysisCase): StructureItem[] {
  const id = analysis.id;
  const items: StructureItem[] = [];
  if (analysis.type === 'modal') {
    if (analysis.constraintOrder.length === 0)
      items.push(
        item(
          'FEA_UNDERCONSTRAINED',
          'warning',
          'no support: the model is free-free, so its first six modes are rigid-body motions at about 0 Hz',
          [id],
        ),
      );
    if (analysis.loadOrder.length > 0)
      items.push(
        item('FEA_LOADS_IGNORED', 'warning', 'a modal analysis ignores loads (free vibration); only supports and mass matter', [id]),
      );
  }
  if (analysis.type === 'buckling') {
    if (analysis.constraintOrder.length === 0)
      items.push(item('FEA_NO_CONSTRAINTS', 'error', 'no support: a buckling analysis of a free model is singular', [id]));
    if (analysis.loadOrder.length === 0)
      items.push(item('FEA_NO_LOADS', 'error', 'no load: the buckling factor multiplies the applied reference load', [id]));
    const cases = [...new Set(analysis.loadOrder.flatMap((loadId) => analysis.loads[loadId]?.loadCase ?? []))];
    if (cases.length > 1)
      items.push(
        item(
          'FEA_BUCKLING_LOAD_CASE_IGNORED',
          'warning',
          `only the first load case '${cases[0]}' is the buckling reference; ${cases.slice(1).join(', ')} ignored`,
          [id],
        ),
      );
  }
  return items;
}

/** Modal rigid-body modes and the guards on buckling factors, from the verified results artifact. */
function eigenResultItems(analysis: AnalysisCase, trust: Trust): StructureItem[] {
  if (trust.resultsArtifact === null) return [];
  const report = eigenReport(analysis, trust.resultsArtifact);
  const id = analysis.id;
  if (report === null) return [];
  if (report.kind === 'modal')
    return report.rigidBodyModes > 0
      ? [
          item('FEA_RIGID_BODY_MODES', 'warning', `${report.rigidBodyModes} mode(s) at about 0 Hz are rigid-body motions: add supports`, [
            id,
          ]),
        ]
      : [];
  const items: StructureItem[] = [];
  if (report.nearZeroFactors > 0)
    items.push(
      item(
        'FEA_BUCKLING_NEAR_ZERO',
        'error',
        `${report.nearZeroFactors} buckling factor(s) are numerically zero: the model is singular or the load does not act`,
        [id],
      ),
    );
  if (report.negativeFactors > 0)
    items.push(
      item(
        'FEA_BUCKLING_NEGATIVE_FACTOR',
        'warning',
        `${report.negativeFactors} negative buckling factor(s): the structure would buckle only if the reference load were reversed`,
        [id],
      ),
    );
  if (report.criticalFactor === null)
    items.push(item('FEA_BUCKLING_NO_POSITIVE', 'error', 'no positive buckling factor: the applied load does not buckle the model', [id]));
  else if (report.criticalFactor < 1)
    items.push(
      item(
        'FEA_BUCKLING_BELOW_APPLIED',
        'warning',
        `the lowest positive buckling factor is ${Number(report.criticalFactor.toPrecision(5))} < 1: the applied load exceeds the linear buckling load`,
        [id],
      ),
    );
  return items;
}

/**
 * Supports and mesh adequacy from the verified mesh artifact: FEA_UNDERCONSTRAINED when a part's supports remove fewer than six rigid-body
 * motions (skipped for a modal case without any support, which has its own item); FEA_MESH_ADEQUACY when fewer than two element edges fit across the
 * thinnest dimension of a part.
 */
function meshItems(doc: CadDocument, analysis: AnalysisCase, trust: Trust): StructureItem[] {
  if (trust.meshArtifact === null) return [];
  const ctx = buildDeckContext(doc, analysis.id, trust.meshArtifact);
  if (ctx === null) return [];
  const items: StructureItem[] = [];
  const heat = analysis.type === 'heat_steady' || analysis.type === 'heat_transient';
  if (!heat && analysis.constraintOrder.length > 0)
    for (const part of partRestraints(ctx))
      if (part.rank < 6)
        items.push(
          item(
            'FEA_UNDERCONSTRAINED',
            'warning',
            `part(s) '${part.entityIds.join("', '")}': the supports remove ${part.rank} of 6 rigid-body motions (${part.restrainedDofs} restrained dofs): the stiffness matrix is singular unless other parts or springs hold it`,
            part.entityIds,
          ),
        );
  for (const part of partAdequacy(trust.meshArtifact))
    if (part.elementsAcross < MIN_ELEMENTS_ACROSS)
      items.push(
        item(
          'FEA_MESH_ADEQUACY',
          'warning',
          `part '${part.entityId}': about ${Number(part.elementsAcross.toPrecision(2))} element edge(s) across its thinnest dimension (${Number(part.thinnestExtent.toPrecision(4))} ${analysis.unitSystem.split('-')[1] ?? ''} over a mean edge of ${Number(part.meanEdge.toPrecision(4))}); bending is under-resolved`,
          [part.entityId],
        ),
      );
  return items;
}

/**
 * @invariant empty for heat and thermo-mechanical types except the support / adequacy checks on a verified mesh; results items only from a
 *   verified results artifact
 */
export function structureItems(doc: CadDocument, analysis: AnalysisCase, trust: Trust): StructureItem[] {
  return [...eigenSetupItems(analysis), ...meshItems(doc, analysis, trust), ...eigenResultItems(analysis, trust)];
}
