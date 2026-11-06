/**
 * The `sweep` source of render_animation (FR-MOV-03): one joint value or document parameter driven from `start` to `end` over the frames (optionally
 * there and back), the instance poses from `evaluateMotionInternal` with `sweepOverrides` — the code path of motion_study, so loop closure and limits agree.
 */

import type { CadDocument } from '../../../model/types';
import type { Vec3 } from '../../../model/vectors';
import { JOINT_DOF } from '../../../model/joints';
import { evaluateMotionInternal } from '../../motion/jointsKinematics';
import { sweepOverrides } from '../../motion/interference';
import { RAD_TO_DEG } from './readouts';
import { frameTime } from './timeline';
import {
  own,
  refusal,
  type AnimationTimelineEntry,
  type AnimationWarning,
  type MotionFrames,
  type OverlayIds,
  type ReadoutValue,
  type SourceRefusal,
  type TraceTrack,
} from './types';

export interface SweepSourceInput {
  readonly mode: 'joint' | 'parameter';
  readonly target: string;
  readonly start: number;
  readonly end: number;
  readonly pingPong: boolean;
  readonly fps: number;
  readonly frames: number;
}

/** Sweep fraction s_k of frame `k`: k / (frames - 1), or there and back. */
export function sweepFraction(k: number, frames: number, pingPong: boolean): number {
  if (frames <= 1) return 0;
  const along = k / (frames - 1);
  return pingPong ? 1 - Math.abs(1 - 2 * along) : along;
}

interface SweepFrame {
  readonly value: number;
  readonly positions: Record<string, Vec3>;
  readonly rotations: Record<string, Vec3>;
  readonly joints: Record<string, number>;
}

const idsText = (ids: readonly string[]): string => ids.join(', ');

/** Frames of the swept mechanism, or the reason there are none. */
export function sweepSource(doc: CadDocument, input: SweepSourceInput, ids: OverlayIds): MotionFrames | SourceRefusal {
  const { mode, target } = input;
  if (mode === 'joint' ? own(doc.joints, target) === undefined : !Object.hasOwn(doc.parameters, target))
    return refusal(
      'MOV_NO_MOTION',
      `sweep: no ${mode} '${target}' in the document (joints: ${idsText(Object.keys(doc.joints)) || 'none'})`,
      [target],
    );
  if (mode === 'parameter' && typeof doc.parameters[target]?.value !== 'number')
    return refusal('MOV_NO_MOTION', `sweep: parameter '${target}' is not numeric`, [target]);
  if (input.start === input.end) return refusal('MOV_NO_MOTION', `sweep: start equals end (${input.start}); nothing moves`);
  const unknownReadouts = ids.readouts.filter((id) => own(doc.joints, id) === undefined && !Object.hasOwn(doc.parameters, id));
  if (unknownReadouts.length > 0)
    return refusal('MOV_UNKNOWN_ID', `readouts: no joint or parameter ${idsText(unknownReadouts)}`, unknownReadouts);
  const unknownTrace = ids.trace.filter((id) => own(doc.entities, id) === undefined);
  if (unknownTrace.length > 0) return refusal('MOV_UNKNOWN_ID', `trace: no entity ${idsText(unknownTrace)}`, unknownTrace);

  const swept: SweepFrame[] = [];
  const open: number[] = [];
  let guess: Record<string, readonly number[]> = {};
  for (let k = 0; k < input.frames; k += 1) {
    const value = input.start + (input.end - input.start) * sweepFraction(k, input.frames, input.pingPong);
    const evaluated = evaluateMotionInternal(doc, sweepOverrides(doc, mode, target, value), guess);
    if (evaluated.loop !== undefined) {
      if (evaluated.loop.closed) guess = evaluated.loop.passive;
      else open.push(k);
    }
    swept.push({ value, positions: evaluated.instancePositions, rotations: evaluated.instanceRotations, joints: evaluated.resolvedJoints });
  }
  const documentAt = (frame: number): CadDocument => {
    const step = swept[frame];
    if (step === undefined) return doc;
    const entities: CadDocument['entities'] = { ...doc.entities };
    for (const [id, position] of Object.entries(step.positions)) {
      const entity = doc.entities[id];
      const rotation = step.rotations[id];
      if (entity !== undefined && rotation !== undefined) entities[id] = { ...entity, position, rotation };
    }
    return { ...doc, entities };
  };
  const readoutOf = (id: string, step: SweepFrame): ReadoutValue => {
    const joint = own(doc.joints, id);
    if (joint === undefined) {
      const stored = doc.parameters[id]?.value;
      return { value: id === target ? step.value : typeof stored === 'number' ? stored : 0, unit: '' };
    }
    const value = step.joints[id] ?? 0;
    return JOINT_DOF[joint.kind][0] === 'r' ? { value: value * RAD_TO_DEG, unit: 'deg' } : { value, unit: doc.units };
  };
  const timeline = swept.map(
    (step, k): AnimationTimelineEntry => ({
      frame: k,
      tS: frameTime(k, input.fps, 1),
      readouts: Object.fromEntries(ids.readouts.map((id) => [id, readoutOf(id, step)])),
    }),
  );
  const traces = ids.trace.map((id): TraceTrack => {
    const at = swept.map((step): Vec3 => step.positions[id] ?? doc.entities[id]?.position ?? [0, 0, 0]);
    return { id, path: at, at };
  });
  const warnings: AnimationWarning[] =
    open.length === 0
      ? []
      : [
          {
            code: 'MOV_LOOP_OPEN',
            message: `the closed loop does not close at ${open.length} frame(s) (first: ${open.slice(0, 5).join(', ')}): the drawn pose there is the best the solver found`,
          },
        ];
  return { documentAt, timeline, traces, warnings };
}
