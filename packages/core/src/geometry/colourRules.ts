/**
 * First-match colour rules (plant 09 VIS §5.1): validate a profile, compile its predicates once, resolve the rule an entity's property bag
 * selects. Pure; no document access, no geometry.
 */

import type { ColourProfile, ColourRule, PropertyValue, RulePredicate } from '../model/display';
import type { PropertyBag } from '../model/entityProperties';
import { isHexColor } from '../lib/isHexColor';

const MAX_REGEX_LENGTH = 200;
const MAX_PREDICATE_DEPTH = 4;
/** A group that is itself repeated, e.g. `(a+)+`: the classic catastrophic-backtracking shape. */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*{]/;
const BACK_REFERENCE = /\\[1-9]/;

export interface ProfileProblem {
  readonly code: 'VIS_RULE_INVALID' | 'VIS_COLOUR_INVALID';
  readonly path: string;
  readonly message: string;
}

const isRegexSafe = (source: string): string | null => {
  if (source.length > MAX_REGEX_LENGTH) return `regex longer than ${MAX_REGEX_LENGTH} characters`;
  if (BACK_REFERENCE.test(source) || source.includes('\\k<')) return 'regex back-references are not allowed';
  if (NESTED_QUANTIFIER.test(source)) return 'regex with a repeated group containing a quantifier is not allowed';
  try {
    new RegExp(source, 'i');
  } catch {
    return 'regex does not compile';
  }
  return null;
};

/** First problem of a predicate (clauses need `property`, range a <= b, regex safe, `any` non-empty and shallow), or null. */
export function predicateProblem(predicate: RulePredicate, depth = 0): string | null {
  if (depth > MAX_PREDICATE_DEPTH) return `predicates nest deeper than ${MAX_PREDICATE_DEPTH}`;
  const tests = [predicate.equals, predicate.in, predicate.matches, predicate.range].filter((clause) => clause !== undefined);
  if (tests.length > 0 && (predicate.property === undefined || predicate.property.length === 0))
    return 'equals / in / matches / range need `property`';
  if (tests.length === 0 && predicate.any === undefined) return 'predicate has no clause (give property + equals|in|matches|range, or any)';
  if (predicate.in !== undefined && predicate.in.length === 0) return '`in` must list at least one value';
  if (predicate.range !== undefined && !(predicate.range[0] <= predicate.range[1])) return '`range` needs [low, high] with low <= high';
  if (predicate.matches !== undefined) {
    const problem = isRegexSafe(predicate.matches);
    if (problem !== null) return problem;
  }
  if (predicate.any !== undefined) {
    if (predicate.any.length === 0) return '`any` must list at least one predicate';
    for (const sub of predicate.any) {
      const problem = predicateProblem(sub, depth + 1);
      if (problem !== null) return problem;
    }
  }
  return null;
}

const isUnit = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

function ruleProblems(rule: ColourRule, index: number): ProfileProblem[] {
  const path = `rules.${index}`;
  const problems: ProfileProblem[] = [];
  const predicate = predicateProblem(rule.when);
  if (predicate !== null) problems.push({ code: 'VIS_RULE_INVALID', path: `${path}.when`, message: `rule '${rule.id}': ${predicate}` });
  if (!isHexColor(rule.appearance.colour))
    problems.push({
      code: 'VIS_COLOUR_INVALID',
      path: `${path}.appearance.colour`,
      message: `rule '${rule.id}': '${rule.appearance.colour}' is not #rrggbb`,
    });
  const transparency = rule.appearance.transparency;
  if (transparency !== undefined && !isUnit(transparency))
    problems.push({
      code: 'VIS_RULE_INVALID',
      path: `${path}.appearance.transparency`,
      message: `rule '${rule.id}': transparency must be in [0, 1]`,
    });
  return problems;
}

/**
 * Every problem of a profile: bad predicates, non-hex colours, duplicate rule ids, a default colour that is neither `entity` nor hex.
 * @invariant empty array = the profile can be compiled
 */
export function profileProblems(profile: Pick<ColourProfile, 'rules' | 'defaultColour'>): ProfileProblem[] {
  const problems = profile.rules.flatMap((rule, index) => ruleProblems(rule, index));
  const seen = new Set<string>();
  profile.rules.forEach((rule, index) => {
    if (seen.has(rule.id))
      problems.push({ code: 'VIS_RULE_INVALID', path: `rules.${index}.id`, message: `duplicate rule id '${rule.id}'` });
    seen.add(rule.id);
  });
  if (profile.defaultColour !== 'entity' && !isHexColor(profile.defaultColour))
    problems.push({
      code: 'VIS_COLOUR_INVALID',
      path: 'defaultColour',
      message: `'${profile.defaultColour}' is neither 'entity' nor #rrggbb`,
    });
  return problems;
}

type Test = (bag: PropertyBag) => boolean;

const valuesOf = (bag: PropertyBag, key: string): readonly PropertyValue[] => {
  if (!Object.hasOwn(bag, key)) return [];
  const value = bag[key];
  if (value === undefined) return [];
  return typeof value === 'object' ? value : [value];
};

const sameValue = (a: PropertyValue, b: PropertyValue): boolean =>
  typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b;

function compilePredicate(predicate: RulePredicate): Test {
  const tests: Test[] = [];
  const key = predicate.property;
  if (key !== undefined) {
    if (predicate.equals !== undefined) {
      const wanted = predicate.equals;
      tests.push((bag) => valuesOf(bag, key).some((value) => sameValue(value, wanted)));
    }
    if (predicate.in !== undefined) {
      const wanted = predicate.in;
      tests.push((bag) => valuesOf(bag, key).some((value) => wanted.some((candidate) => sameValue(value, candidate))));
    }
    if (predicate.matches !== undefined) {
      const regex = new RegExp(predicate.matches, 'i');
      tests.push((bag) => valuesOf(bag, key).some((value) => regex.test(String(value))));
    }
    if (predicate.range !== undefined) {
      const [low, high] = predicate.range;
      tests.push((bag) => valuesOf(bag, key).some((value) => typeof value === 'number' && value >= low && value <= high));
    }
  }
  if (predicate.any !== undefined) {
    const subs = predicate.any.map(compilePredicate);
    tests.push((bag) => subs.some((sub) => sub(bag)));
  }
  return (bag) => tests.every((test) => test(bag));
}

export interface CompiledProfile {
  readonly profile: ColourProfile;
  /** The first rule whose predicate holds for `bag`, or null (a missing property never matches). */
  select(bag: PropertyBag): ColourRule | null;
}

/**
 * Compile a VALID profile (see `profileProblems`) once; `select` is then O(rules) per entity.
 * @invariant a rule selects only on properties the bag has
 */
export function compileProfile(profile: ColourProfile): CompiledProfile {
  const compiled = profile.rules.map((rule) => ({ rule, test: compilePredicate(rule.when) }));
  return { profile, select: (bag) => compiled.find((entry) => entry.test(bag))?.rule ?? null };
}

function predicateKeys(predicate: RulePredicate, into: Set<string>): void {
  if (predicate.property !== undefined) into.add(predicate.property);
  for (const sub of predicate.any ?? []) predicateKeys(sub, into);
}

/** Property keys any rule of the profile tests. */
export function referencedProperties(profile: ColourProfile): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const rule of profile.rules) predicateKeys(rule.when, keys);
  return keys;
}
