/** Validation of the elastic laws (PHY-02 §5.1): parameter shapes, Poisson bounds, positive definiteness. */

import type { LawOf } from '../materialModel';
import {
  expandTransverselyIsotropic,
  orthotropicReport,
  stiffnessReport,
  symmetricFromUpperTriangle,
  type ElasticReport,
  type OrthotropicConstants,
} from './elastic';
import {
  constantValue,
  error,
  invalid,
  parameterIssues,
  signedParameterIssues,
  warning,
  type MatlIssue,
  type ValidateContext,
} from './issues';

/** Isotropic Poisson bound −1 < ν < 0.5 (K > 0, G > 0). */
export function poissonIssues(nu: number, path: string): MatlIssue[] {
  if (!(nu > -1 && nu < 0.5))
    return [
      error(
        'MATL_POISSON_BOUND',
        path,
        `ν = ${nu} is outside (−1, 0.5): bulk modulus E/(3(1−2ν)) and shear modulus E/(2(1+ν)) must be > 0`,
      ),
    ];
  if (0.5 - nu < 1e-6)
    return [warning('MATL_NEAR_INCOMPRESSIBLE', path, `ν = ${nu} is within 1e-6 of 0.5: locking risk in displacement-based FE`)];
  return [];
}

const ORTHO_KEYS = ['E1', 'E2', 'E3', 'nu12', 'nu13', 'nu23', 'G12', 'G13', 'G23'] as const;

/** Constants of an orthotropic law when every parameter is a constant (else null). */
export function constantOrthotropic(law: LawOf<'elastic_orthotropic'>): OrthotropicConstants | null {
  const values = ORTHO_KEYS.map((key) => constantValue(law[key], key.startsWith('nu') ? 'dimensionless' : 'stress'));
  if (values.some((value) => value === null)) return null;
  const [E1, E2, E3, nu12, nu13, nu23, G12, G13, G23] = values as number[];
  return {
    E1: E1 ?? 0,
    E2: E2 ?? 0,
    E3: E3 ?? 0,
    nu12: nu12 ?? 0,
    nu13: nu13 ?? 0,
    nu23: nu23 ?? 0,
    G12: G12 ?? 0,
    G13: G13 ?? 0,
    G23: G23 ?? 0,
  };
}

function stabilityIssue(report: ElasticReport, path: string): MatlIssue[] {
  if (report.positiveDefinite) return [];
  const violated = (report.poissonBounds ?? []).filter((bound) => !bound.satisfied);
  const detail =
    violated.length > 0
      ? `; ${violated.map((bound) => `|ν${bound.pair}| = ${Math.abs(bound.nu)} ≥ √(E_i/E_j) = ${bound.limit}`).join('; ')}`
      : '';
  return [
    error(
      'MATL_ELASTIC_NOT_POSITIVE_DEFINITE',
      path,
      `the ${report.matrix} matrix is not positive definite (pivot ${report.failingPivot === null ? '?' : report.failingPivot + 1} = ${report.pivots[report.failingPivot ?? 0]})${detail}`,
    ),
  ];
}

export function validateElastic(
  law: LawOf<'elastic_isotropic' | 'elastic_orthotropic' | 'elastic_transversely_isotropic' | 'elastic_anisotropic'>,
  context: ValidateContext,
): MatlIssue[] {
  switch (law.kind) {
    case 'elastic_isotropic': {
      const issues = [
        ...signedParameterIssues(law.E, 'stress', 'model.E', context, 'positive'),
        ...parameterIssues(law.nu, 'dimensionless', 'model.nu', context),
      ];
      if (issues.length > 0) return issues;
      const nu = constantValue(law.nu, 'dimensionless');
      return nu === null ? [] : poissonIssues(nu, 'model.nu');
    }
    case 'elastic_orthotropic': {
      const issues = ORTHO_KEYS.flatMap((key) =>
        key.startsWith('nu')
          ? parameterIssues(law[key], 'dimensionless', `model.${key}`, context)
          : signedParameterIssues(law[key], 'stress', `model.${key}`, context, 'positive'),
      );
      if (issues.length > 0) return issues;
      const constants = constantOrthotropic(law);
      return constants === null ? [] : stabilityIssue(orthotropicReport(constants), 'model');
    }
    case 'elastic_transversely_isotropic': {
      const issues = [
        ...signedParameterIssues(law.Ep, 'stress', 'model.Ep', context, 'positive'),
        ...signedParameterIssues(law.Et, 'stress', 'model.Et', context, 'positive'),
        ...signedParameterIssues(law.Gt, 'stress', 'model.Gt', context, 'positive'),
        ...parameterIssues(law.nuP, 'dimensionless', 'model.nuP', context),
        ...parameterIssues(law.nuPT, 'dimensionless', 'model.nuPT', context),
      ];
      if (issues.length > 0) return issues;
      const [Ep, Et, Gt, nuP, nuPT] = [
        constantValue(law.Ep, 'stress'),
        constantValue(law.Et, 'stress'),
        constantValue(law.Gt, 'stress'),
        constantValue(law.nuP, 'dimensionless'),
        constantValue(law.nuPT, 'dimensionless'),
      ];
      if (Ep === null || Et === null || Gt === null || nuP === null || nuPT === null) return [];
      return stabilityIssue(orthotropicReport(expandTransverselyIsotropic(law.isotropyPlane, Ep, Et, nuP, nuPT, Gt)), 'model');
    }
    case 'elastic_anisotropic': {
      if (law.stiffness.length !== 21 || law.stiffness.some((value) => !Number.isFinite(value)))
        return [invalid('model.stiffness', 'need exactly 21 finite values (upper triangle, row-wise, Voigt order 11 22 33 12 13 23)')];
      const unit = parameterIssues({ value: 1, unit: law.unit }, 'stress', 'model.unit', context);
      if (unit.length > 0) return unit;
      return stabilityIssue(stiffnessReport(symmetricFromUpperTriangle(law.stiffness)), 'model.stiffness');
    }
  }
}
