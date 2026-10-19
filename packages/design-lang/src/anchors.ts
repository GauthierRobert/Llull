/**
 * Anchors: `alias.side` -> a world point. On a live solid with an exact kernel the point lies inside the real planar face facing that side
 * (`inspect_faces`, OCC); otherwise it is the centre of that side of the alias's axis-aligned box. A consumed alias keeps the box it had
 * when it was created, so `base.bottom` still locates a face of the boolean that consumed `base`.
 */

import { execute } from '@core/commands/registry';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import type { FaceDetail } from '@core/geometry/kernelPorts';

export interface Frame {
  readonly min: Vec3;
  readonly max: Vec3;
}

const AXIS: Readonly<Record<string, { readonly axis: 0 | 1 | 2; readonly sign: 1 | -1 }>> = {
  top: { axis: 2, sign: 1 },
  bottom: { axis: 2, sign: -1 },
  back: { axis: 1, sign: 1 },
  front: { axis: 1, sign: -1 },
  right: { axis: 0, sign: 1 },
  left: { axis: 0, sign: -1 },
};

/** The opposite side (`top` <-> `bottom`, …); `center` is its own opposite. */
const OPPOSITE: Readonly<Record<string, string>> = {
  top: 'bottom',
  bottom: 'top',
  back: 'front',
  front: 'back',
  right: 'left',
  left: 'right',
  center: 'center',
};

const merge = (a: Frame, b: Frame): Frame => ({
  min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
  max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
});

/** Combined world box of `ids` (2D shapes included), or null when none has bounds. */
export function frameOf(doc: CadDocument, ids: readonly string[], ctx?: ExecutionContext): Frame | null {
  let frame: Frame | null = null;
  for (const id of ids) {
    const data = execute(doc, 'measure_bounding_box', { entityId: id }, ctx).data as Frame | undefined;
    if (data !== undefined) frame = frame === null ? data : merge(frame, data);
  }
  return frame;
}

/** Centre of `side` of the box (`center` = the box centre). */
export function sidePoint(frame: Frame, side: string): Vec3 {
  const centre: Vec3 = [(frame.min[0] + frame.max[0]) / 2, (frame.min[1] + frame.max[1]) / 2, (frame.min[2] + frame.max[2]) / 2];
  const spec = AXIS[side];
  if (spec === undefined) return centre;
  const point: [number, number, number] = [...centre];
  point[spec.axis] = spec.sign > 0 ? frame.max[spec.axis] : frame.min[spec.axis];
  return point;
}

/**
 * A point inside the planar face of `entityId` facing `side`, or null when the kernel has no exact faces (Manifold: `inspect_faces` is
 * refused) or no planar face faces that way.
 */
export function exactFacePoint(doc: CadDocument, entityId: string, side: string, ctx?: ExecutionContext): Vec3 | null {
  const result = execute(doc, 'inspect_faces', { entityId, samples: 9 }, ctx);
  const faces = (result.data as { faces?: readonly FaceDetail[] } | undefined)?.faces;
  return result.error !== undefined || faces === undefined ? null : facingFacePoint(faces, side);
}

/**
 * Of the planar faces facing `side`, the outermost along that direction (the largest on a tie): its sample point nearest its centroid,
 * else the centroid; null when none faces that way (or for `center`).
 */
export function facingFacePoint(faces: readonly FaceDetail[], side: string): Vec3 | null {
  const spec = AXIS[side];
  if (spec === undefined) return null;
  const facing = faces.filter((f) => f.normal !== undefined && f.normal[spec.axis] * spec.sign > 0.999);
  const along = (f: FaceDetail): number => f.centroid[spec.axis] * spec.sign;
  const tolerance = 1e-6 * Math.max(1, ...facing.map((f) => Math.abs(along(f))));
  const outermost = Math.max(...facing.map(along));
  const best = facing.filter((f) => along(f) >= outermost - tolerance).sort((a, b) => b.area - a.area)[0];
  if (best === undefined) return null;
  const distance = (p: Vec3): number => Math.hypot(p[0] - best.centroid[0], p[1] - best.centroid[1], p[2] - best.centroid[2]);
  return [...best.samples].sort((a, b) => distance(a) - distance(b))[0] ?? best.centroid;
}

/**
 * Translation that puts `created`'s opposite side centre on the anchor point `to` (on `target`'s `side`), then makes `align` sides flush
 * with `target` (`center` stacks centre on centre).
 */
export function placementDelta(created: Frame, to: Vec3, target: Frame, side: string, align: string | null): Vec3 {
  const from = sidePoint(created, OPPOSITE[side] ?? 'center');
  const delta: [number, number, number] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const flush = align === null ? undefined : AXIS[align];
  if (flush !== undefined) {
    const edge = (frame: Frame): number => (flush.sign > 0 ? frame.max[flush.axis] : frame.min[flush.axis]);
    delta[flush.axis] = edge(target) - edge(created);
  }
  return delta;
}
