/**
 * Material models (PHY-02): the one `MaterialLaw` union (constitutive laws plus the durability variants of PHY-07 / PHY-08), constitutive
 * sets and the envelope with validity, basis, provenance and a canonical hash. Models hang off a document material
 * (`Material.materialModels`); stress-like parameters are stored with units, strains and exponents are dimensionless numbers.
 */

import type { FatigueMaterialModel, CrackGrowthMaterialModel } from './materialDurability';
import type { Quantity } from './quantity';
import type { Basis, FitRecord, PropertyVariable, Provenance, ValidRange } from './propertyModel';

/** A scalar law parameter: a constant with unit, or a PHY-01 property model of the same material (temperature, rate …). */
export type LawParameter = Quantity | { readonly propertyModelId: string };

/** Validity variables of a material model: the PHY-01 state variables plus the principal stretch (hyperelastic laws). */
export type MaterialValidityVariable = PropertyVariable | 'stretch';
export type MaterialValidRange = Omit<ValidRange, 'variable'> & { readonly variable: MaterialValidityVariable };

export type IsotropicHardening =
  | { readonly kind: 'perfect'; readonly yieldStress: LawParameter }
  | {
      readonly kind: 'linear';
      readonly yieldStress: LawParameter;
      readonly modulus: LawParameter;
      readonly modulusKind: 'plastic' | 'tangent';
    }
  | {
      readonly kind: 'multilinear';
      readonly stressUnit: string;
      readonly curves: ReadonlyArray<{
        readonly temperature?: Quantity;
        readonly points: ReadonlyArray<readonly [trueStress: number, eqPlasticStrain: number]>;
      }>;
    }
  | { readonly kind: 'voce'; readonly yieldStress: LawParameter; readonly Q: LawParameter; readonly b: number }
  | {
      readonly kind: 'johnson_cook';
      readonly A: Quantity;
      readonly B: Quantity;
      readonly n: number;
      readonly m: number;
      readonly meltTemperature: Quantity;
      readonly transitionTemperature: Quantity;
    };

export type KinematicHardening =
  | { readonly kind: 'none' }
  | { readonly kind: 'linear'; readonly C: LawParameter }
  | { readonly kind: 'chaboche'; readonly backstresses: ReadonlyArray<{ readonly C: LawParameter; readonly gamma: number }> };

export type PolynomialKey = 'C10' | 'C01' | 'C20' | 'C11' | 'C02' | 'C30' | 'C21' | 'C12' | 'C03';

type ViscoShift =
  | {
      readonly kind: 'wlf';
      readonly C1: number;
      readonly C2: Quantity;
      readonly referenceTemperature: Quantity;
      readonly referenceIsTg: boolean;
    }
  | { readonly kind: 'arrhenius'; readonly activationEnergy: Quantity; readonly referenceTemperature: Quantity };

type ConstitutiveLaw =
  | { readonly kind: 'elastic_isotropic'; readonly E: LawParameter; readonly nu: LawParameter }
  | {
      readonly kind: 'elastic_orthotropic';
      readonly E1: LawParameter;
      readonly E2: LawParameter;
      readonly E3: LawParameter;
      readonly nu12: LawParameter;
      readonly nu13: LawParameter;
      readonly nu23: LawParameter;
      readonly G12: LawParameter;
      readonly G13: LawParameter;
      readonly G23: LawParameter;
    }
  | {
      readonly kind: 'elastic_transversely_isotropic';
      readonly isotropyPlane: '12' | '23';
      readonly Ep: LawParameter;
      readonly Et: LawParameter;
      readonly nuP: LawParameter;
      readonly nuPT: LawParameter;
      readonly Gt: LawParameter;
    }
  | { readonly kind: 'elastic_anisotropic'; readonly stiffness: readonly number[]; readonly unit: string }
  | { readonly kind: 'j2_plasticity'; readonly isotropic: IsotropicHardening; readonly kinematic: KinematicHardening }
  | {
      readonly kind: 'ramberg_osgood';
      readonly E: LawParameter;
      readonly nu: LawParameter;
      readonly sigma0: LawParameter;
      readonly n: number;
      readonly alpha: number;
      readonly theory: 'deformation';
    }
  | { readonly kind: 'hyper_neo_hooke'; readonly C10: Quantity; readonly D1: Quantity }
  | { readonly kind: 'hyper_mooney_rivlin'; readonly C10: Quantity; readonly C01: Quantity; readonly D1: Quantity }
  | {
      readonly kind: 'hyper_polynomial';
      readonly order: 1 | 2 | 3;
      readonly C: Readonly<Partial<Record<PolynomialKey, number>>>;
      readonly D: readonly number[];
      readonly stressUnit: string;
    }
  | {
      readonly kind: 'hyper_reduced_polynomial';
      readonly order: 1 | 2 | 3;
      readonly Ci0: readonly number[];
      readonly D: readonly number[];
      readonly stressUnit: string;
    }
  | {
      readonly kind: 'hyper_yeoh';
      readonly C10: Quantity;
      readonly C20: Quantity;
      readonly C30: Quantity;
      readonly D: readonly [number, number, number];
      readonly compliance: string;
    }
  | {
      readonly kind: 'hyper_ogden';
      readonly terms: ReadonlyArray<{ readonly mu: number; readonly alpha: number }>;
      readonly D: readonly number[];
      readonly stressUnit: string;
    }
  | { readonly kind: 'hyper_arruda_boyce'; readonly mu: Quantity; readonly lambdaM: number; readonly D: Quantity }
  | {
      readonly kind: 'visco_prony';
      readonly shear: ReadonlyArray<{ readonly g: number; readonly tau: Quantity }>;
      readonly bulk?: ReadonlyArray<{ readonly k: number; readonly tau: Quantity }>;
      readonly shift?: ViscoShift;
    }
  | {
      readonly kind: 'creep_norton';
      readonly A: number;
      readonly n: number;
      readonly m: number;
      readonly stressUnit: string;
      readonly timeUnit: string;
      readonly hardening: 'time' | 'strain';
    }
  | {
      readonly kind: 'creep_garofalo';
      readonly A: Quantity;
      readonly alpha: Quantity;
      readonly n: number;
      readonly activationEnergy: Quantity;
    }
  | { readonly kind: 'rate_johnson_cook'; readonly C: number; readonly referenceRate: Quantity }
  | { readonly kind: 'rate_cowper_symonds'; readonly D: Quantity; readonly q: number };

export type MaterialLaw = ConstitutiveLaw | FatigueMaterialModel | CrackGrowthMaterialModel;
export type MaterialLawKind = MaterialLaw['kind'];

/** PHY-01 fit record whose fitted range may also be in stretch (hyperelastic fits). */
export type MaterialFitRecord = Omit<FitRecord, 'fittedRange'> & { readonly fittedRange: readonly MaterialValidRange[] };

export interface MaterialModel {
  readonly id: string;
  readonly model: MaterialLaw;
  readonly validity?: readonly MaterialValidRange[];
  readonly basis: Basis;
  readonly provenance: Provenance;
  readonly parametersSha256: string;
  readonly conversion?: { readonly from: string; readonly note: string };
  readonly fit?: MaterialFitRecord;
  readonly reviewedBy?: { readonly signatureId: string };
  readonly preferred?: true;
}

export type MaterialBehaviour =
  | 'elastic'
  | 'plastic'
  | 'hyperelastic'
  | 'viscoelastic'
  | 'creep'
  | 'rate'
  | 'fatigue'
  | 'crack_growth'
  | 'toughness';

/** Behaviour slots a constitutive set may fill. */
export const SET_SLOTS = ['elastic', 'hyperelastic', 'plastic', 'viscoelastic', 'creep', 'rate'] as const;
export type SetSlot = (typeof SET_SLOTS)[number];

export interface ConstitutiveSet {
  readonly id: string;
  readonly elastic?: string;
  readonly hyperelastic?: string;
  readonly plastic?: string;
  readonly viscoelastic?: string;
  readonly creep?: string;
  readonly rate?: string;
}

/** Narrowing helpers: a law of one constitutive kind family. */
export type LawOf<K extends MaterialLawKind> = Extract<MaterialLaw, { readonly kind: K }>;
