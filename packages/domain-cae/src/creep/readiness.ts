/** Per-part readiness of a creep case: does every analysed part carry a usable Norton law at the hold temperature (PHY-11 TR-CRP-10, 11). */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { significantNumber } from '@lib/compactNumber';
import { creepLawOf, isLawProblem, type CreepLaw } from './law';

export interface PartIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly ids: readonly string[];
}

const sig = (value: number): string => significantNumber(value, 6);

/** The creep law of the material of part `entityId`, or the issue that stops it. */
export function partLaw(doc: CadDocument, entityId: string): CreepLaw | PartIssue {
  const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
  if (materialId === undefined)
    return { code: 'CRP_LAW_MISSING', severity: 'error', message: `part '${entityId}' has no material (assign_material)`, ids: [entityId] };
  const material = Object.hasOwn(doc.materials, materialId) ? (doc.materials[materialId] ?? null) : null;
  const law = creepLawOf(material, materialId);
  return isLawProblem(law)
    ? { code: law.code, severity: 'error', message: `part '${entityId}': ${law.message}`, ids: [entityId, materialId] }
    : law;
}

export const isPartIssue = (value: CreepLaw | PartIssue): value is PartIssue => 'severity' in value;

/**
 * Issues of the parts of `analysis` for a hold at `temperatureK` (null: temperature not set yet): errors stop a deck, warnings do not.
 * @invariant parts in analysis order; at most one error per part; CRP_LAW_UNVERIFIED and CRP_OVERSTRESS_MODEL are warnings
 */
export function partIssues(doc: CadDocument, analysis: AnalysisCase, temperatureK: number | null): PartIssue[] {
  const issues: PartIssue[] = [];
  for (const entityId of Object.keys(analysis.parts)) {
    const law = partLaw(doc, entityId);
    if (isPartIssue(law)) {
      issues.push(law);
      continue;
    }
    const ids = [entityId, law.materialId];
    const error = (code: string, message: string): number =>
      issues.push({ code, severity: 'error', message: `part '${entityId}' (${law.materialId}): ${message}`, ids });
    if (law.timeUnit !== 's')
      error(
        'CRP_LAW_TIME_UNIT',
        `creep model '${law.modelId}' has timeUnit '${law.timeUnit}': the CalculiX cards are written without converting it`,
      );
    else if (law.elasticKind !== null && law.elasticKind !== 'elastic_isotropic')
      error('CRP_ORTHOTROPIC_V2', `elastic model is ${law.elasticKind}: only elastic_isotropic is accepted with creep`);
    else if (
      temperatureK !== null &&
      law.temperatureRangeK !== null &&
      (temperatureK < law.temperatureRangeK[0] || temperatureK > law.temperatureRangeK[1])
    )
      error(
        'CRP_LAW_OUT_OF_RANGE',
        `hold temperature ${sig(temperatureK)} K is outside the validity ${sig(law.temperatureRangeK[0])}..${sig(law.temperatureRangeK[1])} K of creep model '${law.modelId}'`,
      );
    if (law.unverifiedReasons.length > 0)
      issues.push({
        code: 'CRP_LAW_UNVERIFIED',
        severity: 'warning',
        message: `creep law '${law.modelId}' of '${law.materialId}' is unverified: ${law.unverifiedReasons.join('; ')}`,
        ids,
      });
    if (law.plasticModelId !== null)
      issues.push({
        code: 'CRP_OVERSTRESS_MODEL',
        severity: 'warning',
        message: `material '${law.materialId}' also has plastic model '${law.plasticModelId}': CalculiX applies creep above its yield only`,
        ids,
      });
  }
  return issues;
}
