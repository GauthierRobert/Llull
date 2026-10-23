/**
 * Display model of a document (`CadDocument.display`, plant 09 VIS §3.1): ordered first-match colour profiles keyed on entity properties.
 * Domain-free: schemes (hazard colours, service codes) are produced by plugins as ordinary profiles. Display only: a profile never changes
 * geometry. Material classes arrive with the renderer milestones (VIS-M4/M6).
 */

/** One property value; a key may hold several (see `PropertyBag`). */
export type PropertyValue = string | number | boolean;

/** Predicate on the property bag; every present clause must hold (AND); `any` = OR of sub-predicates. */
export interface RulePredicate {
  /** Property key the clauses below test, e.g. `service`, `line`, `dn`, `layerId`, `kind`, `tag`. */
  readonly property?: string;
  /** String compare is case-insensitive; numbers and booleans exact. */
  readonly equals?: PropertyValue;
  readonly in?: readonly PropertyValue[];
  /** Case-insensitive regular expression, at most 200 characters, no back-references. */
  readonly matches?: string;
  /** Inclusive; numbers only. */
  readonly range?: readonly [number, number];
  readonly any?: readonly RulePredicate[];
}

interface RuleAppearance {
  /** `#rrggbb`. */
  readonly colour: string;
  /** 0..1. */
  readonly transparency?: number;
  readonly hidden?: boolean;
}

/** Where a rule came from, so reports can name the category and colours without knowing the scheme (all names, never hex). */
interface RuleScheme {
  readonly id: string;
  readonly rowId: string;
  readonly category: string;
  /** Named colours of the row, reported as given: e.g. `{ fieldColour: 'green', letterColour: 'white' }` or `{ mainColour: 'green' }`. */
  readonly names: Readonly<Record<string, string>>;
}

export interface ColourRule {
  /** Unique within the profile. */
  readonly id: string;
  readonly when: RulePredicate;
  readonly appearance: RuleAppearance;
  readonly legend: string;
  readonly scheme?: RuleScheme;
}

export interface ColourProfile {
  readonly id: string;
  readonly name: string;
  /** Evaluated in order; the first match wins. */
  readonly rules: readonly ColourRule[];
  /** Colour of an entity no rule matches: `entity` keeps the entity's own colour. */
  readonly defaultColour: 'entity' | string;
  /** Named palette the hex values were drawn from (reports carry it with `approximate: true`). */
  readonly palette: string;
  /** True for a hazard-scheme profile no qualified reviewer has approved yet. */
  readonly reviewRequired: boolean;
}

export interface DisplayModel {
  colourProfiles: Record<string, ColourProfile>;
  activeProfileId?: string;
}

export function createDisplayModel(): DisplayModel {
  return { colourProfiles: {} };
}
