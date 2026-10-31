/** Stable BLD_* refusals of the blend commands that are decided before the kernel runs (BLD M1, TECHNICAL_SPEC §7.1). */

import { tableRejection } from '../noop';

const REMEDIATION = {
  BLD_LAW_INVALID: 'fix the named value; sizes are > 0 and expressions use t in [0, 1]',
  BLD_LAW_NOT_PERIODIC: 'make the end radius equal the start, or use a periodic expression',
  BLD_CHORD_UNDEFINED: 'use radius there, or split the edge',
  BLD_ASYMMETRIC_SIDE_MISSING: 'give side1Near (a point on the face that carries the first distance) or side1Name',
  BLD_BLEND_PARAMS: 'give exactly one of radius, width, law or holdLine (radiusEnd only with radius, widthEnd only with width)',
  BLD_CHAMFER_PARAMS: 'give exactly one of distance2 or angleDeg (with side1Near / side1Name)',
  BLD_CORNER_UNSUPPORTED:
    'give the vertex a setback corner (corners: [{ near: <vertex>, type: "setback", setback: <distance> }]) with every edge that meets there, and only those, rounded in this step with a constant radius: on straight edges between planar faces (all convex or all concave) the setback is along the edge; on a curved edge or face it is the radius of a ball around the vertex, one distance for the vertex, larger than the rolling-ball corner and clear of the other faces; do not mix the two kinds in one step; or round fewer of the edges meeting there',
  BLD_CHAMFER_VARIABLE_PARAMS:
    'distanceEnd > 0 and the edges listed; with distance2 (asymmetric legs) also distance2End > 0 and side1Near / side1Name, never with angleDeg; distance2End only with distanceEnd and distance2',
  BLD_JOINT_PARAMS:
    'one radius per tangent chain of joints, every radius > 0, and every near point within 10 x its radius of a joint (the joint nearest to it is rounded)',
  BLD_CHAMFER_ANGLE_RANGE: 'give the angle in degrees strictly between 0 and 90, measured on the side1 face',
} as const;

/** `codedRejection` for the codes above, with their remediation. */
export const blendRejection = tableRejection(REMEDIATION);
