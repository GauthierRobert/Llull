/** check_thermal and `checkThermalItems`: readiness and post-solve checks of a heat_* analysis (PHY-03 §7.1, AF-20). */

import type { AnalysisCase } from '@core/model/analysis';
import { is3D, type CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { analysisInputHash } from '../hash/inputHash';
import { feRemediation } from '../shared/feCodes';
import { analysisIdSchema } from '../shared/schemas';
import { isProblem, thermalCaseOf, type ThermalCase } from './access';
import { tableProblem } from './amplitude';
import { recordProblem } from './bcModel';
import { refuseThermal, remediationOf } from './codes';
import { HEAT_BALANCE_TOLERANCE, hasRadiation } from './constants';
import { caseTemperatureRange, partMaterials, propertiesNeeded, propertyTable } from './material';
import { unverifiedInputs } from './unverified';

export interface ThermalCheckItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
  readonly path?: string;
}

export const REVIEW_REASON =
  'computed by llull, not approved: a qualified thermal engineer must review the boundary conditions, sources and limits';

export function item(
  code: string,
  severity: ThermalCheckItem['severity'],
  message: string,
  ids: readonly string[],
  path?: string,
): ThermalCheckItem {
  const remediation = code.startsWith('THM_') || code.startsWith('PROP_') ? remediationOf(code) : feRemediation(code);
  return { code, severity, ids, message, remediation, ...(path !== undefined ? { path } : {}) };
}

function partItems(doc: CadDocument, found: ThermalCase): ThermalCheckItem[] {
  const { analysisCase, thermal } = found;
  const items: ThermalCheckItem[] = [];
  const parts = partMaterials(doc, analysisCase);
  if (parts.length === 0) return [item('FEA_PART_INVALID', 'error', 'the analysis has no part', [analysisCase.id])];
  const required = caseTemperatureRange(thermal);
  const seen = new Set<string>();
  for (const part of parts) {
    const entity = Object.hasOwn(doc.entities, part.entityId) ? doc.entities[part.entityId] : undefined;
    if (entity === undefined || !is3D(entity)) {
      items.push(item('FEA_PART_INVALID', 'error', `part '${part.entityId}' is not an existing 3D solid`, [part.entityId]));
      continue;
    }
    if (part.material === null) {
      items.push(item('THM_MATERIAL_NO_K', 'error', `part '${part.entityId}' has no material`, [part.entityId]));
      continue;
    }
    for (const property of propertiesNeeded(analysisCase)) {
      if (seen.has(`${part.materialId}/${property}`)) continue;
      seen.add(`${part.materialId}/${property}`);
      const table = propertyTable({
        materialName: part.materialId,
        material: part.material,
        documentUnit: doc.units,
        property,
        scale: thermal.temperatureScale,
        unitSystem: analysisCase.unitSystem,
        required,
      });
      if ('code' in table) items.push(item(table.code, 'error', table.message, [part.materialId, part.entityId], property));
    }
  }
  for (const entry of unverifiedInputs(doc, found).entries)
    items.push(
      item(
        'THM_MATERIAL_UNVERIFIED',
        'warning',
        `${entry.materialId} ${entry.property} is unverified: ${entry.reasons.join(', ')}`,
        [entry.materialId],
        entry.property,
      ),
    );
  return items;
}

function setupItems(doc: CadDocument, found: ThermalCase): ThermalCheckItem[] {
  const { analysisCase, thermal } = found;
  const id = analysisCase.id;
  const items: ThermalCheckItem[] = [];
  if (analysisCase.type === 'heat_transient') {
    if (thermal.initialTemperature === undefined)
      items.push(item('THM_INITIAL_TEMPERATURE_MISSING', 'error', 'a transient case needs an initial temperature', [id]));
    if (thermal.step.endTimeS === undefined)
      items.push(item('THM_STEP_INVALID', 'error', 'a transient case needs step.endTimeS', [id], 'step.endTimeS'));
  } else {
    const sink = Object.values(thermal.bcs).some((r) => r.bc.kind === 'temperature' || r.bc.kind === 'film' || r.bc.kind === 'radiation');
    const open = Object.values(thermal.cavities).some((c) => c.environment.kind === 'open');
    if (!sink && !open)
      items.push(
        item('THM_NO_HEAT_PATH', 'error', 'a steady case without a temperature, film or radiation BC has no unique solution', [id]),
      );
  }
  for (const bcId of thermal.bcOrder) {
    const record = thermal.bcs[bcId];
    const found2 = record === undefined ? null : recordProblem(doc, analysisCase, thermal, record);
    if (found2 !== null) items.push(item(found2.code, 'error', found2.message, [bcId, ...found2.ids], found2.paths[0]));
  }
  for (const amplitude of Object.values(thermal.amplitudes)) {
    const bad = tableProblem(amplitude.points);
    if (bad !== null) items.push(item('THM_AMPLITUDE_INVALID', 'error', `amplitude '${amplitude.id}': ${bad}`, [amplitude.id]));
  }
  if (hasRadiation(thermal) && thermal.temperatureScale !== 'degC' && thermal.temperatureScale !== 'K')
    items.push(item('THM_RADIATION_SCALE', 'error', 'radiation needs temperatureScale degC or K', [id]));
  const names = new Set<string>();
  for (const cavity of Object.values(thermal.cavities)) {
    const upper = cavity.name.toUpperCase();
    if (cavity.name.length === 0 || cavity.name.length > 3 || names.has(upper) || cavity.faces.length < 2)
      items.push(
        item('THM_CAVITY_INVALID', 'error', `cavity '${cavity.id}' (${cavity.name}): name 1-3 characters, unique, at least 2 faces`, [
          cavity.id,
        ]),
      );
    names.add(upper);
  }
  for (const contact of Object.values(thermal.contacts))
    items.push(
      item('THM_CONTACT_UNSUPPORTED', 'error', `thermal contact '${contact.id}' is recorded but the deck cannot write it`, [contact.id]),
    );
  for (const limit of Object.values(thermal.limits))
    if (limit.source.citation.trim() === '')
      items.push(item('THM_LIMIT_SOURCE_REQUIRED', 'error', `limit '${limit.id}' has no source`, [limit.id], 'source'));
  return items;
}

/** Post-solve items on fresh results: heat balance above the named tolerance, tables the field left. */
function resultItems(analysisCase: AnalysisCase, doc: CadDocument): ThermalCheckItem[] {
  const summary = analysisCase.results?.thermal;
  if (summary === undefined || analysisCase.results?.inputHash !== analysisInputHash(doc, analysisCase.id, 'full')) return [];
  const items: ThermalCheckItem[] = [];
  const balance = summary.heatBalance;
  if (balance.residualRel > HEAT_BALANCE_TOLERANCE.value)
    items.push(
      item(
        'THM_HEAT_BALANCE',
        'warning',
        `heat balance residual ${balance.residualRel} exceeds ${HEAT_BALANCE_TOLERANCE.value} (in ${balance.inW} W, out ${balance.outW} W, stored ${balance.storedW} W at t=${balance.timeS} s)`,
        [analysisCase.id],
      ),
    );
  for (const range of summary.propertyRangeExceeded)
    items.push(
      item(
        'THM_PROPERTY_OUT_OF_RANGE',
        'warning',
        `${range.material} ${range.property}: temperature ${range.reached} left the tabulated range ${range.validRange[0]}..${range.validRange[1]} (the solver holds the end value)`,
        [range.material],
        range.property,
      ),
    );
  return items;
}

/**
 * Items of a heat_* analysis: set-up errors (THM_*), unverified inputs, and, when the recorded results are current, the heat balance and
 * property-range warnings. Mesh / result staleness is added by `check_thermal` (and by 05 `check_analysis` for every type).
 * @failure not a heat_* analysis -> one THM_CASE_TYPE error
 */
export function checkThermalItems(doc: CadDocument, analysisId: string): readonly ThermalCheckItem[] {
  const found = thermalCaseOf(doc, analysisId);
  if (isProblem(found)) return [item(found.code, 'error', found.message, found.ids)];
  return [...setupItems(doc, found), ...partItems(doc, found), ...resultItems(found.analysisCase, doc)];
}

/**
 * @invariant read-only; status fail (any error) | warn | pass; reviewRequired is always true
 * @failure unknown analysis / other case type -> refusal (FEA_ANALYSIS_NOT_FOUND / THM_CASE_TYPE)
 */
export const checkThermal = defineCommand({
  name: 'check_thermal',
  description:
    'Check a heat_steady / heat_transient analysis before the solve and after it: data { status: pass | warn | fail, items [{ code, severity, ' +
    'ids, path?, message, remediation }], state, reviewRequired: true }. Errors (THM_NO_HEAT_PATH, THM_INITIAL_TEMPERATURE_MISSING, ' +
    'THM_MATERIAL_NO_K / NO_CP, THM_EMISSIVITY_INVALID, THM_SOURCE_REQUIRED, THM_STEP_INVALID, ...) must be fixed before fea_solve; warnings ' +
    'include THM_MATERIAL_UNVERIFIED, THM_HEAT_BALANCE (residual above the named 1e-2: do not report the result as final) and ' +
    'THM_PROPERTY_OUT_OF_RANGE. End every thermal job with this check.',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, { analysisId }): CommandResult => {
    const found = thermalCaseOf(doc, analysisId);
    if (isProblem(found)) return refuseThermal(doc, 'check_thermal', found.code, found.message, found.ids, found.paths);
    const { analysisCase } = found;
    const items: ThermalCheckItem[] = [...checkThermalItems(doc, analysisId)];
    if (analysisCase.meshSummary === undefined)
      items.push(item('FEA_MESH_MISSING', 'warning', 'the analysis is not meshed yet', [analysisId]));
    else if (analysisCase.meshSummary.inputHash !== analysisInputHash(doc, analysisId, 'mesh'))
      items.push(item('FEA_MESH_STALE', 'warning', 'the recorded mesh was built for other inputs', [analysisId]));
    if (analysisCase.results !== undefined && analysisCase.results.inputHash !== analysisInputHash(doc, analysisId, 'full'))
      items.push(item('FEA_RESULTS_STALE', 'error', 'the recorded results were computed for other inputs', [analysisId]));
    const errors = items.filter((entry) => entry.severity === 'error').length;
    const status = errors > 0 ? 'fail' : items.length > 0 ? 'warn' : 'pass';
    const inputs = unverifiedInputs(doc, found);
    const data = {
      analysisId,
      status,
      items,
      reviewRequired: true,
      reviewReason: REVIEW_REASON,
      unverified: inputs.unverified,
      unverifiedReasons: inputs.reasons,
    };
    return report(doc, `check_thermal: '${analysisId}' ${status} — ${errors} error(s), ${items.length - errors} warning(s).`, data);
  },
});
