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

/** One stored pipe-content marker (`add_pipe_markers`, plant 09 VIS §5.7): where it sits on a pipe and the size of its legend. Absolute mm, document coordinates. */
export interface PipeMarker {
  /** `<pipe id>:<k>`, k from 1 along the pipe. */
  readonly id: string;
  /** Building pipe id or 02 RTE run id the marker sits on. */
  readonly pipeId: string;
  readonly positionMm: readonly [number, number, number];
  /** Unit vector along the centreline (from end toward to end) at the marker. */
  readonly tangent: readonly [number, number, number];
  /** Arc length from the start of the pipe. */
  readonly atMm: number;
  /** Why it is there: a valve, flange or direction change within 600 mm, or the straight-run interval. */
  readonly reason: 'valve' | 'flange' | 'bend' | 'interval';
  /** Legend size of the A13.1 table row of the pipe (OD plus covering). */
  readonly fieldLengthMm: number;
  readonly letterHeightMm: number;
  /** The OD lay between two table rows (next larger row taken): a reviewer confirms with the edition in force. */
  readonly bandInterpolated: boolean;
  /** Letters and colour from the profile rule the pipe's service selects, when the profile carries them. */
  readonly letters?: string;
  readonly letterHex?: string;
  /** A both-ways flow arrow (the line is flagged bidirectional) instead of one along the tangent. */
  readonly bidirectional: boolean;
}

export interface DisplayModel {
  colourProfiles: Record<string, ColourProfile>;
  activeProfileId?: string;
  /** Document classes: new ones and overrides of the named defaults (`DEFAULT_MATERIAL_CLASSES`); absent = defaults only. */
  materialClasses?: Record<string, MaterialClass>;
  /** Entity id -> class id (assign_material_class); entries of deleted entities or classes are ignored. */
  materialClassOf?: Record<string, string>;
  /** Stored A13.1 markers by id (add_pipe_markers); a marker whose pipe is gone is reported by check_pipe_markers and drawn by nothing. */
  pipeMarkers?: Record<string, PipeMarker>;
}

export function createDisplayModel(): DisplayModel {
  return { colourProfiles: {} };
}

/** Own-key lookup: `toString` and other prototype names are never profiles. */
export function findProfile(display: DisplayModel, id: string): ColourProfile | undefined {
  return Object.hasOwn(display.colourProfiles, id) ? display.colourProfiles[id] : undefined;
}
