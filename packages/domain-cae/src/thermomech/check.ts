/** check_thermo_mechanical (PHY-04 §7.1): set-up completeness and staleness of a thermo_static or coupled case; every answer needs human review. */

import type { AnalysisCase, FeArtifactPort, TemperatureFieldSource, ThermoMechSetup } from '@core/model/analysis';
import { isCteRefusal } from '@core/model/materialCte';
import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf } from '../shared/access';
import { trustedRecord } from '../shared/trust';
import { checkThermalItems } from '../thermal/check';
import { analysisIdSchema } from '../shared/schemas';
import { elasticUnverifiedReasons, providerFor, REFERENCE_PROBE_KELVIN } from './cte';
import { expressionProblem, resolveTemperatureField, thermalSourceProblem, thermomechOf } from './field';
import { refuseTmc, remediationOf } from './refusal';
import { kelvinOf, temperatureIn } from './units';

export interface ThermomechCheckItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly ids: readonly string[];
  readonly remediation: string;
}

const item = (code: string, severity: 'error' | 'warning', message: string, ids: readonly string[]): ThermomechCheckItem => ({
  code,
  severity,
  message,
  ids,
  remediation: remediationOf(code),
});

/** Warning when interpolation had to project nodes outside the thermal mesh; an error when the mapping itself fails. Needs the artifacts. */
function mappingItems(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  field: Extract<TemperatureFieldSource, { kind: 'thermal_result' }>,
  artifacts: FeArtifactPort | null,
): ThermomechCheckItem[] {
  const hash = analysisCase.meshSummary?.meshHash;
  const mesh = hash === undefined ? null : (artifacts?.get(hash) ?? null);
  if (mesh?.kind !== 'fe_mesh') return [];
  const resolvedField = resolveTemperatureField(doc, analysisCase.id, mesh, artifacts);
  if (!resolvedField.ok)
    return resolvedField.code === 'TMC_FIELD_INVALID'
      ? [item(resolvedField.code, 'error', resolvedField.message, [...resolvedField.ids])]
      : [];
  const report = resolvedField.mapping;
  return report === undefined || report.outside === 0
    ? []
    : [
        item(
          'TMC_MAPPING_PROJECTED',
          'warning',
          `${report.outside} node(s) of '${analysisCase.id}' lie outside the thermal mesh of '${field.analysisId}' and took the value at the nearest point (largest distance ${report.maxMappingDistance})`,
          [analysisCase.id, field.analysisId],
        ),
      ];
}

function fieldItems(
  doc: CadDocument,
  analysisCase: AnalysisCase,
  setup: ThermoMechSetup,
  artifacts: FeArtifactPort | null,
): ThermomechCheckItem[] {
  const { field } = setup;
  const id = analysisCase.id;
  if (field === undefined) return [item('TMC_FIELD_SOURCE_INVALID', 'error', 'no temperature field is set (set_temperature_field)', [id])];
  if (field.kind === 'expression') {
    const problem = expressionProblem(field.expression);
    return problem === null ? [] : [item('TMC_FIELD_INVALID', 'error', `expression '${field.expression}': ${problem}`, [id])];
  }
  if (field.kind !== 'thermal_result') return [];
  const problem = thermalSourceProblem(doc, analysisCase, field, artifacts);
  if (problem !== null) return [item(problem.code, 'error', problem.message, problem.ids)];
  const mapped = field.mapping === 'interpolate' ? mappingItems(doc, analysisCase, field, artifacts) : [];
  const source = caseOf(doc, field.analysisId);
  const times = (source === undefined ? null : trustedRecord(doc, source, artifacts).results)?.thermal?.times ?? [];
  const wanted = field.time;
  const known =
    wanted === 'last' || times.length === 0 || times.some((time) => Math.abs(time - wanted) <= 1e-9 * Math.max(1, Math.abs(wanted)));
  return known
    ? mapped
    : [
        ...mapped,
        item('TMC_FIELD_SOURCE_INVALID', 'error', `the thermal results have no output at time ${String(field.time)} s`, [
          id,
          field.analysisId,
        ]),
      ];
}

function partItems(doc: CadDocument, analysisCase: AnalysisCase, setup: ThermoMechSetup, referenceKelvin: number): ThermomechCheckItem[] {
  const items: ThermomechCheckItem[] = [];
  for (const entityId of Object.keys(analysisCase.parts)) {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    const materialId = entity?.materialId;
    if (materialId === undefined) {
      items.push(item('TMC_MATERIAL_NO_CTE', 'error', `part '${entityId}' has no material, so no thermal expansion`, [entityId]));
      continue;
    }
    const provider = providerFor(doc, setup, materialId, 'material');
    if (isCteRefusal(provider)) {
      items.push(item(provider.code, 'error', provider.reason, [materialId, entityId]));
      continue;
    }
    const probe = provider.strainAt(referenceKelvin + REFERENCE_PROBE_KELVIN, referenceKelvin);
    if (isCteRefusal(probe)) {
      items.push(item(probe.code, 'error', `at the reference temperature: ${probe.reason}`, [materialId, entityId]));
      continue;
    }
    const reasons = [...probe.unverifiedReasons, ...elasticUnverifiedReasons(doc, materialId)];
    if (reasons.length > 0)
      items.push(
        item(
          'TMC_MATERIAL_UNVERIFIED',
          'warning',
          `material '${materialId}' (part ${entityId}) is unverified: ${[...new Set(reasons)].join('; ')}`,
          [materialId, entityId],
        ),
      );
  }
  return items;
}

/**
 * Problems of a thermo_static case: reference temperature, field, thermal source (unsolved / stale / other mesh), CTE per part and its
 * basis, unverified E / nu / CTE, thermal load category.
 * With `artifacts`, a thermal mesh that differs only in node / face sets and targets counts as the same mesh.
 * @failure unknown case -> FEA_ANALYSIS_NOT_FOUND item; other analysis type -> THM_CASE_TYPE item
 */
export function checkThermomechItems(doc: CadDocument, analysisId: string, artifacts: FeArtifactPort | null = null): ThermomechCheckItem[] {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return [item('FEA_ANALYSIS_NOT_FOUND', 'error', `no analysis '${analysisId}'`, [analysisId])];
  const coupled = analysisCase.type === 'coupled_temperature_displacement';
  const setup = coupled ? analysisCase.thermomech : thermomechOf(analysisCase);
  if (setup === undefined)
    return [
      item(
        'THM_CASE_TYPE',
        'error',
        `analysis '${analysisId}' is a ${analysisCase.type} analysis, not thermo_static / coupled_temperature_displacement`,
        [analysisId],
      ),
    ];
  const items: ThermomechCheckItem[] = [];
  const reference = temperatureIn(setup.referenceTemperature, setup.temperatureScale);
  if (reference === null || !Number.isFinite(reference)) {
    items.push(
      item('TMC_REFERENCE_TEMPERATURE_MISSING', 'error', 'the reference temperature is missing or has an invalid unit', [analysisId]),
    );
  }
  if (coupled) items.push(...checkThermalItems(doc, analysisId));
  else items.push(...fieldItems(doc, analysisCase, setup, artifacts));
  if (reference !== null && Number.isFinite(reference))
    items.push(...partItems(doc, analysisCase, setup, kelvinOf(reference, setup.temperatureScale)));
  if (!analysisCase.loadOrder.some((id) => analysisCase.loads[id]?.loadCase === setup.loadCaseName))
    items.push(
      item(
        'TMC_THERMAL_CATEGORY_UNSET',
        'warning',
        `load case '${setup.loadCaseName}' has no load carrying a limit / ultimate category: margins on it are refused until one is set (add_fea_load with loadCase and category)`,
        [analysisId],
      ),
    );
  return items;
}

/**
 * @invariant read-only; data { analysisId, verdict, items[{ code, severity, message, ids, remediation }], reviewRequired: true }
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not thermo_static / coupled -> THM_CASE_TYPE (refusals)
 */
export const checkThermoMechanical = defineCommand({
  name: 'check_thermo_mechanical',
  description:
    'Check a thermo_static or coupled_temperature_displacement analysis before meshing or solving: the stress-free reference temperature, the temperature field (uniform, ' +
    'expression in x/y/z, thermal_result of a solved heat_* case, table; for a coupled case instead the thermal set-up items of check_thermal, ' +
    'e.g. THM_NO_HEAT_PATH), the thermal source (unsolved, stale, different mesh), the ' +
    'coefficient of thermal expansion of every part (property model present, basis stated, inside its validity range), unverified ' +
    'CTE / E / nu values, and the limit/ultimate category of the thermal load case. Returns data.items with a stable code, severity ' +
    '(error blocks the solve, warning does not), the ids involved and a remediation. verdict is fail with any error, warn with only ' +
    'warnings, else pass. reviewRequired is always true: a qualified person must review thermal stress results.',
  annotations: { readOnly: true },
  params: z.object({ analysisId: analysisIdSchema }),
  run: (doc, { analysisId }, ctx): CommandResult => {
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined)
      return refuseTmc(
        doc,
        'check_thermo_mechanical',
        'FEA_ANALYSIS_NOT_FOUND',
        `no analysis '${analysisId}'`,
        [analysisId],
        ['analysisId'],
      );
    if (thermomechOf(analysisCase) === undefined && analysisCase.type !== 'coupled_temperature_displacement')
      return refuseTmc(
        doc,
        'check_thermo_mechanical',
        'THM_CASE_TYPE',
        `analysis '${analysisId}' is ${analysisCase.type}, not thermo_static / coupled_temperature_displacement`,
        [analysisId],
      );
    const items = checkThermomechItems(doc, analysisId, ctx?.feaArtifacts ?? null);
    const errors = items.filter((entry) => entry.severity === 'error').length;
    const verdict = errors > 0 ? 'fail' : items.length > 0 ? 'warn' : 'pass';
    const codes = items.map((entry) => entry.code).join(', ');
    return report(
      doc,
      `check_thermo_mechanical: '${analysisId}' ${verdict} — ${errors} error(s), ${items.length - errors} warning(s)${codes === '' ? '' : ` [${codes}]`}; review required.`,
      { analysisId, verdict, items, reviewRequired: true },
    );
  },
});
