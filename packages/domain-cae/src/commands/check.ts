/** check_analysis: read-only readiness / post-solve check of an analysis (05 AF-20, codes §7.1). */

import type { AnalysisCase } from '@core/model/analysis';
import { is3D, type CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { elasticConstants, isElasticRefusal, propertyTemperatureK } from '../decks/elastic';
import { caseOf } from '../shared/access';
import { feRemediation, refuseFe } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { stateOf } from '../shared/state';
import { analysisInputHash } from '../hash/inputHash';
import { checkThermalItems } from '../thermal/check';
import { checkThermomechItems } from '../thermomech/check';

export interface CheckItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
  readonly path?: string;
}

const item = (code: string, severity: CheckItem['severity'], message: string, ids: readonly string[], path?: string): CheckItem => ({
  code,
  severity,
  ids,
  message,
  remediation: feRemediation(code),
  ...(path !== undefined ? { path } : {}),
});

function partItems(doc: CadDocument, analysis: AnalysisCase): CheckItem[] {
  const parts = Object.keys(analysis.parts);
  if (parts.length === 0) return [item('FEA_PART_INVALID', 'error', 'the analysis has no part', [analysis.id])];
  const structural = analysis.type === 'static' || analysis.type === 'thermo_static';
  const items: CheckItem[] = [];
  for (const entityId of parts) {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined || !is3D(entity)) {
      items.push(item('FEA_PART_INVALID', 'error', `part '${entityId}' is not an existing 3D solid`, [entityId]));
      continue;
    }
    const materialId = entity.materialId;
    const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
    if (material === undefined) {
      items.push(item('FEA_MATERIAL_MISSING', 'error', `part '${entityId}' has no material`, [entityId]));
    } else if (structural) {
      const elastic = elasticConstants(material, materialId ?? '', propertyTemperatureK(analysis));
      if (isElasticRefusal(elastic)) items.push(item(elastic.code, 'error', elastic.message, [entityId, materialId ?? '']));
      else if (elastic.unverifiedReasons.length > 0)
        items.push(
          item('FEA_MATERIAL_UNVERIFIED', 'warning', `material '${materialId}': ${elastic.unverifiedReasons.join('; ')}`, [
            entityId,
            materialId ?? '',
          ]),
        );
    }
  }
  return items;
}

function setupItems(analysis: AnalysisCase): CheckItem[] {
  const items: CheckItem[] = [];
  const structural = analysis.type === 'static' || analysis.type === 'thermo_static';
  if (structural && analysis.constraintOrder.length === 0)
    items.push(item('FEA_NO_CONSTRAINTS', 'error', 'no constraint: the model is free to move (singular stiffness)', [analysis.id]));
  const prescribed = Object.values(analysis.constraints).some((c) => Object.values(c.dofs ?? {}).some((value) => value !== 0));
  if (analysis.type === 'static' && analysis.loadOrder.length === 0 && !prescribed)
    items.push(item('FEA_NO_LOADS', 'warning', 'no load and no prescribed displacement: the solution is zero', [analysis.id]));
  for (const id of analysis.loadOrder) {
    const load = analysis.loads[id];
    if (load?.kind === 'force' && load.target !== undefined && (load.target.facesNear?.length ?? 0) === 0)
      items.push(
        item('FEA_POINT_LOAD_SINGULAR', 'warning', `force '${id}' (${load.name}) acts on edges / points: stress near it is singular`, [id]),
      );
  }
  return items;
}

function artifactItems(doc: CadDocument, analysis: AnalysisCase, hasPort: boolean, present: (hash: string) => boolean): CheckItem[] {
  const mesh = analysis.meshSummary;
  if (mesh === undefined) return [item('FEA_MESH_MISSING', 'error', `analysis '${analysis.id}' is not meshed`, [analysis.id])];
  if (mesh.inputHash !== analysisInputHash(doc, analysis.id, 'mesh'))
    return [item('FEA_MESH_STALE', 'error', 'the recorded mesh was built for other inputs', [analysis.id])];
  const items: CheckItem[] = [];
  if (mesh.quality.inverted > 0)
    items.push(item('FEA_MESH_INVERTED', 'error', `${mesh.quality.inverted} inverted element(s) (scaled Jacobian <= 0)`, [analysis.id]));
  if (hasPort && !present(mesh.meshHash))
    items.push(item('FEA_MESH_MISSING', 'error', `mesh artifact ${mesh.meshHash} is not available on this machine`, [analysis.id]));
  const results = analysis.results;
  if (results === undefined) return [...items, item('FEA_RESULTS_MISSING', 'error', 'no recorded results', [analysis.id])];
  if (results.inputHash !== analysisInputHash(doc, analysis.id, 'full'))
    return [...items, item('FEA_RESULTS_STALE', 'error', 'the recorded results were computed for other inputs', [analysis.id])];
  if (hasPort && !present(results.resultsHash))
    items.push(
      item('FEA_RESULTS_MISSING', 'error', `results artifact ${results.resultsHash} is not available on this machine`, [analysis.id]),
    );
  return items;
}

/**
 * @invariant read-only; data { status: pass | warn | fail, state, items [{ code, severity, ids, path?, message, remediation }], reviewRequired: true };
 *   thermal and thermo-mechanical items come from the discipline checks
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND
 */
export const checkAnalysis = defineCommand({
  name: 'check_analysis',
  description:
    'Check a finite-element analysis end to end and return data { status: pass | warn | fail, state, items [{ code, severity: error | warning, ' +
    'ids, message, remediation }], reviewRequired: true }: parts exist and are solids with a material, elastic E / nu (static, thermo_static) or ' +
    'thermal properties (heat), supports (static needs at least one: FEA_NO_CONSTRAINTS), loads, thermal / thermo-mechanical set-up, mesh ' +
    'recorded and not stale or inverted, results recorded and not stale. Run it before fea_mesh / fea_solve (readiness) and after the solve. ' +
    'It is not a certification: reviewRequired is always true and a qualified person must review the model, mesh and results.',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, { analysisId }, ctx): CommandResult => {
    const analysis = caseOf(doc, analysisId);
    if (analysis === undefined)
      return refuseFe(doc, 'check_analysis', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    const port = ctx?.feaArtifacts ?? null;
    const disciplines: readonly CheckItem[] =
      analysis.type === 'heat_steady' || analysis.type === 'heat_transient'
        ? checkThermalItems(doc, analysisId)
        : analysis.type === 'thermo_static'
          ? checkThermomechItems(doc, analysisId)
          : [];
    const items: CheckItem[] = [
      ...partItems(doc, analysis),
      ...setupItems(analysis),
      ...disciplines,
      ...artifactItems(doc, analysis, port !== null, (hash) => port?.get(hash) != null),
    ];
    const errors = items.filter((entry) => entry.severity === 'error').length;
    const warnings = items.length - errors;
    const status = errors > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass';
    return report(
      doc,
      `check_analysis: '${analysisId}' ${status} — ${errors} error(s), ${warnings} warning(s)${items.length > 0 ? `: ${[...new Set(items.map((entry) => entry.code))].join(', ')}` : ''}; reviewRequired.`,
      { analysisId, status, state: stateOf(doc, analysis), items, reviewRequired: true },
    );
  },
});
