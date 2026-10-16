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

export interface PrototypeModel {
  /** Keyed by intent id (`fit-<step>.<k>`). */
  intents: Record<string, InterferenceIntent>;
  /** Entity / instance ids treated as attached to the world, in the order they were marked. */
  grounded: string[];
}

export function createPrototypeModel(): PrototypeModel {
  return { intents: {}, grounded: [] };
}
