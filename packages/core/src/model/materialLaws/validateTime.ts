/** Validation of the time-dependent laws: Prony viscoelasticity with shift (§5.8) and creep (§5.8). */

import type { LawOf } from '../materialModel';
import { constantValue, error, invalid, parameterIssues, positiveNumber, type MatlIssue, type ValidateContext } from './issues';

const seriesIssues = (
  terms: ReadonlyArray<{ readonly weight: number; readonly tau: { readonly value: number; readonly unit: string } }>,
  field: string,
  context: ValidateContext,
): MatlIssue[] => {
  const issues: MatlIssue[] = [];
  terms.forEach((term, i) => {
    const path = `model.${field}[${i}]`;
    const shape = parameterIssues(term.tau, 'time', `${path}.tau`, context);
    if (shape.length > 0) issues.push(...shape);
    else if (!((constantValue(term.tau, 'time') ?? 1) > 0)) issues.push(error('MATL_PRONY_INVALID', `${path}.tau`, 'tau must be > 0'));
    if (!(Number.isFinite(term.weight) && term.weight > 0))
      issues.push(error('MATL_PRONY_INVALID', path, 'each Prony weight must be a finite number > 0'));
  });
  const total = terms.reduce((sum, term) => sum + term.weight, 0);
  if (terms.length > 0 && total >= 1) issues.push(error('MATL_PRONY_INVALID', `model.${field}`, `weights sum to ${total}: Σ must be < 1`));
  return issues;
};

export function validateViscoelastic(law: LawOf<'visco_prony'>, context: ValidateContext): MatlIssue[] {
  if (law.shear.length === 0 && (law.bulk?.length ?? 0) === 0)
    return [error('MATL_PRONY_INVALID', 'model.shear', 'need at least one shear or bulk Prony term')];
  const issues = [
    ...seriesIssues(
      law.shear.map((term) => ({ weight: term.g, tau: term.tau })),
      'shear',
      context,
    ),
    ...seriesIssues(
      (law.bulk ?? []).map((term) => ({ weight: term.k, tau: term.tau })),
      'bulk',
      context,
    ),
  ];
  const shift = law.shift;
  if (shift?.kind === 'wlf') {
    issues.push(
      ...parameterIssues(shift.C2, 'temperature', 'model.shift.C2', context),
      ...parameterIssues(shift.referenceTemperature, 'temperature', 'model.shift.referenceTemperature', context),
      ...positiveNumber(shift.C1, 'model.shift.C1', 'C1'),
    );
    if ((constantValue(shift.C2, 'temperature') ?? 1) <= 0) issues.push(invalid('model.shift.C2', 'C2 must be > 0 K'));
  } else if (shift?.kind === 'arrhenius') {
    issues.push(
      ...parameterIssues(shift.activationEnergy, 'energyPerMole', 'model.shift.activationEnergy', context),
      ...parameterIssues(shift.referenceTemperature, 'temperature', 'model.shift.referenceTemperature', context),
    );
  }
  return issues;
}

export function validateCreep(law: LawOf<'creep_norton' | 'creep_garofalo'>, context: ValidateContext): MatlIssue[] {
  const creep = (path: string, message: string): MatlIssue => error('MATL_CREEP_PARAMS_INVALID', path, message);
  if (law.kind === 'creep_norton') {
    const issues: MatlIssue[] = [];
    if (!(Number.isFinite(law.A) && law.A > 0)) issues.push(creep('model.A', 'A must be a finite number > 0'));
    if (!(Number.isFinite(law.n) && law.n > 0)) issues.push(creep('model.n', 'n must be a finite number > 0'));
    if (!(Number.isFinite(law.m) && law.m > -1)) issues.push(creep('model.m', 'm must be a finite number > −1'));
    issues.push(
      ...parameterIssues({ value: 1, unit: law.stressUnit }, 'stress', 'model.stressUnit', context),
      ...parameterIssues({ value: 1, unit: law.timeUnit }, 'time', 'model.timeUnit', context),
    );
    return issues;
  }
  const issues: MatlIssue[] = [
    ...parameterIssues(law.A, 'rate', 'model.A', context),
    ...parameterIssues(law.alpha, 'inverseStress', 'model.alpha', context),
    ...parameterIssues(law.activationEnergy, 'energyPerMole', 'model.activationEnergy', context),
  ];
  if (issues.length > 0) return issues;
  if (!((constantValue(law.A, 'rate') ?? 1) > 0)) issues.push(creep('model.A', 'A must be > 0'));
  if (!((constantValue(law.alpha, 'inverseStress') ?? 1) > 0)) issues.push(creep('model.alpha', 'alpha must be > 0'));
  if (!(Number.isFinite(law.n) && law.n > 0)) issues.push(creep('model.n', 'n must be a finite number > 0'));
  if (!((constantValue(law.activationEnergy, 'energyPerMole') ?? 0) >= 0))
    issues.push(creep('model.activationEnergy', 'activationEnergy must be ≥ 0'));
  return issues;
}
