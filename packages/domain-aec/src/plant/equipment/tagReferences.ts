/** Pure helpers of a tag rename (plant 08 DAT §13.8): references to a renamed tag, and the colour rules that name it. */

import type { ColourProfile, ColourRule, PropertyValue, RulePredicate } from '@core/model/display';
import type { CadDocument } from '@core/model/types';

/** A port id `<tag>:<mark>` or a bare tag, with the equipment tag replaced; undefined when it does not name a renamed equipment. */
export function renamedReference(reference: string | undefined, renames: ReadonlyMap<string, string>): string | undefined {
  if (reference === undefined) return undefined;
  const colon = reference.indexOf(':');
  const base = colon < 0 ? reference : reference.slice(0, colon);
  const next = renames.get(base);
  return next === undefined ? undefined : `${next}${colon < 0 ? '' : reference.slice(colon)}`;
}

/**
 * The renames (old mark -> new mark) a colour rule may follow: a rule on a mark that another, not renamed element still carries keeps matching that
 * element, so it stays. `renamedIds` are the elements of the batch; a swap (A -> B, B -> A) is followable.
 */
export function followableRenames(
  elements: Readonly<Record<string, { readonly mark: string }>>,
  renamedIds: ReadonlySet<string>,
  renames: ReadonlyMap<string, string>,
): Map<string, string> {
  const held = new Set<string>();
  for (const [id, element] of Object.entries(elements)) if (!renamedIds.has(id)) held.add(element.mark);
  return new Map([...renames].filter(([from]) => !held.has(from)));
}

export interface RuleFollow {
  readonly document: CadDocument;
  /** `<profileId>/<ruleId>` of the rules whose `mark` clauses were rewritten. */
  readonly followed: readonly string[];
  /** `<profileId>/<ruleId>` of rules with a `mark` regular expression that matched an old mark: they cannot be rewritten and now stop matching it. */
  readonly patterned: readonly string[];
}

interface Walk {
  changed: boolean;
  patterned: boolean;
}

function followPredicate(predicate: RulePredicate, renames: ReadonlyMap<string, string>, walk: Walk): RulePredicate {
  let next = predicate;
  if (predicate.property === 'mark') {
    const swap = (value: PropertyValue): PropertyValue => {
      if (typeof value !== 'string') return value;
      const lower = value.toLowerCase();
      for (const [from, to] of renames) if (from.toLowerCase() === lower) return to;
      return value;
    };
    if (predicate.equals !== undefined) {
      const equals = swap(predicate.equals);
      if (equals !== predicate.equals) {
        next = { ...next, equals };
        walk.changed = true;
      }
    }
    if (predicate.in !== undefined) {
      const list = predicate.in.map(swap);
      if (list.some((value, index) => value !== predicate.in?.[index])) {
        next = { ...next, in: list };
        walk.changed = true;
      }
    }
    if (predicate.matches !== undefined) {
      try {
        const pattern = new RegExp(predicate.matches, 'i');
        if ([...renames.keys()].some((from) => pattern.test(from))) walk.patterned = true;
      } catch {
        // an invalid pattern never matched anything
      }
    }
  }
  if (predicate.any !== undefined) {
    const parts = predicate.any.map((part) => followPredicate(part, renames, walk));
    if (parts.some((part, index) => part !== predicate.any?.[index])) next = { ...next, any: parts };
  }
  return next;
}

/**
 * Rewrites the `mark` clauses (`equals`, `in`) of every colour rule from an old mark to its new one, all renames at once (a swap stays a swap).
 * @invariant pure; `document` is the argument itself when no rule names a renamed mark
 */
export function followMarkInColourRules(doc: CadDocument, renames: ReadonlyMap<string, string>): RuleFollow {
  const display = doc.display;
  if (display === undefined || renames.size === 0) return { document: doc, followed: [], patterned: [] };
  const followed: string[] = [];
  const patterned: string[] = [];
  const profiles: Record<string, ColourProfile> = {};
  let anyProfile = false;
  for (const [profileId, profile] of Object.entries(display.colourProfiles)) {
    let profileChanged = false;
    const rules = profile.rules.map((rule): ColourRule => {
      const walk: Walk = { changed: false, patterned: false };
      const when = followPredicate(rule.when, renames, walk);
      if (walk.patterned) patterned.push(`${profileId}/${rule.id}`);
      if (!walk.changed) return rule;
      followed.push(`${profileId}/${rule.id}`);
      profileChanged = true;
      return { ...rule, when };
    });
    profiles[profileId] = profileChanged ? { ...profile, rules } : profile;
    anyProfile ||= profileChanged;
  }
  return { document: anyProfile ? { ...doc, display: { ...display, colourProfiles: profiles } } : doc, followed, patterned };
}
