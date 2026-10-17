/**
 * Structural validation of the durability variants of PHY-07 (fatigue) and PHY-08 (crack growth, toughness): units parse, the leading
 * coefficients are positive where the form requires it. Their physics rules (S-N regimes, NASGRO sub-models, OQ-FRC-02) belong to those packs.
 */

import type { FatigueMaterialModel, CrackGrowthMaterialModel } from '../materialDurability';
import { invalid, parameterIssues, positiveNumber, unitIssues, type MatlIssue, type ValidateContext } from './issues';

type DurabilityLaw = FatigueMaterialModel | CrackGrowthMaterialModel;

const stress = (q: { value: number; unit: string }, path: string, context: ValidateContext): MatlIssue[] =>
  parameterIssues(q, 'stress', path, context);

function tableIssues(points: ReadonlyArray<readonly [number, number]>, path: string): MatlIssue[] {
  const issues: MatlIssue[] = [];
  if (points.length < 2) issues.push(invalid(path, 'a table needs at least 2 points'));
  points.forEach(([x, y], i) => {
    if (!(Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0))
      issues.push(invalid(`${path}[${i}]`, 'both values must be finite and > 0'));
  });
  return issues;
}

export function validateDurability(law: DurabilityLaw, context: ValidateContext): MatlIssue[] {
  const units = unitIssues(law, 'model');
  if (units.length > 0) return units;
  switch (law.kind) {
    case 'sn_basquin':
      return [...stress(law.sigmaF, 'model.sigmaF', context), ...positiveNumber(law.sigmaF.value, 'model.sigmaF.value', 'sigmaF')];
    case 'sn_power_law':
      return [
        ...positiveNumber(law.k, 'model.k', 'k'),
        ...positiveNumber(law.nD, 'model.nD', 'nD'),
        ...stress(law.sD, 'model.sD', context),
      ];
    case 'sn_table':
      return [
        ...(law.families.length === 0 ? [invalid('model.families', 'need at least one family')] : []),
        ...law.families.flatMap((family, i) => tableIssues(family.points, `model.families[${i}].points`)),
      ];
    case 'sn_equivalent_stress':
      return [
        ...[law.a1, law.a2, law.a3, law.a4].flatMap((value, i) =>
          Number.isFinite(value) ? [] : [invalid(`model.a${i + 1}`, 'must be finite')],
        ),
      ];
    case 'en_coffin_manson':
      return [
        ...stress(law.sigmaF, 'model.sigmaF', context),
        ...stress(law.E, 'model.E', context),
        ...positiveNumber(law.epsF, 'model.epsF', 'epsF'),
      ];
    case 'cyclic_ramberg_osgood':
      return [
        ...stress(law.Kprime, 'model.Kprime', context),
        ...stress(law.E, 'model.E', context),
        ...positiveNumber(law.nPrime, 'model.nPrime', "n'"),
      ];
    case 'haigh_table':
      return [
        ...positiveNumber(law.lifeCycles, 'model.lifeCycles', 'lifeCycles'),
        ...(law.points.length < 2 ? [invalid('model.points', 'a table needs at least 2 points')] : []),
      ];
    case 'da_dn_paris':
    case 'da_dn_walker':
      return [...positiveNumber(law.C, 'model.C', 'C'), ...positiveNumber(law.m, 'model.m', 'm')];
    case 'da_dn_forman':
      return [
        ...positiveNumber(law.C, 'model.C', 'C'),
        ...positiveNumber(law.n, 'model.n', 'n'),
        ...positiveNumber(law.Kc, 'model.Kc', 'Kc'),
      ];
    case 'da_dn_nasgro':
      return [...positiveNumber(law.C, 'model.C', 'C'), ...positiveNumber(law.n, 'model.n', 'n')];
    case 'da_dn_table':
      return law.families.flatMap((family, i) => tableIssues(family.points, `model.families[${i}].points`));
    case 'fracture_toughness':
      return law.KIc === undefined && (law.Kc?.length ?? 0) === 0 ? [invalid('model', 'give KIc or a Kc thickness table')] : [];
  }
}
