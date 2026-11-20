/**
 * Which signed records a history replay keeps (SIG-REPLAY). A signed gate stamps each record with the key of the feature step that wrote it; a
 * plugin `replaySeed` keeps a record only while that step is live in the replayed history (not suppressed, not deleted), so suppressing or
 * deleting the disposition step and regenerating drops the decision.
 */

/** What a signed record holds of the step that wrote it. Absent on records written before SIG-REPLAY: those are kept by every replay, as before. */
export interface StepStamped {
  readonly stepKey?: string;
}

/**
 * `{ stepKey }` of the feature step running in `ctx`, to spread into a new signed record; `{}` outside a recorded step (a direct `runCommand`).
 * @invariant pure
 */
export function stepStamp(ctx: { readonly stepKey?: string } | undefined): StepStamped {
  return ctx?.stepKey === undefined ? {} : { stepKey: ctx.stepKey };
}

/**
 * True when a replay whose live step keys are `liveStepKeys` keeps `record`: no live set given (a caller that does not know the history), a
 * legacy record without a step key, or a record whose step is live.
 */
export function survivesReplay(record: StepStamped, liveStepKeys: ReadonlySet<string> | undefined): boolean {
  return liveStepKeys === undefined || record.stepKey === undefined || liveStepKeys.has(record.stepKey);
}

/** The entries of `records` that `survivesReplay` keeps (a new object; the input is not mutated). */
export function survivingRecords<T extends StepStamped>(
  records: Readonly<Record<string, T>>,
  liveStepKeys: ReadonlySet<string> | undefined,
): Record<string, T> {
  return Object.fromEntries(Object.entries(records).filter(([, record]) => survivesReplay(record, liveStepKeys)));
}
