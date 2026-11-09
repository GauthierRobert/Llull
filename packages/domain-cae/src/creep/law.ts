/** The Norton creep law of an analysed part: the `creep` member of the material's default constitutive set, read as MPa / s numbers (PHY-11 CreepLawView). */

import { findSet, setMembers } from '@core/model/materialLaws/combination';
import { modelUnverifiedReasonsOf, needsReview } from '@core/model/materialLaws/references';
import type { MaterialModel } from '@core/model/materialModel';
import type { Material } from '@core/model/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { convertNortonA } from '@core/model/materialLaws/nortonUnits';

export interface CreepLaw {
  readonly materialId: string;
  readonly modelId: string;
  /** ε̇ = A σⁿ tᵐ with σ in MPa and t in s (TR-CRP-12 conversion of the stored A). */
  readonly A: number;
  readonly n: number;
  readonly m: number;
  readonly stressUnit: string;
  readonly timeUnit: string;
  /** Declared temperature validity in K, null when the model has none. */
  readonly temperatureRangeK: readonly [number, number] | null;
  readonly basis: string;
  readonly source: string;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: boolean;
  /** Kind of the elastic member of the set (only elastic_isotropic is accepted with creep), null when the set has none. */
  readonly elasticKind: string | null;
  /** Id of a plastic member of the set (CalculiX then uses the overstress model above its yield), null when none. */
  readonly plasticModelId: string | null;
}

export interface CreepLawProblem {
  readonly code: 'CRP_LAW_MISSING' | 'CRP_LAW_FORM_UNSUPPORTED';
  readonly message: string;
}

export const isLawProblem = (value: CreepLaw | CreepLawProblem): value is CreepLawProblem => 'code' in value;

const temperatureRange = (model: MaterialModel): readonly [number, number] | null => {
  const range = model.validity?.find((entry) => entry.variable === 'T');
  if (range === undefined) return null;
  const low = convertValue(range.data[0], range.unit, 'K');
  const high = convertValue(range.data[1], range.unit, 'K');
  return isUnitFailure(low) || isUnitFailure(high) ? null : [low.value, high.value];
};

/**
 * Creep law of `material` (its default constitutive set).
 * @failure no default set / no creep member -> CRP_LAW_MISSING; garofalo or strain hardening -> CRP_LAW_FORM_UNSUPPORTED (only time-hardening Norton has a card)
 */
export function creepLawOf(material: Material | null, materialId: string): CreepLaw | CreepLawProblem {
  const models = material?.materialModels ?? [];
  const set = findSet(material?.constitutiveSets, material?.defaultConstitutiveSet);
  const members = set === undefined ? undefined : setMembers(set, models);
  const model = members?.creep;
  if (material === null || model === undefined)
    return {
      code: 'CRP_LAW_MISSING',
      message: `material '${materialId}' has no creep law in its default constitutive set (add_material_model creep_norton, define_constitutive_set with elastic + creep, makeDefault)`,
    };
  const law = model.model;
  if (law.kind !== 'creep_norton' || law.hardening !== 'time')
    return {
      code: 'CRP_LAW_FORM_UNSUPPORTED',
      message: `creep model '${model.id}' of '${materialId}' is ${law.kind === 'creep_norton' ? 'strain-hardening Norton' : law.kind}: only time-hardening creep_norton has a CalculiX card`,
    };
  const converted = convertNortonA(law.A, law.n, law.m, { stress: law.stressUnit, time: law.timeUnit }, { stress: 'MPa', time: 's' });
  if ('problem' in converted)
    return { code: 'CRP_LAW_FORM_UNSUPPORTED', message: `creep model '${model.id}' of '${materialId}': ${converted.problem}` };
  const reasons = modelUnverifiedReasonsOf(model, {
    name: materialId,
    ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}),
  });
  return {
    materialId,
    modelId: model.id,
    A: converted.A,
    n: law.n,
    m: law.m,
    stressUnit: law.stressUnit,
    timeUnit: law.timeUnit,
    temperatureRangeK: temperatureRange(model),
    basis: model.basis,
    source: model.provenance.citation ?? model.provenance.sourceId ?? '',
    unverifiedReasons: reasons,
    reviewRequired: needsReview(model),
    elasticKind: members?.elastic?.model.kind ?? null,
    plasticModelId: members?.plastic?.id ?? null,
  };
}
