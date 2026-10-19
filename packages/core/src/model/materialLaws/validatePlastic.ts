/** Validation of plasticity laws: J2 hardening (PHY-02 §5.2), Ramberg-Osgood, and the rate laws. */

import type { IsotropicHardening, KinematicHardening, LawOf } from '../materialModel';
import { hillIsConvex } from './hill';
import { poissonIssues } from './validateElastic';
import {
  constantValue,
  error,
  invalid,
  parameterIssues,
  positiveNumber,
  signedParameterIssues,
  warning,
  nonNegativeNumber,
  type MatlIssue,
  type ValidateContext,
} from './issues';

function curveIssues(law: Extract<IsotropicHardening, { kind: 'multilinear' }>, context: ValidateContext, path: string): MatlIssue[] {
  const unit = parameterIssues({ value: 1, unit: law.stressUnit }, 'stress', `${path}.stressUnit`, context);
  if (unit.length > 0) return unit;
  if (law.curves.length === 0) return [error('MATL_HARDENING_CURVE_INVALID', `${path}.curves`, 'need at least one curve')];
  const issues: MatlIssue[] = [];
  const temperatures: number[] = [];
  law.curves.forEach((curve, i) => {
    const at = `${path}.curves[${i}]`;
    if (law.curves.length > 1 && curve.temperature === undefined)
      issues.push(error('MATL_HARDENING_CURVE_INVALID', `${at}.temperature`, 'several curves need a temperature each'));
    if (curve.temperature !== undefined) {
      const t = constantValue(curve.temperature, 'temperature');
      if (t === null) issues.push(invalid(`${at}.temperature`, 'must be a temperature quantity'));
      else if (temperatures.length > 0 && !(t > (temperatures[temperatures.length - 1] ?? Number.POSITIVE_INFINITY)))
        issues.push(error('MATL_HARDENING_CURVE_INVALID', `${at}.temperature`, 'curve temperatures must be strictly increasing'));
      else temperatures.push(t);
    }
    if (curve.points.length < 2) issues.push(error('MATL_HARDENING_CURVE_INVALID', `${at}.points`, 'a curve needs at least 2 points'));
    curve.points.forEach(([stress, strain], j) => {
      if (!Number.isFinite(stress) || !Number.isFinite(strain) || stress <= 0)
        issues.push(error('MATL_HARDENING_CURVE_INVALID', `${at}.points[${j}]`, 'stress must be > 0 and both values finite'));
      else if (j === 0 && strain !== 0)
        issues.push(error('MATL_HARDENING_CURVE_INVALID', `${at}.points[0]`, 'the first point must be at equivalent plastic strain 0'));
      else if (j > 0 && !(strain > (curve.points[j - 1]?.[1] ?? Number.POSITIVE_INFINITY)))
        issues.push(error('MATL_HARDENING_CURVE_INVALID', `${at}.points[${j}]`, 'equivalent plastic strain must be strictly increasing'));
      else if (j > 0 && stress < (curve.points[j - 1]?.[0] ?? 0))
        issues.push(
          warning('MATL_HARDENING_SOFTENING', `${at}.points[${j}]`, 'stress decreases along the curve: expect strain localisation'),
        );
    });
  });
  return issues;
}

function isotropicIssues(law: IsotropicHardening, context: ValidateContext): MatlIssue[] {
  const path = 'model.isotropic';
  switch (law.kind) {
    case 'perfect':
      return signedParameterIssues(law.yieldStress, 'stress', `${path}.yieldStress`, context, 'positive');
    case 'linear':
      return [
        ...signedParameterIssues(law.yieldStress, 'stress', `${path}.yieldStress`, context, 'positive'),
        ...signedParameterIssues(law.modulus, 'stress', `${path}.modulus`, context, 'nonNegative'),
      ];
    case 'multilinear':
      return curveIssues(law, context, path);
    case 'voce':
      return [
        ...signedParameterIssues(law.yieldStress, 'stress', `${path}.yieldStress`, context, 'positive'),
        ...signedParameterIssues(law.Q, 'stress', `${path}.Q`, context, 'nonNegative'),
        ...positiveNumber(law.b, `${path}.b`, 'b'),
      ];
    case 'johnson_cook': {
      const melt = constantValue(law.meltTemperature, 'temperature');
      const transition = constantValue(law.transitionTemperature, 'temperature');
      return [
        ...signedParameterIssues(law.A, 'stress', `${path}.A`, context, 'positive'),
        ...signedParameterIssues(law.B, 'stress', `${path}.B`, context, 'nonNegative'),
        ...nonNegativeNumber(law.n, `${path}.n`, 'n'),
        ...nonNegativeNumber(law.m, `${path}.m`, 'm'),
        ...(melt === null || transition === null || melt > transition
          ? []
          : [invalid(`${path}.meltTemperature`, 'meltTemperature must exceed transitionTemperature')]),
      ];
    }
  }
}

function kinematicIssues(law: KinematicHardening, context: ValidateContext): MatlIssue[] {
  const path = 'model.kinematic';
  switch (law.kind) {
    case 'none':
      return [];
    case 'linear':
      return signedParameterIssues(law.C, 'stress', `${path}.C`, context, 'positive');
    case 'chaboche':
      return [
        ...(law.backstresses.length === 0 ? [invalid(`${path}.backstresses`, 'need at least one back-stress term')] : []),
        ...law.backstresses.flatMap((term, i) => [
          ...signedParameterIssues(term.C, 'stress', `${path}.backstresses[${i}].C`, context, 'positive'),
          ...nonNegativeNumber(term.gamma, `${path}.backstresses[${i}].gamma`, 'gamma'),
        ]),
      ];
  }
}

function hillIssues(law: LawOf<'hill48_plasticity'>, context: ValidateContext): MatlIssue[] {
  const issues = [...isotropicIssues(law.isotropic, context)];
  for (const key of ['F', 'G', 'H', 'L', 'M', 'N'] as const)
    if (!Number.isFinite(law[key])) issues.push(invalid(`model.${key}`, `${key} must be a finite number, got ${String(law[key])}`));
  if (issues.length > 0) return issues;
  return hillIsConvex(law)
    ? []
    : [
        error(
          'MATL_HILL_NOT_CONVEX',
          'model',
          `the Hill yield surface is not convex: need G + H > 0, FG + GH + HF > 0 and L, M, N > 0 (F ${law.F}, G ${law.G}, H ${law.H}, L ${law.L}, M ${law.M}, N ${law.N})`,
        ),
      ];
}

export function validatePlastic(law: LawOf<'j2_plasticity' | 'ramberg_osgood' | 'hill48_plasticity'>, context: ValidateContext): MatlIssue[] {
  if (law.kind === 'hill48_plasticity') return hillIssues(law, context);
  if (law.kind === 'j2_plasticity') return [...isotropicIssues(law.isotropic, context), ...kinematicIssues(law.kinematic, context)];
  const issues = [
    ...signedParameterIssues(law.E, 'stress', 'model.E', context, 'positive'),
    ...parameterIssues(law.nu, 'dimensionless', 'model.nu', context),
    ...signedParameterIssues(law.sigma0, 'stress', 'model.sigma0', context, 'positive'),
    ...(Number.isFinite(law.n) && law.n > 1 ? [] : [invalid('model.n', `n must be a finite number > 1, got ${String(law.n)}`)]),
    ...positiveNumber(law.alpha, 'model.alpha', 'alpha'),
  ];
  if (issues.length > 0) return issues;
  const nu = constantValue(law.nu, 'dimensionless');
  return nu === null ? [] : poissonIssues(nu, 'model.nu');
}

export function validateRate(law: LawOf<'rate_johnson_cook' | 'rate_cowper_symonds'>, context: ValidateContext): MatlIssue[] {
  if (law.kind === 'rate_johnson_cook') {
    return [
      ...nonNegativeNumber(law.C, 'model.C', 'C'),
      ...signedParameterIssues(law.referenceRate, 'rate', 'model.referenceRate', context, 'positive'),
    ];
  }
  return [...signedParameterIssues(law.D, 'rate', 'model.D', context, 'positive'), ...positiveNumber(law.q, 'model.q', 'q')];
}
