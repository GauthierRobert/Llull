/**
 * Mitre corners of a sweep along straight legs (SWG M1 `corners: 'miter'`): at every sharp joint the ring lies in the bisector plane, the section of
 * the incoming leg projected along that leg onto it (and, by the mirror symmetry of the joint, the outgoing leg's section projected back along
 * the outgoing leg). Straight prisms then meet exactly, so the volume of a round section is A (L1 + L2).
 */

import type { CurveSegment } from '../../model/curve';
import type { Vec3 } from '../../model/types';
import { cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { segmentTangent } from '../curveSegments';
import type { SweepFrame } from './frames';
import type { SectionTransform } from './sectionTransform';

/** Largest turn (radians) a mitre joint accepts: beyond it the bisector plane is nearly along the legs. */
export const MITER_MAX_TURN = (150 * Math.PI) / 180;

const IDENTITY: SectionTransform = { twist: 0, sx: 1, sy: 1 };

/** The 2x2 matrix of a law transform (scale then rotation), row-major. */
function lawMatrix({ twist, sx, sy }: SectionTransform): [number, number, number, number] {
  const [c, s] = [Math.cos(twist), Math.sin(twist)];
  return [c * sx, -s * sy, s * sx, c * sy];
}

/** Indices of the frames at sharp joints between consecutive segments (the tangent jumps by more than 1e-6 rad). */
export function sharpJoints(path: ReadonlyArray<CurveSegment<Vec3>>): number[] {
  const joints: number[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [before, after] = [segmentTangent(path[i] as CurveSegment<Vec3>, 1), segmentTangent(path[i + 1] as CurveSegment<Vec3>, 0)];
    if (dot3(before, after) < Math.cos(1e-6)) joints.push(i);
  }
  return joints;
}

/**
 * Frames and transforms with the mitre rings at the sharp joints of \`path\`.
 * @invariant straight legs only: a joint with an arc or Bézier leg is left as built (the command refuses those)
 * @failure none: a turn beyond MITER_MAX_TURN is left unmitred (the command refuses it)
 */
export function applyMiter(
  path: ReadonlyArray<CurveSegment<Vec3>>,
  frames: readonly SweepFrame[],
  transforms: readonly SectionTransform[] | null,
): { frames: SweepFrame[]; transforms: SectionTransform[] } {
  const outFrames = [...frames];
  const outTransforms = frames.map((_, i) => transforms?.[i] ?? IDENTITY);
  for (const segment of sharpJoints(path)) {
    const j = frames.findIndex((frame, i) => frame.segment === segment && frames[i + 1]?.segment === segment + 1);
    const frame = frames[j];
    const [from, to] = [path[segment] as CurveSegment<Vec3>, path[segment + 1] as CurveSegment<Vec3>];
    if (frame === undefined || from.type !== 'line' || to.type !== 'line') continue;
    const [tin, tout] = [segmentTangent(from, 1), segmentTangent(to, 0)];
    const bisector = sub3(tin, scale3(tout, -1));
    if (len3(bisector) < 1e-9 || Math.acos(Math.min(1, dot3(tin, tout))) > MITER_MAX_TURN) continue;
    const tm = normalize3(bisector);
    const stretch = dot3(tin, tm);
    const image = (q: Vec3): Vec3 => sub3(q, scale3(tin, dot3(q, tm) / stretch));
    const lift = (q: Vec3): Vec3 => sub3(q, scale3(tm, dot3(q, tm)));
    const candidate = [lift(frame.normal), lift(frame.binormal)];
    const nm = normalize3(len3(candidate[0] as Vec3) >= len3(candidate[1] as Vec3) ? (candidate[0] as Vec3) : (candidate[1] as Vec3));
    const bm = cross3(tm, nm);
    const [in1, ib1] = [image(frame.normal), image(frame.binormal)];
    const m: [number, number, number, number] = [dot3(in1, nm), dot3(ib1, nm), dot3(in1, bm), dot3(ib1, bm)];
    const [a, b, c, d] = lawMatrix(outTransforms[j] as SectionTransform);
    const affine = [m[0] * a + m[1] * c, m[0] * b + m[1] * d, m[2] * a + m[3] * c, m[2] * b + m[3] * d] as const;
    const scaleOf = Math.sqrt(Math.abs(affine[0] * affine[3] - affine[1] * affine[2]));
    outFrames[j] = { ...frame, tangent: tm, normal: nm, binormal: bm };
    outTransforms[j] = { twist: 0, sx: scaleOf, sy: scaleOf, affine: [affine[0], affine[1], affine[2], affine[3], 0, 0] };
  }
  return { frames: outFrames, transforms: outTransforms };
}
