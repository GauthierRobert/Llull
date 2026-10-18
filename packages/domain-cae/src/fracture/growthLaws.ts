/** Crack-growth rate laws in SI (m/cycle, MPa sqrt(m)): Paris, Walker, Forman, NASGRO, tabulated log-log (PHY-08 TR-FRC-32). */

import type { CrackGrowthMaterialModel } from '@core/model/materialDurability';
import { convertValue, isUnitFailure } from '@lib/quantity';

type Table = ReadonlyArray<{ readonly stressRatio: number; readonly points: ReadonlyArray<readonly [number, number]> }>;
type Closure =
  | { readonly kind: 'newman'; readonly alpha: number; readonly smaxOverSigma0: number }
  | { readonly kind: 'table'; readonly points: ReadonlyArray<readonly [number, number]> }
  | { readonly kind: 'none' };

export type RateModel = (
  | { readonly kind: 'paris'; readonly C: number; readonly m: number; readonly dKth: number }
  | { readonly kind: 'walker'; readonly C: number; readonly m: number; readonly gamma: number; readonly gammaNegativeR: number }
  | { readonly kind: 'forman'; readonly C: number; readonly n: number; readonly Kc: number }
  | {
      readonly kind: 'nasgro';
      readonly C: number;
      readonly n: number;
      readonly p: number;
      readonly q: number;
      readonly dKth: number;
      readonly Kc: number;
      readonly closure: Closure;
    }
  | { readonly kind: 'table'; readonly families: Table }
) & { readonly dKRange?: readonly [number, number] };

/** Length [m per unit] and K [MPa sqrt(m) per unit] factors of a model `units` text, or null. */
function unitFactors(units: string): { readonly a: number; readonly k: number } | null {
  if (units.startsWith('m/cycle')) return { a: 1, k: 1 };
  if (units.startsWith('in/cycle')) return { a: 0.0254, k: 1.0988434941087546 };
  return null;
}

const toSiK = (value: number, unit: string): number | null => {
  const converted = convertValue(value, unit, 'MPa*m^0.5');
  return isUnitFailure(converted) ? null : converted.value;
};

/** The model in SI, or a problem text (unrecognised units, unsupported variant). */
export function rateModelOf(law: CrackGrowthMaterialModel): RateModel | string {
  if (law.kind === 'fracture_toughness') return 'a toughness model is not a growth law';
  const factors = unitFactors(law.units);
  if (factors === null) return `units '${law.units}' are not 'm/cycle|MPa*m^0.5' or 'in/cycle|ksi*in^0.5'`;
  const { a, k } = factors;
  const range = law.conditions.dKRange;
  const dKRange = range === undefined ? undefined : ([toSiK(range.min, range.unit), toSiK(range.max, range.unit)] as const);
  const withRange = <T extends RateModel>(model: T): T | string =>
    dKRange === undefined
      ? model
      : dKRange[0] === null || dKRange[1] === null
        ? `dKRange unit '${range?.unit}' is not a stress-intensity unit`
        : { ...model, dKRange: [dKRange[0], dKRange[1]] as const };
  switch (law.kind) {
    case 'da_dn_paris':
      return withRange({ kind: 'paris', C: (law.C * a) / k ** law.m, m: law.m, dKth: (law.dKth ?? 0) * k });
    case 'da_dn_walker':
      return withRange({
        kind: 'walker',
        C: (law.C * a) / k ** law.m,
        m: law.m,
        gamma: law.gamma,
        gammaNegativeR: law.gammaNegativeR ?? law.gamma,
      });
    case 'da_dn_forman':
      return withRange({ kind: 'forman', C: law.C * a * k ** (1 - law.n), n: law.n, Kc: law.Kc * k });
    case 'da_dn_nasgro': {
      if (!('dKth' in law.threshold)) return 'NASGRO threshold by dK0/Cth is not supported; give threshold { dKth }';
      if (!('Kc' in law.toughness)) return 'NASGRO toughness by KIc/Ak/Bk is not supported; give toughness { Kc }';
      return withRange({
        kind: 'nasgro',
        C: (law.C * a) / k ** law.n,
        n: law.n,
        p: law.p,
        q: law.q,
        dKth: law.threshold.dKth * k,
        Kc: law.toughness.Kc * k,
        closure: law.closure,
      });
    }
    case 'da_dn_table':
      return withRange({
        kind: 'table',
        families: law.families.map((family) => ({
          stressRatio: family.stressRatio,
          points: family.points.map(([dK, rate]) => [dK * k, rate * a] as const),
        })),
      });
  }
}

/** Newman crack-opening function f(R) (grade C form, OQ-FRC-02). */
export function newmanClosure(R: number, alpha: number, smaxOverSigma0: number): number {
  const a0 = (0.825 - 0.34 * alpha + 0.05 * alpha ** 2) * Math.cos((Math.PI * smaxOverSigma0) / 2) ** (1 / alpha);
  const a1 = (0.415 - 0.071 * alpha) * smaxOverSigma0;
  const a3 = 2 * a0 + a1 - 1;
  const a2 = 1 - a0 - a1 - a3;
  return R >= 0 ? Math.max(R, a0 + a1 * R + a2 * R ** 2 + a3 * R ** 3) : a0 + a1 * R;
}

function closureValue(closure: Closure, R: number): number {
  if (closure.kind === 'none') return 0;
  if (closure.kind === 'newman') return newmanClosure(R, closure.alpha, closure.smaxOverSigma0);
  const points = [...closure.points].sort((x, y) => x[0] - y[0]);
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) return 0;
  if (R <= first[0]) return first[1];
  if (R >= last[0]) return last[1];
  const i = points.findIndex((point) => point[0] >= R);
  const [r0 = 0, f0 = 0] = points[i - 1] ?? [];
  const [r1 = 1, f1 = 0] = points[i] ?? [];
  return f0 + ((f1 - f0) * (R - r0)) / (r1 - r0);
}

/** NASGRO rate at closure value `f`; 0 at or below dKth, Infinity at Kmax >= Kc. */
export function nasgroRate(model: Extract<RateModel, { kind: 'nasgro' }>, dK: number, R: number, f: number): number {
  const kmax = dK / (1 - R);
  if (dK <= model.dKth) return 0;
  if (kmax >= model.Kc) return Number.POSITIVE_INFINITY;
  return (model.C * (((1 - f) / (1 - R)) * dK) ** model.n * (1 - model.dKth / dK) ** model.p) / (1 - kmax / model.Kc) ** model.q;
}

function interpolateFamily(points: Table[number]['points'], dK: number): { readonly rate: number; readonly extrapolated: boolean } {
  const sorted = [...points].sort((x, y) => x[0] - y[0]);
  const extrapolated = dK < (sorted[0]?.[0] ?? dK) || dK > (sorted.at(-1)?.[0] ?? dK);
  const found = sorted.findIndex((point) => point[0] >= dK);
  const i = found < 0 ? sorted.length - 1 : Math.max(found, 1);
  const [x0 = 1, y0 = 1] = sorted[i - 1] ?? [];
  const [x1 = 1, y1 = 1] = sorted[i] ?? [];
  const slope = (Math.log10(y1) - Math.log10(y0)) / (Math.log10(x1) - Math.log10(x0));
  return { rate: 10 ** (Math.log10(y0) + slope * (Math.log10(dK) - Math.log10(x0))), extrapolated };
}

function tableRate(families: Table, dK: number, R: number): { readonly rate: number; readonly extrapolated: boolean } {
  const sorted = [...families].sort((x, y) => x.stressRatio - y.stressRatio);
  const upper = sorted.findIndex((family) => family.stressRatio >= R);
  const low = sorted[upper <= 0 ? 0 : upper - 1];
  const high = sorted[upper < 0 ? sorted.length - 1 : Math.max(upper, 0)];
  if (low === undefined || high === undefined) return { rate: 0, extrapolated: true };
  const a = interpolateFamily(low.points, dK);
  const b = interpolateFamily(high.points, dK);
  const outsideR = R < (sorted[0]?.stressRatio ?? R) || R > (sorted.at(-1)?.stressRatio ?? R);
  const span = high.stressRatio - low.stressRatio;
  const weight = span === 0 ? 0 : (R - low.stressRatio) / span;
  return {
    rate: a.rate + (b.rate - a.rate) * Math.min(Math.max(weight, 0), 1),
    extrapolated: a.extrapolated || b.extrapolated || outsideR,
  };
}

export interface Rate {
  /** da/dN [m/cycle]. */
  readonly rate: number;
  readonly extrapolated: boolean;
}

/** da/dN at stress-intensity range `dK` [MPa sqrt(m)] and ratio R = Kmin/Kmax (0 <= R < 1 for the laws that divide by 1 - R). */
export function growthRate(model: RateModel, dK: number, R: number): Rate {
  const outside = model.dKRange !== undefined && (dK < model.dKRange[0] || dK > model.dKRange[1]);
  if (!(dK > 0)) return { rate: 0, extrapolated: false };
  switch (model.kind) {
    case 'paris':
      return { rate: dK <= model.dKth ? 0 : model.C * dK ** model.m, extrapolated: outside };
    case 'walker': {
      const gamma = R < 0 ? model.gammaNegativeR : model.gamma;
      return { rate: model.C * (dK / (1 - R) ** (1 - gamma)) ** model.m, extrapolated: outside };
    }
    case 'forman': {
      const denominator = (1 - R) * model.Kc - dK;
      return { rate: denominator <= 0 ? Number.POSITIVE_INFINITY : (model.C * dK ** model.n) / denominator, extrapolated: outside };
    }
    case 'nasgro':
      return { rate: nasgroRate(model, dK, R, closureValue(model.closure, R)), extrapolated: outside };
    case 'table': {
      const found = tableRate(model.families, dK, R);
      return { rate: found.rate, extrapolated: found.extrapolated || outside };
    }
  }
}
