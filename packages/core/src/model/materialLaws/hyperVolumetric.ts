/**
 * Volumetric part U(J) of compressible hyperelastic laws (PHY-02 §5.6, V2). W = W_dev(λ̄) + U(J) with the CalculiX / Abaqus forms
 * U = Σ (1/D_i)(J − 1)^(2i) (Neo-Hooke, Mooney-Rivlin, polynomial, reduced polynomial, Yeoh, Ogden) and the Arruda-Boyce form
 * U = (1/D)((J² − 1)/2 − ln J). D in 1/MPa; D1 = 0 means incompressible. The initial bulk modulus is K0 = 2/D1 in both forms.
 */

import { convertQuantity, failure, isLawFailure, type LawFailure } from './resolve';
import type { HyperLaw } from './hyperResolve';

export interface Volumetric {
  /** Initial bulk modulus 2/D1 (MPa). */
  readonly bulkModulus: number;
  /** U(J) in MPa. */
  readonly energy: (J: number) => number;
  /** dU/dJ in MPa. */
  readonly pressure: (J: number) => number;
}

/** D_i in 1/MPa as written by the law (units resolved), or a failure for a unit that does not convert. */
function complianceList(law: HyperLaw): number[] | LawFailure {
  const toInverseMPa = (value: number, unit: string, path: string): number | LawFailure =>
    convertQuantity(value, unit, 'inverseStress', path);
  switch (law.kind) {
    case 'hyper_neo_hooke':
    case 'hyper_mooney_rivlin': {
      const d = toInverseMPa(law.D1.value, law.D1.unit, 'model.D1');
      return isLawFailure(d) ? d : [d];
    }
    case 'hyper_arruda_boyce': {
      const d = toInverseMPa(law.D.value, law.D.unit, 'model.D');
      return isLawFailure(d) ? d : [d];
    }
    case 'hyper_yeoh': {
      const factor = toInverseMPa(1, law.compliance, 'model.compliance');
      return isLawFailure(factor) ? factor : law.D.map((value) => value * factor);
    }
    default: {
      // D is 1/stressUnit: 1/MPa = D · (MPa per stressUnit)
      const mpaPerUnit = convertQuantity(1, law.stressUnit, 'stress', 'model.stressUnit');
      return isLawFailure(mpaPerUnit) ? mpaPerUnit : law.D.map((value) => value / mpaPerUnit);
    }
  }
}

/**
 * The volumetric function of a law, or null when it is incompressible (D1 = 0).
 * @failure a unit that does not convert -> MATL_LAW_PARAMS_INVALID; D1 = 0 with a higher D_i > 0, or any D_i < 0 -> MATL_LAW_PARAMS_INVALID
 */
export function resolveVolumetric(law: HyperLaw): Volumetric | null | LawFailure {
  const d = complianceList(law);
  if (isLawFailure(d)) return d;
  if (d.some((value) => !Number.isFinite(value) || value < 0))
    return failure('MATL_LAW_PARAMS_INVALID', 'model.D', 'compressibility D_i must be finite and ≥ 0');
  const first = d[0] ?? 0;
  if (!(first > 0)) {
    return d.some((value) => value > 0)
      ? failure('MATL_LAW_PARAMS_INVALID', 'model.D', 'D1 = 0 (incompressible) but a higher D_i > 0', 'set D1 > 0 or every D_i = 0')
      : null;
  }
  if (law.kind === 'hyper_arruda_boyce')
    return { bulkModulus: 2 / first, energy: (J) => ((J * J - 1) / 2 - Math.log(J)) / first, pressure: (J) => (J - 1 / J) / first };
  const terms = d.flatMap((value, i) => (value > 0 ? [{ power: 2 * (i + 1), coefficient: 1 / value }] : []));
  return {
    bulkModulus: 2 / first,
    energy: (J) => terms.reduce((sum, { power, coefficient }) => sum + coefficient * (J - 1) ** power, 0),
    pressure: (J) => terms.reduce((sum, { power, coefficient }) => sum + coefficient * power * (J - 1) ** (power - 1), 0),
  };
}
