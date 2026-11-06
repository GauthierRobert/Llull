/** Operating points of the valves of the routed piping (02 RTE): the handwheel centre = valve centre + stem direction x catalogue stem height. Millimetre documents only. */

import type { CadDocument } from '@core/model/types';
import { getPiping } from '../../../piping/model';
import { deriveRun } from '../../../piping/routeParts';

export interface ReachTarget {
  readonly tag: string;
  readonly kind: string;
  /** Operating point, absolute mm; null = the source could not locate it (reported, never judged as passing). */
  readonly pointMm: readonly [number, number, number] | null;
  readonly source: 'explicit' | 'valves' | 'nozzles' | 'manways';
  /** What the target comes from: `explicit`, the inline id of the valve or the element id of the equipment. */
  readonly ref: string;
}

export interface ValveTargets {
  readonly targets: ReachTarget[];
  /** Runs that do not derive, so their valves are not targets (code of the derivation failure). */
  readonly skippedRuns: Array<{ runId: string; code: string }>;
}

/** Every valve of every routed run in run order: tag (else the inline id), kind `valve_handwheel`. */
export function valveTargets(doc: CadDocument): ValveTargets {
  const piping = getPiping(doc);
  const targets: ReachTarget[] = [];
  const skippedRuns: ValveTargets['skippedRuns'] = [];
  for (const runId of piping.runOrder) {
    const run = piping.runs[runId];
    if (run === undefined) continue;
    const derived = deriveRun(doc, run);
    if (!derived.ok) {
      skippedRuns.push({ runId, code: derived.code });
      continue;
    }
    for (const inline of derived.inline) {
      if (!inline.type.startsWith('valve')) continue;
      const stem = inline.stemDirection;
      const height = inline.stemHeightMm;
      const located = stem !== undefined && height !== null;
      targets.push({
        tag: inline.tag ?? inline.id,
        kind: 'valve_handwheel',
        pointMm: located
          ? [inline.centre[0] + stem[0] * height, inline.centre[1] + stem[1] * height, inline.centre[2] + stem[2] * height]
          : null,
        source: 'valves',
        ref: inline.id,
      });
    }
  }
  return { targets, skippedRuns };
}
