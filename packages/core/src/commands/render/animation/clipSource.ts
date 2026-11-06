/** The `clips` source of render_animation (FR-MOV-04): the document's `animate` clips evaluated at t_k by the function the viewport player uses (`geometry/animationPose`). */

import type { CadDocument } from '../../../model/types';
import type { Vec3 } from '../../../model/vectors';
import { animationPoseAt, animationScalar, documentAtAnimation } from '../../../geometry/animationPose';
import { RAD_TO_DEG } from './readouts';
import { frameTime } from './timeline';
import {
  own,
  refusal,
  type AnimationTimelineEntry,
  type AnimationWarning,
  type MotionFrames,
  type OverlayIds,
  type SourceRefusal,
  type TraceTrack,
} from './types';

export interface ClipSourceInput {
  readonly fps: number;
  readonly frames: number;
}

const idsText = (ids: readonly string[]): string => ids.join(', ');

/** Frames of the clip animation, or the reason there are none. */
export function clipSource(doc: CadDocument, input: ClipSourceInput, ids: OverlayIds): MotionFrames | SourceRefusal {
  const clips = Object.values(doc.animations);
  const skipped = clips.filter((clip) => clip.trigger !== 'auto');
  const warnings: AnimationWarning[] =
    skipped.length === 0
      ? []
      : [
          {
            code: 'MOV_CLICK_CLIPS_SKIPPED',
            message: `${skipped.length} click clip(s) do not play in a render: ${idsText(skipped.map((clip) => clip.id))} (set trigger auto)`,
          },
        ];
  if (clips.length === skipped.length)
    return refusal('MOV_NO_MOTION', 'the document has no auto animation clip: add one with animate (trigger auto)', undefined, warnings);
  const unknownReadouts = ids.readouts.filter((id) => own(doc.animations, id) === undefined);
  if (unknownReadouts.length > 0)
    return refusal(
      'MOV_UNKNOWN_ID',
      `readouts: no animation clip ${idsText(unknownReadouts)} (a clip id from animate)`,
      unknownReadouts,
      warnings,
    );
  const unknownTrace = ids.trace.filter((id) => own(doc.entities, id) === undefined);
  if (unknownTrace.length > 0) return refusal('MOV_UNKNOWN_ID', `trace: no entity ${idsText(unknownTrace)}`, unknownTrace, warnings);
  const times = Array.from({ length: input.frames }, (_, k) => frameTime(k, input.fps, 1));
  const timeline = times.map(
    (t, k): AnimationTimelineEntry => ({
      frame: k,
      tS: t,
      readouts: Object.fromEntries(
        ids.readouts.map((id) => {
          const clip = own(doc.animations, id);
          const scalar = clip === undefined ? 0 : animationScalar(clip, t);
          return [id, clip?.channel === 'rotation' ? { value: scalar * RAD_TO_DEG, unit: 'deg' } : { value: scalar, unit: doc.units }];
        }),
      ),
    }),
  );
  const traces = ids.trace.map((id): TraceTrack => {
    const at = times.map((t): Vec3 => animationPoseAt(doc, t)[id]?.position ?? doc.entities[id]?.position ?? [0, 0, 0]);
    return { id, path: at, at };
  });
  return { documentAt: (frame) => documentAtAnimation(doc, times[frame] ?? 0), timeline, traces, warnings };
}
