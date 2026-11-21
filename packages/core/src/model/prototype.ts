/**
 * Functional-prototype review data of a document (`CadDocument.prototype`, PHY-21): declared interference intents and grounded parts.
 * Check results are NOT stored here (they are recomputable from the document, TECHNICAL_SPEC L4).
 * Optional fields (`references`, `dispositions`) were added without migrating existing documents; `signatures` is deferred (spec 11 Q5).
 */

export const INTENT_KINDS = ['press_fit', 'thread', 'weld', 'overlap_by_design'] as const;

type InterferenceIntentKind = (typeof INTENT_KINDS)[number];

/** Who declared an intent; an agent caller is the conservative default (the context carries no caller yet). */
type DeclaredBy = 'agent' | 'human';

/**
 * A pair of parts that is allowed to overlap, with the reason.
 * @invariant a !== b (unordered pair, stored sorted), reason non-empty
 */
export interface InterferenceIntent {
  readonly id: string;
  a: string;
  b: string;
  kind: InterferenceIntentKind;
  reason: string;
  declaredBy: DeclaredBy;
}

/** Entity property bag of the assembly check (`set_fastener`): a fastener-to-host overlap is FPR_FASTENER_THREAD (info), not a clash. */
export interface EntityTags {
  fastener?: true;
}

export const CONNECTION_KINDS = ['bolted', 'bonded', 'welded', 'press_fit', 'thread'] as const;
type ConnectionKind = (typeof CONNECTION_KINDS)[number];
export const CONNECTION_CYLINDRICAL = ['include', 'exclude', 'only'] as const;

/** Parts a connection group joins, resolved at check time so patterns, layers and groups stay live (FR-ASC-10 / 11). */
export type ConnectionMembers =
  | { readonly ids: readonly string[] }
  | { readonly patternOf: string }
  | { readonly layerId: string }
  | { readonly groupId: string };

/** Contact filter of a group: only member pairs that touch within `toleranceMm` with facing faces (<= `faceAngleDeg` off antiparallel) are joined. */
export interface ConnectionDetect {
  readonly toleranceMm: number;
  readonly faceAngleDeg: number;
  readonly cylindrical: (typeof CONNECTION_CYLINDRICAL)[number];
}

/**
 * A declared rigid connection over a set of parts (TECHNICAL_SPEC 3, 4.3).
 * @invariant id `conn-<step>.<k>`; reason non-empty; touching faces never imply a connection (D2): only a group does
 */
export interface ConnectionGroup {
  readonly id: string;
  name: string;
  kind: ConnectionKind;
  members: ConnectionMembers;
  detect?: ConnectionDetect;
  reason: string;
  declaredBy: 'agent' | 'user';
}

export const REFERENCE_QUANTITIES = [
  'brake_torque_Nm',
  'brake_power_kW',
  'bmep_bar',
  'static_rpm',
  'propeller_rpm',
  'bsfc_g_per_kWh',
] as const;
export type ReferenceQuantity = (typeof REFERENCE_QUANTITIES)[number];

/** One datum of a reference curve: `value`, or a `min`..`max` window (static rpm), at `rpm` when the quantity depends on speed. */
export interface ReferencePoint {
  rpm?: number;
  value: number;
  min?: number;
  max?: number;
  /** Reading / measurement uncertainty of `value` in the quantity's unit (digitised graphs: the reading error). */
  uncertainty?: number;
}

/**
 * Measured or datasheet data to validate against (FR-FPR-77).
 * @invariant points non-empty, every value finite, source non-empty, bandRel > 0, calibrationRpm subset of the point rpms
 */
export interface ReferenceData {
  readonly id: string;
  quantity: ReferenceQuantity;
  condition: { throttle: 'full' | 'propeller_curve'; altitudeM: number; note?: string };
  points: ReferencePoint[];
  source: string;
  grade: 'A' | 'B' | 'C';
  /** Read off a graph (the uncertainty is then the reading error). */
  digitised: boolean;
  /** Points used for calibration: they have `origin: calibrated` and never count as pass evidence. */
  calibrationRpm: number[];
  /** Relative band of a pass, default 0.05 [E-R20]. */
  bandRel: number;
}

export const DISPOSITION_STATUSES = ['not_reviewed', 'relevant', 'irrelevant', 'accepted'] as const;
type DispositionStatus = (typeof DISPOSITION_STATUSES)[number];

/** Review checks a finding key can name (`${check}:${code}:${sorted ids}`). */
export const REVIEW_CHECKS = ['assembly', 'mechanism', 'motion_clearance', 'dynamics'] as const;

/**
 * A reviewer's status and comment on one finding (FR-FPR-31 / 32). Recorded, never applied as a pass: an `accepted` fail stays a fail and
 * reads "fail (accepted)" (spec 11 Q5).
 * @invariant findingKey starts with one of REVIEW_CHECKS + ':'; inputsHash is the check's hash when the disposition was made (the
 *   disposition is stale once the check's hash differs)
 */
export interface Disposition {
  readonly findingKey: string;
  status: DispositionStatus;
  comment: string;
  inputsHash: string;
  /** 'agent' while the execution context carries no caller (spec 11 Q5), like an intent's declaredBy. */
  by: DeclaredBy;
}

export interface PrototypeModel {
  /** Connection groups keyed by id (`add_connection_group`); absent = none. */
  connections?: Record<string, ConnectionGroup>;
  /** Reference data keyed by id (`compare_to_reference`); absent = none. */
  references?: Record<string, ReferenceData>;
  /** Reviewer dispositions keyed by finding key (`set_review_disposition`); absent = none. */
  dispositions?: Record<string, Disposition>;
  /** Keyed by intent id (`fit-<step>.<k>`). */
  intents: Record<string, InterferenceIntent>;
  /** Entity / instance ids treated as attached to the world, in the order they were marked. */
  grounded: string[];
}

export function createPrototypeModel(): PrototypeModel {
  return { intents: {}, grounded: [] };
}

/**
 * The prototype slice a check reads (intents, grounding, references) without the reviewer dispositions: every check hashes this, so recording
 * a disposition never changes a check's inputsHash (and never makes the dispositions stale by itself).
 */
export function checkedPrototype(prototype: PrototypeModel | undefined): PrototypeModel | undefined {
  if (prototype?.dispositions === undefined) return prototype;
  // a copy without the field (rest-spread would leave an unused binding, which the lint config rejects)
  const checked: PrototypeModel = { ...prototype };
  delete checked.dispositions;
  return checked;
}
