/** Modelled threads (07 FTR FR-FTR-20): the designation resolved to pitch and major diameter in document units, and the bore check. */

import type { CadDocument } from '../../model/types';
import type { HoleSpec, ThreadSpec } from '../../model/features';
import { fromMm } from '../../model/units';
import { parseThreadDimensions } from '../../lib/threadForm';
import { threadGroove } from '../../geometry/threadTool';

/**
 * `thread` with `modelled: true`, `pitch` and `majorDiameter` (document units) resolved from its designation; a cosmetic thread is returned as is.
 * @failure family `other`, designation without an explicit pitch ("M6") or malformed -> the reason
 */
export function resolveModelledThread(doc: CadDocument, thread: ThreadSpec): ThreadSpec | string {
  if (thread.modelled !== true) return thread;
  const dimensions = thread.family === 'other' ? null : parseThreadDimensions(thread.designation);
  if (dimensions === null)
    return `thread '${thread.designation}' has no modelled form: give an explicit pitch (M6x1, MJ6x1-4H5H) or an inch size and TPI (.1900-32 UNJF-3B)`;
  return { ...thread, pitch: fromMm(doc, dimensions.pitchMm), majorDiameter: fromMm(doc, dimensions.majorDiameterMm) };
}

/** Why the bore of `hole` cannot carry its modelled thread, or null. */
export function threadBoreProblem(hole: HoleSpec): string | null {
  const { thread } = hole;
  if (thread?.modelled !== true || thread.pitch === undefined || thread.majorDiameter === undefined) return null;
  if (threadGroove(hole, { kind: 'through_all' }, 1) !== null) return null;
  const minor = thread.majorDiameter - 1.0825318 * thread.pitch;
  return `bore Ø${hole.diameter} does not fit thread ${thread.designation} (minor Ø${Math.round(minor * 1e4) / 1e4}, major Ø${thread.majorDiameter}): use a bore near the minor diameter`;
}
