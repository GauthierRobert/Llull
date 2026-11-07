/** The `still` source of render_animation (FR-MOV-16): the document as it is, unchanged in every frame; only the camera path (walkthrough, orbit) moves. */

import type { CadDocument } from '../../../model/types';
import { frameTime } from './timeline';
import { refusal, type AnimationTimelineEntry, type MotionFrames, type OverlayIds, type SourceRefusal } from './types';

export interface StillSourceInput {
  readonly fps: number;
  readonly frames: number;
}

/** Frames of an unmoving document, or the refusal when overlays name quantities a still has none of. */
export function stillSource(doc: CadDocument, input: StillSourceInput, ids: OverlayIds): MotionFrames | SourceRefusal {
  const named = [...ids.trace, ...ids.readouts];
  if (named.length > 0)
    return refusal(
      'MOV_UNKNOWN_ID',
      `a still source has nothing to trace or read: drop overlays.trace / overlays.readouts (${named.join(', ')})`,
      named,
    );
  const timeline = Array.from(
    { length: input.frames },
    (_, k): AnimationTimelineEntry => ({ frame: k, tS: frameTime(k, input.fps, 1), readouts: {} }),
  );
  return { documentAt: () => doc, timeline, traces: [], warnings: [] };
}
