/** Shapes of the robustness fuzz (SC-Q3): a seeded design is a base step plus feature steps, each a short list of plan actions. */

/** One `build_project` action. `$body` names the current solid; a step's last mutating action rebinds it with `as: 'body'`. */
export interface FuzzAction {
  readonly command: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly as?: string;
}

export const FUZZ_FEATURE_KINDS = ['join', 'cut', 'fillet', 'chamfer', 'shell', 'hole', 'pattern'] as const;
export type FuzzFeatureKind = (typeof FUZZ_FEATURE_KINDS)[number];
type FuzzStepKind = 'base' | FuzzFeatureKind;

/** What the step may do to the solid's volume: `add` never removes, `remove` never adds, `any` (blends on concave edges add). */
type VolumeEffect = 'add' | 'remove' | 'any';

export interface FuzzStep {
  readonly kind: FuzzStepKind;
  readonly effect: VolumeEffect;
  /** Short human description, e.g. "cut box 10x5 depth 7.5 at (2.5, 0)". */
  readonly label: string;
  readonly actions: readonly FuzzAction[];
}

export interface FuzzCase {
  readonly seed: number;
  readonly steps: readonly FuzzStep[];
}

type FuzzCheck =
  | 'command_failed'
  | 'not_solid'
  | 'bad_volume'
  | 'volume_added_by_removal'
  | 'volume_removed_by_addition'
  | 'identity_union'
  | 'identity_subtract';

export interface FuzzFailure {
  /** Step index in the case (0 = base); -1 for a boolean identity failure. */
  readonly step: number;
  readonly kind: FuzzStepKind | 'identity';
  readonly check: FuzzCheck;
  readonly message: string;
}
