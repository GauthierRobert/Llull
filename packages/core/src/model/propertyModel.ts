/**
 * Material property models (PHY-01): a property as a function of state variables (temperature, strain rate, …) with units, a REQUIRED
 * validity range per variable, a basis, provenance and a canonical hash of its coefficients. Models hang off a document material
 * (`Material.propertyModels`); physics packs read them only through `propertyModelEval` (resolve / evaluate / tabulate).
 */

/** Statistical / reporting basis of a value (08 MAT vocabulary). */
export const BASES = ['A', 'B', 'S', 'typical', 'supplier_unstated', 'company', 'unspecified'] as const;
export type Basis = (typeof BASES)[number];

/** Bases whose values are not design allowables: a value on them is always `unverified`. */
export const UNVERIFIED_BASES: ReadonlySet<Basis> = new Set(['typical', 'supplier_unstated', 'unspecified']);

/** Where a model or value comes from: a citation (or a registered source id) and the exact place in it. */
export interface Provenance {
  readonly sourceId?: string;
  readonly citation?: string;
  readonly locator?: string;
  readonly url?: string;
  readonly accessed?: string;
  readonly note?: string;
}

/** Independent variables. A pack that needs a new one adds it HERE (and lists it in its TECHNICAL_SPEC §3). */
export const PROPERTY_VARIABLES = ['T', 'strainRate', 'time', 'exposureTime', 'pressure', 'equivalentPlasticStrain'] as const;
export type PropertyVariable = (typeof PROPERTY_VARIABLES)[number];

interface VariableSpec {
  readonly variable: PropertyVariable;
  readonly unit: string;
  readonly axis?: 'linear' | 'log10';
}

export interface ValidRange {
  readonly variable: PropertyVariable;
  readonly unit: string;
  readonly data: readonly [number, number];
  readonly equation?: readonly [number, number];
}

export const INTERPOLATIONS = ['linear', 'loglinear', 'loglog', 'step'] as const;
type Interpolation = (typeof INTERPOLATIONS)[number];

export type PropertyForm =
  | { readonly kind: 'constant'; readonly value: number }
  | {
      readonly kind: 'table1d';
      readonly variable: PropertyVariable;
      readonly points: ReadonlyArray<readonly [number, number]>;
      readonly interpolation: Interpolation;
    }
  | {
      readonly kind: 'table2d';
      readonly x: VariableSpec;
      readonly y: VariableSpec;
      readonly xs: readonly number[];
      readonly ys: readonly number[];
      readonly values: ReadonlyArray<readonly number[]>;
      readonly interpolation: 'bilinear';
    }
  | { readonly kind: 'polynomial'; readonly variable: PropertyVariable; readonly coefficients: readonly number[]; readonly origin?: number }
  | { readonly kind: 'log10Polynomial'; readonly variable: PropertyVariable; readonly coefficients: readonly number[] }
  | { readonly kind: 'nistRational'; readonly coefficients: readonly number[] }
  | {
      readonly kind: 'arrhenius';
      readonly preFactor: number;
      readonly activationEnergyJPerMol: number;
      readonly temperatureExponent?: number;
    }
  | {
      readonly kind: 'powerLaw';
      readonly variable: PropertyVariable;
      readonly coefficient: number;
      readonly exponent: number;
      readonly reference: number;
    }
  | {
      readonly kind: 'piecewise';
      readonly variable: PropertyVariable;
      readonly segments: ReadonlyArray<{ readonly upTo: number; readonly form: PropertyForm }>;
    }
  | { readonly kind: 'product'; readonly factors: readonly PropertyForm[] }
  | { readonly kind: 'rateFactor'; readonly law: 'johnsonCook'; readonly C: number; readonly referenceRate: number }
  | { readonly kind: 'rateFactor'; readonly law: 'cowperSymonds'; readonly D: number; readonly q: number }
  | { readonly kind: 'ratioOf'; readonly baseModelId: string; readonly ratio: PropertyForm };

/** Grain directions (08 MAT) plus material axes and laminate / fabric directions. */
export const PROPERTY_DIRECTIONS = ['L', 'LT', 'ST', '1', '2', '3', 'normal', 'warp', 'fill'] as const;
export type PropertyDirection = (typeof PROPERTY_DIRECTIONS)[number];

export interface PropertyCondition {
  readonly temper?: string;
  readonly productForm?: string;
  readonly rrr?: number;
  readonly environment?: string;
  readonly note?: string;
  /** Product thickness range the value applies to (08 MAT allowables), in `unit`. */
  readonly thickness?: { readonly min: number; readonly max: number; readonly unit: string };
  /** Bearing edge distance ratio e/D (08 MAT Fbru / Fbry). */
  readonly edOverD?: number;
  /** Exposure time at temperature, hours (08 MAT temperature tables). */
  readonly exposureHours?: number;
}

export interface PropertyUncertainty {
  readonly kind: 'fitErrorVsData' | 'measurement' | 'statistical';
  readonly relative?: number;
  readonly absolute?: { readonly value: number; readonly unit: string };
  readonly coverage?: number;
  readonly provenance: Provenance;
}

export interface FitRecord {
  readonly method: 'linear_least_squares' | 'levenberg_marquardt' | 'interpolating';
  readonly objective: 'absolute' | 'relative' | 'log10';
  readonly points: number;
  readonly datasetSha256: string;
  readonly dataProvenance?: Provenance;
  readonly residual: {
    readonly rms: number;
    readonly maxAbs: number;
    readonly maxRel: number;
    readonly unit: string;
    readonly rSquared?: number;
  };
  readonly conditionNumber?: number;
  readonly fittedRange: readonly ValidRange[];
  readonly tool: string;
}

export interface PropertyModel {
  readonly id: string;
  readonly property: string;
  readonly unit: string;
  readonly variables: readonly VariableSpec[];
  readonly form: PropertyForm;
  readonly validity: readonly ValidRange[];
  readonly basis: Basis;
  readonly direction?: PropertyDirection;
  readonly condition?: PropertyCondition;
  readonly uncertainty?: PropertyUncertainty;
  readonly provenance: Provenance;
  readonly coefficientsSha256: string;
  readonly fit?: FitRecord;
  readonly reviewedBy?: { readonly signatureId: string };
  readonly preferred?: true;
}

/** Every variable a form reads (product / piecewise / table2d recurse; ratioOf reads its ratio's variables). */
export function formVariables(form: PropertyForm): PropertyVariable[] {
  switch (form.kind) {
    case 'constant':
      return [];
    case 'table1d':
    case 'polynomial':
    case 'log10Polynomial':
    case 'powerLaw':
      return [form.variable];
    case 'piecewise':
      return [...new Set([form.variable, ...form.segments.flatMap((segment) => formVariables(segment.form))])];
    case 'table2d':
      return [form.x.variable, form.y.variable];
    case 'nistRational':
    case 'arrhenius':
      return ['T'];
    case 'rateFactor':
      return ['strainRate'];
    case 'product':
      return [...new Set(form.factors.flatMap(formVariables))];
    case 'ratioOf':
      return formVariables(form.ratio);
  }
}

/** Key under which at most one model may be `preferred`: property, direction, basis and condition. */
export const preferenceKey = (model: Pick<PropertyModel, 'property' | 'direction' | 'basis' | 'condition'>): string =>
  JSON.stringify([model.property, model.direction ?? null, model.basis, model.condition ?? null]);
