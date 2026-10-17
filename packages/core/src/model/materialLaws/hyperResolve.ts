/** Hyperelastic laws with constant parameters resolved to a numeric W(I1, I2) / Ogden form in MPa (compressibility terms D are ignored). */

import type { LawOf, PolynomialKey } from '../materialModel';
import { arrudaBoyceDerivatives, ogdenShearModulus, polynomialDerivatives, type ResolvedHyper } from './hyperelastic';
import { convertQuantity, isLawFailure } from './resolve';

export type HyperLaw = LawOf<
  | 'hyper_neo_hooke'
  | 'hyper_mooney_rivlin'
  | 'hyper_polynomial'
  | 'hyper_reduced_polynomial'
  | 'hyper_yeoh'
  | 'hyper_ogden'
  | 'hyper_arruda_boyce'
>;

const POLYNOMIAL_EXPONENTS: Readonly<Record<PolynomialKey, readonly [number, number]>> = {
  C10: [1, 0],
  C01: [0, 1],
  C20: [2, 0],
  C11: [1, 1],
  C02: [0, 2],
  C30: [3, 0],
  C21: [2, 1],
  C12: [1, 2],
  C03: [0, 3],
};

const toMPa = (value: number, unit: string): number | null => {
  const converted = convertQuantity(value, unit, 'stress', '');
  return isLawFailure(converted) ? null : converted;
};

/** Numeric form of a hyperelastic law; null when a unit does not convert. */
export function resolveHyper(law: HyperLaw): ResolvedHyper | null {
  const invariant = (terms: ReadonlyArray<readonly [number, number, number]>): ResolvedHyper => ({
    kind: 'invariant',
    derivatives: polynomialDerivatives(terms),
    shearModulus: 2 * terms.filter(([i, j]) => i + j === 1).reduce((sum, [, , c]) => sum + c, 0),
  });
  switch (law.kind) {
    case 'hyper_neo_hooke': {
      const c10 = toMPa(law.C10.value, law.C10.unit);
      return c10 === null ? null : invariant([[1, 0, c10]]);
    }
    case 'hyper_mooney_rivlin': {
      const c10 = toMPa(law.C10.value, law.C10.unit);
      const c01 = toMPa(law.C01.value, law.C01.unit);
      return c10 === null || c01 === null
        ? null
        : invariant([
            [1, 0, c10],
            [0, 1, c01],
          ]);
    }
    case 'hyper_yeoh': {
      const c = [law.C10, law.C20, law.C30].map((q) => toMPa(q.value, q.unit));
      return c.some((value) => value === null) ? null : invariant(c.map((value, k) => [k + 1, 0, value ?? 0] as const));
    }
    case 'hyper_polynomial': {
      const factor = toMPa(1, law.stressUnit);
      if (factor === null) return null;
      return invariant(
        (Object.entries(law.C) as [PolynomialKey, number][]).map(([key, value]) => {
          const [i, j] = POLYNOMIAL_EXPONENTS[key];
          return [i, j, value * factor] as const;
        }),
      );
    }
    case 'hyper_reduced_polynomial': {
      const factor = toMPa(1, law.stressUnit);
      return factor === null ? null : invariant(law.Ci0.map((value, k) => [k + 1, 0, value * factor] as const));
    }
    case 'hyper_ogden': {
      const factor = toMPa(1, law.stressUnit);
      if (factor === null) return null;
      const mu = law.terms.map((term) => term.mu * factor);
      return { kind: 'ogden', mu, alpha: law.terms.map((term) => term.alpha), shearModulus: ogdenShearModulus(mu) };
    }
    case 'hyper_arruda_boyce': {
      const mu = toMPa(law.mu.value, law.mu.unit);
      return mu === null ? null : { kind: 'invariant', derivatives: arrudaBoyceDerivatives(mu, law.lambdaM), shearModulus: mu };
    }
  }
}

/** True when every compressibility term D of the law is 0 (incompressible). */
export function isIncompressible(law: HyperLaw): boolean {
  switch (law.kind) {
    case 'hyper_neo_hooke':
    case 'hyper_mooney_rivlin':
      return law.D1.value === 0;
    case 'hyper_arruda_boyce':
      return law.D.value === 0;
    default:
      return law.D.every((value) => value === 0);
  }
}
