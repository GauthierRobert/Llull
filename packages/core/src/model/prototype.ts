/**
 * Functional-prototype review data of a document (`CadDocument.prototype`, PHY-21): declared interference intents and grounded parts.
 * Check results are NOT stored here (they are recomputable from the document, TECHNICAL_SPEC L4).
 * Reserved for later slices: `references`, `dispositions`, `signatures` (optional fields added without migrating existing documents).
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

export interface PrototypeModel {
  /** Reference data keyed by id (`compare_to_reference`); absent = none. */
  references?: Record<string, ReferenceData>;
  /** Keyed by intent id (`fit-<step>.<k>`). */
  intents: Record<string, InterferenceIntent>;
  /** Entity / instance ids treated as attached to the world, in the order they were marked. */
  grounded: string[];
}

export function createPrototypeModel(): PrototypeModel {
  return { intents: {}, grounded: [] };
}
