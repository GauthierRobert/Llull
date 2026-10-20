import type { CadDocument } from '../../model/types';
import { bisect } from '../../lib/bisect';
import { evaluateMotionInternal } from './jointsKinematics';
import { STOP_TOLERANCE, boundsAtStep, interferes, sweepOverrides } from './interference';

/** Why motion cannot continue past `stopValue`. */
export type StopReason = 'contact' | 'loop_open';

export interface ContactStop {
  /** False when the whole range is free of contact. */
  readonly stopped: boolean;
  /** Last collision-free value (the end of the range when not stopped). */
  readonly stopValue: number;
  readonly reason?: StopReason;
  /** First touching pair of the contact set. */
  readonly pair?: [string, string];
}

interface Sample {
  readonly pair?: [string, string];
  readonly loopOpen: boolean;
}

/**
 * Drive `target` from `from` to `to` in `samples` equal steps and find the first value where a pair of the contact set touches (AABB overlap
 * beyond 1e-9 of the diagonal) or a closed loop stops closing; then bisect the last free interval until it is narrower than `tolerance`.
 * @invariant stopValue is on the free side of the contact, within `tolerance` of it
 */
export function findContactStop(
  doc: CadDocument,
  motion: { mode: 'joint' | 'parameter'; target: string; from: number; to: number },
  pairs: readonly [string, string][],
  samples: number,
  tolerance: number,
): ContactStop {
  let guess: Record<string, readonly number[]> = {};
  const probe = (value: number): Sample => {
    const evaluated = evaluateMotionInternal(doc, sweepOverrides(doc, motion.mode, motion.target, value), guess);
    if (evaluated.loop !== undefined && Object.keys(evaluated.loop.passive).length > 0) {
      if (!evaluated.loop.closed) return { loopOpen: true };
      guess = evaluated.loop.passive;
    }
    if (pairs.length === 0) return { loopOpen: false };
    const bounds = boundsAtStep(doc, evaluated);
    const touching = pairs.find(([a, b]) => {
      const [boundsA, boundsB] = [bounds[a], bounds[b]];
      return boundsA !== undefined && boundsB !== undefined && interferes(boundsA, boundsB, STOP_TOLERANCE);
    });
    return { loopOpen: false, ...(touching ? { pair: touching } : {}) };
  };
  const blocked = (sample: Sample): boolean => sample.loopOpen || sample.pair !== undefined;
  const value = (k: number): number => motion.from + ((motion.to - motion.from) * k) / samples;
  for (let k = 0; k <= samples; k++) {
    const sample = probe(value(k));
    if (!blocked(sample)) continue;
    const reason: StopReason = sample.loopOpen ? 'loop_open' : 'contact';
    if (k === 0) return { stopped: true, stopValue: motion.from, reason, ...(sample.pair ? { pair: sample.pair } : {}) };
    const [free, hit] = [value(k - 1), value(k)];
    const steps = Math.min(60, Math.max(1, Math.ceil(Math.log2(Math.abs(hit - free) / tolerance))));
    const { low } = bisect((v) => !blocked(probe(v)), free, hit, steps);
    return { stopped: true, stopValue: low, reason, ...(sample.pair ? { pair: sample.pair } : {}) };
  }
  return { stopped: false, stopValue: motion.to };
}
