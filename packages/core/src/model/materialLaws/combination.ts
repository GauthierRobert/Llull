/** Constitutive-set rules (PHY-02 §3.4) and set resolution: which model fills which slot. */

import { behaviourOf } from '../materialLawCatalog';
import { SET_SLOTS, type ConstitutiveSet, type MaterialModel, type SetSlot } from '../materialModel';
import { appendAll } from '../../lib/appendAll';

export interface CombinationIssue {
  readonly code: 'MATL_COMBINATION_INVALID' | 'MATL_MODEL_NOT_FOUND';
  readonly path: string;
  readonly message: string;
}

const combination = (path: string, message: string): CombinationIssue => ({ code: 'MATL_COMBINATION_INVALID', path, message });

/** The models of a set by slot (missing ids are reported by `combinationIssues`). */
export function setMembers(set: ConstitutiveSet, models: readonly MaterialModel[]): Partial<Record<SetSlot, MaterialModel>> {
  const members: Partial<Record<SetSlot, MaterialModel>> = {};
  for (const slot of SET_SLOTS) {
    const id = set[slot];
    const model = id === undefined ? undefined : models.find((candidate) => candidate.id === id);
    if (model !== undefined) members[slot] = model;
  }
  return members;
}

/**
 * Every rule of §3.4 for one set: slot behaviours, one of elastic / hyperelastic (except Ramberg-Osgood, which carries E and ν),
 * plasticity needs isotropic elasticity (orthotropic with at most linear hardening), creep needs elastic, viscoelastic needs elastic or
 * hyperelastic, a Johnson-Cook rate needs Johnson-Cook hardening and isotropic elasticity, durability kinds are never members.
 */
export function combinationIssues(set: ConstitutiveSet, models: readonly MaterialModel[]): CombinationIssue[] {
  const issues = slotIssues(set, models);
  if (issues.length > 0) return issues;
  const members = setMembers(set, models);
  const elastic = members.elastic?.model;
  const plastic = members.plastic?.model;
  appendAll(issues, elasticPresenceIssues(members, elastic, plastic));
  if (plastic?.kind === 'j2_plasticity') plasticJ2Issues(members, elastic, plastic, issues);
  if (plastic?.kind === 'hill48_plasticity') {
    if (members.hyperelastic !== undefined)
      issues.push(combination('set.plastic', 'hill48_plasticity needs elastic_isotropic or elastic_orthotropic, not a hyperelastic law'));
    else if (elastic !== undefined && elastic.kind !== 'elastic_isotropic' && elastic.kind !== 'elastic_orthotropic')
      issues.push(combination('set.plastic', `hill48_plasticity needs elastic_isotropic or elastic_orthotropic, not ${elastic.kind}`));
  }
  if (members.creep !== undefined && elastic?.kind !== 'elastic_isotropic' && elastic?.kind !== 'elastic_orthotropic')
    issues.push(combination('set.creep', 'creep needs an elastic_isotropic or elastic_orthotropic model in the set'));
  if (members.viscoelastic !== undefined && elastic === undefined && members.hyperelastic === undefined)
    issues.push(combination('set.viscoelastic', 'viscoelastic needs an elastic or a hyperelastic model in the set'));
  appendAll(issues, rateIssues(members, elastic, plastic));
  return issues;
}

type Members = Partial<Record<SetSlot, MaterialModel>>;
type Law = MaterialModel['model'];

function slotIssues(set: ConstitutiveSet, models: readonly MaterialModel[]): CombinationIssue[] {
  const issues: CombinationIssue[] = [];
  for (const slot of SET_SLOTS) {
    const id = set[slot];
    if (id === undefined) continue;
    const model = models.find((candidate) => candidate.id === id);
    if (model === undefined) {
      issues.push({ code: 'MATL_MODEL_NOT_FOUND', path: `set.${slot}`, message: `no material model '${id}'` });
    } else if (behaviourOf(model.model) !== slot) {
      issues.push(combination(`set.${slot}`, `'${id}' is a ${model.model.kind} (${behaviourOf(model.model)}), not a ${slot} law`));
    }
  }
  return issues;
}

function elasticPresenceIssues(members: Members, elastic: Law | undefined, plastic: Law | undefined): CombinationIssue[] {
  if (plastic?.kind === 'ramberg_osgood') {
    if (elastic !== undefined || members.hyperelastic !== undefined)
      return [
        combination('set.elastic', 'ramberg_osgood carries E and ν itself: the set must not also name an elastic or hyperelastic model'),
      ];
  } else if (elastic !== undefined && members.hyperelastic !== undefined) {
    return [combination('set.hyperelastic', 'a set has exactly one of elastic / hyperelastic')];
  } else if (elastic === undefined && members.hyperelastic === undefined) {
    return [combination('set.elastic', 'a set needs an elastic or a hyperelastic model (or a ramberg_osgood plastic model)')];
  }
  return [];
}

function plasticJ2Issues(
  members: Members,
  elastic: Law | undefined,
  plastic: Extract<Law, { kind: 'j2_plasticity' }>,
  issues: CombinationIssue[],
): void {
  if (members.hyperelastic !== undefined)
    issues.push(combination('set.plastic', 'j2_plasticity needs elastic_isotropic or elastic_orthotropic, not a hyperelastic law'));
  else if (elastic?.kind === 'elastic_orthotropic') {
    const linearOnly =
      (plastic.isotropic.kind === 'perfect' || plastic.isotropic.kind === 'linear') &&
      (plastic.kinematic.kind === 'none' || plastic.kinematic.kind === 'linear');
    if (!linearOnly) issues.push(combination('set.plastic', 'with elastic_orthotropic only perfect / linear hardening is allowed'));
  } else if (elastic !== undefined && elastic.kind !== 'elastic_isotropic') {
    issues.push(combination('set.plastic', `j2_plasticity needs elastic_isotropic or elastic_orthotropic, not ${elastic.kind}`));
  }
}

function rateIssues(members: Members, elastic: Law | undefined, plastic: Law | undefined): CombinationIssue[] {
  const rate = members.rate?.model;
  if (rate === undefined) return [];
  if (plastic?.kind !== 'j2_plasticity') return [combination('set.rate', 'a rate law needs a j2_plasticity model in the set')];
  if (rate.kind === 'rate_johnson_cook' && (plastic.isotropic.kind !== 'johnson_cook' || elastic?.kind !== 'elastic_isotropic'))
    return [combination('set.rate', 'rate_johnson_cook needs isotropic hardening johnson_cook and elastic_isotropic')];
  return [];
}

/** Resolve a set id (explicit, else the default) on a material; null when none. */
export const findSet = (sets: readonly ConstitutiveSet[] | undefined, id: string | undefined): ConstitutiveSet | undefined =>
  id === undefined ? undefined : sets?.find((candidate) => candidate.id === id);
