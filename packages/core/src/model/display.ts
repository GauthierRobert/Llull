/**
 * Display model of a document (`CadDocument.display`, plant 09 VIS §3.1): ordered first-match colour profiles keyed on entity properties.
 * Domain-free: schemes (colour schemes) are produced by plugins as ordinary profiles. Display only: a profile never changes
 * geometry. Material classes (`MaterialClass`) are named appearance classes assigned per entity.
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
  /** Named colours of the source row, reported as given (key -> colour name). */
  readonly names: Readonly<Record<string, string>>;
}

/** Marker legend of a rule (pipe markers, plant 09 VIS-M7): the text drawn on the marker and its colour. */
export interface RuleMarker {
  /** 1..MAX_MARKER_LETTERS characters. */
  readonly letters: string;
  /** `#rrggbb` of the letters; absent when the scheme names no letter colour. */
  readonly letterHex?: string;
}

export const MAX_MARKER_LETTERS = 80;

export interface ColourRule {
  /** Unique within the profile. */
  readonly id: string;
  readonly when: RulePredicate;
  readonly appearance: RuleAppearance;
  readonly legend: string;
  readonly scheme?: RuleScheme;
  readonly marker?: RuleMarker;
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
  /** True while the profile awaits approval by a qualified reviewer (set by the plugin that built it). */
  readonly reviewRequired: boolean;
}

/** A named display class (plant 09 VIS §5.6): appearance only; geometry and `doc.materials` are never touched. */
export interface MaterialClass {
  /** snake_case id, unique; a document class with a default's id overrides the default. */
  readonly id: string;
  readonly name: string;
  /** `#rrggbb`, or null to keep the entity's own colour (and its profile's). */
  readonly colour: string | null;
  /** 0..1. */
  readonly metalness: number;
  /** 0..1. */
  readonly roughness: number;
}

export interface DisplayModel {
  colourProfiles: Record<string, ColourProfile>;
  activeProfileId?: string;
  /** Document classes: new ones and overrides of the named defaults (`DEFAULT_MATERIAL_CLASSES`); absent = defaults only. */
  materialClasses?: Record<string, MaterialClass>;
  /** Entity id -> class id (assign_material_class); entries of deleted entities or classes are ignored. */
  materialClassOf?: Record<string, string>;
}

export function createDisplayModel(): DisplayModel {
  return { colourProfiles: {} };
}

/** Own-key lookup: `toString` and other prototype names are never profiles. */
export function findProfile(display: DisplayModel, id: string): ColourProfile | undefined {
  return Object.hasOwn(display.colourProfiles, id) ? display.colourProfiles[id] : undefined;
}
