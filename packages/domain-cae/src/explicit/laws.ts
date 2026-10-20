/**
 * Explicit material view (TR-EXP-20): density, E, nu and the optional Johnson-Cook strength of a part, read from the PHY-02 constitutive set
 * (elastic_isotropic + j2_plasticity with johnson_cook isotropic hardening + optional rate_johnson_cook) in the case unit system.
 */

import type { AnalysisCase } from '@core/model/analysis';
import type { CadDocument, Material } from '@core/model/types';
import { findSet, setMembers } from '@core/model/materialLaws/combination';
import { UNVERIFIED_BASES } from '@core/model/propertyModel';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { elasticConstants, isElasticRefusal, ROOM_TEMPERATURE_K } from '../decks/elastic';
import { densityToAnalysis, stressPerMpa } from '../decks/units';

interface JohnsonCookStrength {
  /** Stresses in the case stress unit. */
  readonly A: number;
  readonly B: number;
  readonly n: number;
  readonly C: number;
  /** Reference plastic strain rate, 1/s. */
  readonly referenceRate: number;
  readonly m: number;
  readonly meltK: number;
  readonly transitionK: number;
}

export interface ExplicitMaterial {
  readonly materialId: string;
  readonly density: number;
  readonly E: number;
  readonly nu: number;
  readonly johnsonCook?: JohnsonCookStrength;
  readonly source: string;
  readonly unverifiedReasons: readonly string[];
}

export interface LawRefusal {
  readonly code: string;
  readonly message: string;
}

const value = (quantity: { value: number; unit: string }, unit: string): number | null => {
  const converted = convertValue(quantity.value, quantity.unit, unit);
  return isUnitFailure(converted) || !Number.isFinite(converted.value) ? null : converted.value;
};

function johnsonCookOf(
  material: Material,
  materialId: string,
  perMpa: number,
): { strength?: JohnsonCookStrength; reasons: string[] } | LawRefusal {
  const sets = material.constitutiveSets;
  const set = findSet(sets, material.defaultConstitutiveSet) ?? sets?.find((candidate) => candidate.plastic !== undefined);
  if (set === undefined) return { reasons: [] };
  const members = setMembers(set, material.materialModels ?? []);
  const plastic = members.plastic;
  if (plastic === undefined) return { reasons: [] };
  const law = plastic.model;
  if (law.kind !== 'j2_plasticity' || law.isotropic.kind !== 'johnson_cook' || law.kinematic.kind !== 'none')
    return {
      code: 'EXP_MATERIAL_UNSUPPORTED',
      message: `material '${materialId}' set '${set.id}': plastic law ${law.kind === 'j2_plasticity' ? `j2_plasticity ${law.isotropic.kind} / kinematic ${law.kinematic.kind}` : law.kind} is not built (johnson_cook isotropic, no kinematic hardening)`,
    };
  const iso = law.isotropic;
  const A = value(iso.A, 'MPa');
  const B = value(iso.B, 'MPa');
  const meltK = value(iso.meltTemperature, 'K');
  const transitionK = value(iso.transitionTemperature, 'K');
  const rate = members.rate;
  if (rate !== undefined && rate.model.kind !== 'rate_johnson_cook')
    return {
      code: 'EXP_MATERIAL_UNSUPPORTED',
      message: `material '${materialId}': rate law ${rate.model.kind} is not built (rate_johnson_cook)`,
    };
  const rateLaw = rate?.model.kind === 'rate_johnson_cook' ? rate.model : undefined;
  const referenceRate = rateLaw === undefined ? 1 : value(rateLaw.referenceRate, '1/s');
  if (
    A === null ||
    B === null ||
    meltK === null ||
    transitionK === null ||
    referenceRate === null ||
    !(referenceRate > 0) ||
    !(meltK > transitionK)
  )
    return {
      code: 'EXP_MATERIAL_INCOMPLETE',
      message: `material '${materialId}': Johnson-Cook needs A, B (stress), meltTemperature > transitionTemperature and a positive referenceRate`,
    };
  const reasons = [plastic, ...(rate === undefined ? [] : [rate])]
    .filter((model) => UNVERIFIED_BASES.has(model.basis))
    .map((model) => `model '${model.id}' basis ${model.basis}`);
  return { strength: { A: A * perMpa, B: B * perMpa, n: iso.n, C: rateLaw?.C ?? 0, referenceRate, m: iso.m, meltK, transitionK }, reasons };
}

/**
 * The explicit material of `entityId`.
 * @failure no material / density <= 0 / no elastic constants -> EXP_MATERIAL_INCOMPLETE; an unsupported law -> EXP_MATERIAL_UNSUPPORTED
 */
export function explicitMaterial(doc: CadDocument, analysisCase: AnalysisCase, entityId: string): ExplicitMaterial | LawRefusal {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  const materialId = entity?.materialId;
  const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (material === undefined || materialId === undefined)
    return { code: 'EXP_MATERIAL_INCOMPLETE', message: `part '${entityId}' has no material (assign_material)` };
  if (!(material.density > 0)) return { code: 'EXP_MATERIAL_INCOMPLETE', message: `material '${materialId}' has no density` };
  const elastic = elasticConstants(material, materialId, ROOM_TEMPERATURE_K);
  if (isElasticRefusal(elastic)) return { code: 'EXP_MATERIAL_INCOMPLETE', message: `${elastic.code}: ${elastic.message}` };
  const perMpa = stressPerMpa(analysisCase.unitSystem);
  const plastic = johnsonCookOf(material, materialId, perMpa);
  if ('code' in plastic) return plastic;
  return {
    materialId,
    density: densityToAnalysis(material.density, doc.units, analysisCase.unitSystem),
    E: elastic.E * perMpa,
    nu: elastic.nu,
    ...(plastic.strength !== undefined ? { johnsonCook: plastic.strength } : {}),
    source: `${elastic.source}${plastic.strength !== undefined ? ' + johnson_cook' : ''}`,
    unverifiedReasons: [...elastic.unverifiedReasons, ...plastic.reasons],
  };
}
