/**
 * How a fitting end meets the pipe (02 RTE §5.3, §5.4; V1 socket-weld and threaded engagement): the connection rule of the end pair and the
 * dimension of the catalogue row that tells how far the pipe goes inside the fitting.
 *
 * - butt weld (BW-BW): the pipe ends at the fitting end, less the weld gap of the rule (default 0).
 * - socket weld (SW-PL): the pipe enters the socket to the bottom, then is drawn back by the socket gap (B31.3 328.5.2: 1.6 mm, named default
 *   `SOCKET_GAP_MM` of `specLookup`); it sits `socketDepth - gap` inside the fitting.
 * - threaded (SC-SC): the pipe is screwed in by the row `threadEngagement`.
 * The pipe end type comes from the spec's pipe component (`ends`: BE = BW, PE = PL, THD = SC), never from the fitting.
 * @invariant the stack gap of a socket / threaded join is negative: the pipe piece starts inside the fitting, so its cut length includes the engagement
 */

import type { EndType, Joint } from '@aec/plant/types';
import type { SpecLookup } from './specLookup';

export interface Join {
  /** End type of the fitting. */
  readonly end: EndType;
  /** End type of the pipe facing it. */
  readonly pipeEnd: EndType;
  readonly joint: Joint['kind'];
  /** Gap of the joint stack: the butt-weld root gap, or minus the engagement (the pipe piece starts that far inside the fitting). */
  readonly gapMm: number;
  /** Value stored in `Joint.gapMm`: the butt-weld gap or the socket root gap (0 for a thread). */
  readonly rootGapMm: number;
  /** How far the pipe goes into the fitting, mm (0 for a butt weld). */
  readonly engagementMm: number;
}

export interface JoinFailure {
  readonly code: 'RTE_NO_CONNECTION_RULE' | 'RTE_SPEC_NO_COMPONENT';
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export const isJoinFailure = (value: Join | JoinFailure): value is JoinFailure => 'code' in value;

/** The end type of a fitting row: its first end (a row without ends is a butt-weld part). */
export const fittingEnd = (row: { readonly ends: readonly EndType[] }): EndType => row.ends[0] ?? 'BW';

/**
 * The join of a fitting end `end` to a pipe whose end is `pipeEnd`; `dims` are the row's dimensions (`socketDepth`, `threadEngagement`).
 * @failure no rule for the pair (e.g. BW fitting on plain-end pipe) -> RTE_NO_CONNECTION_RULE; the row lacks the depth -> RTE_SPEC_NO_COMPONENT naming it
 */
export function joinFrom(
  lookup: SpecLookup,
  end: EndType,
  pipeEnd: EndType,
  dims: Readonly<Record<string, number>>,
  rowKey: string,
): Join | JoinFailure {
  const rule = lookup.connection(end, pipeEnd);
  if (rule === null)
    return {
      code: 'RTE_NO_CONNECTION_RULE',
      message: `spec ${lookup.id} has no rule joining a ${end} end (${rowKey}) to its pipe (${pipeEnd} ends): butt weld BW-BW, socket weld SW-PL, threaded SC-SC, flanged FL-FL`,
      detail: { endType: end, pipeEndType: pipeEnd },
    };
  if (rule.joint === 'socketWeld') {
    const depth = dims['socketDepth'];
    if (depth === undefined || !(depth > rule.gapMm))
      return {
        code: 'RTE_SPEC_NO_COMPONENT',
        message: `socket-weld row ${rowKey} needs a socketDepth (B16.11 J) greater than the socket gap ${rule.gapMm} mm to cut the pipe back; import a catalogue row with it`,
        detail: { dimension: 'socketDepth', socketGapMm: rule.gapMm },
      };
    const engagement = depth - rule.gapMm;
    return { end, pipeEnd, joint: 'socketWeld', gapMm: -engagement, rootGapMm: rule.gapMm, engagementMm: engagement };
  }
  if (rule.joint === 'threaded') {
    const engagement = dims['threadEngagement'];
    if (engagement === undefined || !(engagement > 0))
      return {
        code: 'RTE_SPEC_NO_COMPONENT',
        message: `threaded row ${rowKey} needs a threadEngagement (how far the pipe is screwed in, mm); import a catalogue row with it`,
        detail: { dimension: 'threadEngagement' },
      };
    return { end, pipeEnd, joint: 'threaded', gapMm: -engagement, rootGapMm: 0, engagementMm: engagement };
  }
  return { end, pipeEnd, joint: rule.joint, gapMm: rule.gapMm, rootGapMm: rule.gapMm, engagementMm: 0 };
}
