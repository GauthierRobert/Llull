/** Validation of hyperelastic laws (PHY-02 §3.2, §5.6): parameter shapes, positive initial shear modulus, Drucker stability. */

import type { MaterialValidRange, PolynomialKey } from '../materialModel';
import { druckerScan, type DruckerReport } from './drucker';
import { HYPER_MODES } from './hyperelastic';
import { error, invalid, parameterIssues, positiveNumber, warning, type MatlIssue, type ValidateContext } from './issues';
import { resolveHyper, type HyperLaw } from './hyperResolve';

const POLYNOMIAL_ORDER: Readonly<Record<PolynomialKey, number>> = {
  C10: 1,
  C01: 1,
  C20: 2,
  C11: 2,
  C02: 2,
  C30: 3,
  C21: 3,
  C12: 3,
  C03: 3,
};

function shapeIssues(law: HyperLaw, context: ValidateContext): MatlIssue[] {
  const quantity = (q: { value: number; unit: string }, dimension: 'stress' | 'inverseStress', path: string): MatlIssue[] =>
    parameterIssues(q, dimension, path, context);
  const finite = (values: readonly number[], path: string): MatlIssue[] =>
    values.every(Number.isFinite) ? [] : [invalid(path, 'all values must be finite numbers')];
  const compliance = (values: readonly number[], count: number, path: string): MatlIssue[] =>
    values.length !== count || values.some((v) => !Number.isFinite(v) || v < 0)
      ? [invalid(path, `need ${count} finite values ≥ 0 (0 = incompressible)`)]
      : [];
  const stressUnit = (unit: string, path: string): MatlIssue[] => parameterIssues({ value: 1, unit }, 'stress', path, context);
  switch (law.kind) {
    case 'hyper_neo_hooke':
      return [...quantity(law.C10, 'stress', 'model.C10'), ...quantity(law.D1, 'inverseStress', 'model.D1')];
    case 'hyper_mooney_rivlin':
      return [
        ...quantity(law.C10, 'stress', 'model.C10'),
        ...quantity(law.C01, 'stress', 'model.C01'),
        ...quantity(law.D1, 'inverseStress', 'model.D1'),
      ];
    case 'hyper_yeoh':
      return [
        ...quantity(law.C10, 'stress', 'model.C10'),
        ...quantity(law.C20, 'stress', 'model.C20'),
        ...quantity(law.C30, 'stress', 'model.C30'),
        ...compliance(law.D, 3, 'model.D'),
        ...parameterIssues({ value: 1, unit: law.compliance }, 'inverseStress', 'model.compliance', context),
      ];
    case 'hyper_polynomial': {
      const bad = Object.keys(law.C).find((key) => (POLYNOMIAL_ORDER[key as PolynomialKey] ?? 99) > law.order);
      return [
        ...stressUnit(law.stressUnit, 'model.stressUnit'),
        ...finite(Object.values(law.C), 'model.C'),
        ...(bad === undefined ? [] : [invalid(`model.C.${bad}`, `${bad} is of higher order than order ${law.order}`)]),
        ...compliance(law.D, law.order, 'model.D'),
      ];
    }
    case 'hyper_reduced_polynomial':
      return [
        ...stressUnit(law.stressUnit, 'model.stressUnit'),
        ...(law.Ci0.length === law.order
          ? finite(law.Ci0, 'model.Ci0')
          : [invalid('model.Ci0', `need ${law.order} values C10 … C${law.order}0`)]),
        ...compliance(law.D, law.order, 'model.D'),
      ];
    case 'hyper_ogden':
      return [
        ...stressUnit(law.stressUnit, 'model.stressUnit'),
        ...(law.terms.length >= 1 && law.terms.length <= 3 ? [] : [invalid('model.terms', 'need 1 to 3 Ogden terms')]),
        ...law.terms.flatMap((term, i) =>
          Number.isFinite(term.mu) && Number.isFinite(term.alpha) && term.alpha !== 0
            ? []
            : [invalid(`model.terms[${i}]`, 'mu and alpha must be finite and alpha ≠ 0')],
        ),
        ...compliance(law.D, law.terms.length, 'model.D'),
      ];
    case 'hyper_arruda_boyce':
      return [
        ...quantity(law.mu, 'stress', 'model.mu'),
        ...quantity(law.D, 'inverseStress', 'model.D'),
        ...(Number.isFinite(law.lambdaM) && law.lambdaM > 1 ? [] : [invalid('model.lambdaM', 'lambdaM must be a finite number > 1')]),
      ];
  }
}

/** Range [min, max] of the stretch validity (equation range when given), or null. */
const stretchRange = (validity: readonly MaterialValidRange[] | undefined): readonly [number, number] | null => {
  const range = validity?.find((candidate) => candidate.variable === 'stretch');
  return range === undefined ? null : (range.equation ?? range.data);
};

/** Stability issues of a Drucker report: error inside the declared stretch validity, warning otherwise (or without validity). */
export function druckerIssues(report: DruckerReport, validity: readonly MaterialValidRange[] | undefined): MatlIssue[] {
  const range = stretchRange(validity);
  const issues: MatlIssue[] = [];
  for (const mode of HYPER_MODES) {
    for (const side of ['tension', 'compression'] as const) {
      const first = report[mode][side];
      if (first === null) continue;
      const inside = range !== null && first >= range[0] && first <= range[1];
      const make = inside ? error : warning;
      issues.push(
        make(
          'MATL_HYPERELASTIC_UNSTABLE',
          `model.${mode}.${side}`,
          `Drucker-unstable in ${mode} ${side} from stretch ${first}${inside ? ' (inside the declared validity)' : range === null ? ' (no stretch validity declared)' : ' (outside the declared validity)'}`,
        ),
      );
    }
  }
  return issues;
}

export function validateHyper(law: HyperLaw, context: ValidateContext): MatlIssue[] {
  const shape = shapeIssues(law, context);
  if (shape.length > 0) return shape;
  const resolved = resolveHyper(law);
  if (resolved === null) return [];
  if (!(resolved.shearModulus > 0))
    return [
      error(
        'MATL_HYPERELASTIC_INITIAL_MODULUS',
        'model',
        `initial shear modulus ${resolved.shearModulus} must be > 0 (check the signs of C10 / μ_i)`,
      ),
    ];
  const extra = law.kind === 'hyper_arruda_boyce' ? positiveNumber(law.mu.value, 'model.mu.value', 'mu') : [];
  return [...extra, ...druckerIssues(druckerScan(resolved), context.validity)];
}
