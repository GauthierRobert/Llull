/** First pass over the frames of render_animation: the union of their bounds (for the fixed camera) and which entities move (TR-MOV-08). */

import type { CadDocument } from '../../../model/types';
import { boundsDiagonalRadius, boundsOfPoints, mergeBounds, type Bounds } from '../../../geometry/bounds';
import { computeSceneSnapshot } from '../../inspect/scene';
import type { MotionFrames } from './types';

/** An entity moves when its pose differs between two frames by more than this fraction of the scene size (position) or this many radians (rotation). */
const MOVE_TOLERANCE = 1e-9;

export interface MotionAnalysis {
  /** Union of every frame's scene bounds and every trace point; null when no frame has anything to draw. */
  readonly bounds: Bounds | null;
  /** Ids of the entities whose pose changes during the run, in document order. */
  readonly moving: readonly string[];
}

const angleBetween = (a: number, b: number): number => 2 * Math.abs(Math.sin((a - b) / 2));

/** Bounds and moving entities of `frames` frames of `motion`. */
export function analyseMotion(motion: MotionFrames, frames: number): MotionAnalysis {
  let bounds: Bounds | null = null;
  const first = motion.documentAt(0);
  const travel = new Map<string, { position: number; rotation: number }>();
  const compare = (doc: CadDocument): void => {
    for (const [id, entity] of Object.entries(doc.entities)) {
      const start = first.entities[id];
      if (start === undefined) continue;
      const position = Math.hypot(...entity.position.map((c, i) => c - (start.position[i] ?? 0)));
      const rotation = Math.max(...entity.rotation.map((c, i) => angleBetween(c, start.rotation[i] ?? 0)));
      const seen = travel.get(id);
      travel.set(id, { position: Math.max(seen?.position ?? 0, position), rotation: Math.max(seen?.rotation ?? 0, rotation) });
    }
  };
  for (let k = 0; k < frames; k += 1) {
    const doc = motion.documentAt(k);
    const sceneBounds = computeSceneSnapshot(doc).bounds;
    if (sceneBounds !== null) bounds = bounds === null ? sceneBounds : mergeBounds(bounds, sceneBounds);
    compare(doc);
  }
  for (const trace of motion.traces) if (trace.path.length > 0 && bounds !== null) bounds = mergeBounds(bounds, boundsOfPoints(trace.path));
  const size = bounds === null ? 0 : boundsDiagonalRadius(bounds) * 2;
  const moving = first.order.filter((id) => {
    const moved = travel.get(id);
    return moved !== undefined && (moved.position > MOVE_TOLERANCE * size || moved.rotation > MOVE_TOLERANCE);
  });
  return { bounds, moving };
}
