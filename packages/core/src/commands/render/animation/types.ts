/** Shapes shared by the sources, the overlays and the output of render_animation (PHY-22 MOV §3). */

import type { CadDocument } from '../../../model/types';
import type { Vec3 } from '../../../model/vectors';
import type { ViewpointCamera } from '../../../model/review';

export interface ReadoutValue {
  readonly value: number;
  readonly unit: string;
}

/** The recorded samples around a simulated instant and the blend weight between them (simulation source only). */
export interface FrameSample {
  readonly before: number;
  readonly after: number;
  readonly weight: number;
}

export interface AnimationTimelineEntry {
  readonly frame: number;
  readonly tS: number;
  /** The camera of this frame, present only when the camera moves (walkthrough, orbit). */
  readonly camera?: ViewpointCamera;
  readonly sample?: FrameSample;
  readonly readouts: Readonly<Record<string, ReadoutValue>>;
}

export interface AnimationWarning {
  readonly code: string;
  readonly message: string;
}

/** A named path the trace overlay draws: the whole `path` (document units) and where the traced point is in each frame. */
export interface TraceTrack {
  readonly id: string;
  readonly path: readonly Vec3[];
  readonly at: readonly Vec3[];
}

/** What a motion source hands to the renderer: one document per frame (made on demand), the numbers of every frame and the traces. */
export interface MotionFrames {
  readonly documentAt: (frame: number) => CadDocument;
  readonly timeline: readonly AnimationTimelineEntry[];
  readonly traces: readonly TraceTrack[];
  readonly warnings: readonly AnimationWarning[];
  readonly sampleIntervalS?: number;
}

/** A source that cannot produce frames: a stable code, the reason and the ids concerned. */
export interface SourceRefusal {
  readonly refused: {
    readonly code: string;
    readonly message: string;
    readonly ids?: readonly string[];
    readonly warnings?: readonly AnimationWarning[];
  };
}

export const refusal = (code: string, message: string, ids?: readonly string[], warnings?: readonly AnimationWarning[]): SourceRefusal => ({
  refused: { code, message, ...(ids === undefined ? {} : { ids }), ...(warnings === undefined ? {} : { warnings }) },
});

/** The ids the overlays name: traced points and readout quantities. */
export interface OverlayIds {
  readonly trace: readonly string[];
  readonly readouts: readonly string[];
}

/** `record[id]` for an own key only: a user-supplied id such as "__proto__" or "constructor" finds nothing. */
export const own = <T>(record: Readonly<Record<string, T>>, id: string): T | undefined =>
  Object.hasOwn(record, id) ? record[id] : undefined;
