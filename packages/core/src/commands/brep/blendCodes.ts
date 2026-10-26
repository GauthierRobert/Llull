/** Stable BLD_* refusals of the blend commands that are decided before the kernel runs (BLD M1, TECHNICAL_SPEC §7.1). */

import { tableRejection } from '../noop';

const REMEDIATION = {
  BLD_LAW_INVALID: 'fix the named value; sizes are > 0 and expressions use t in [0, 1]',
  BLD_LAW_NOT_PERIODIC: 'make the end radius equal the start, or use a periodic expression',
  BLD_CHORD_UNDEFINED: 'use radius there, or split the edge',
  BLD_ASYMMETRIC_SIDE_MISSING: 'give side1Near (a point on the face that carries the first distance) or side1Name',
  BLD_BLEND_PARAMS: 'give exactly one of radius or holdLine',
  BLD_CHAMFER_PARAMS: 'give exactly one of distance2 or angleDeg (with side1Near / side1Name)',
  BLD_CORNER_UNSUPPORTED:
    'give the vertex a setback corner on straight edges between planar faces (all convex or all concave at the vertex), all rounded in this step with a constant radius (corners: [{ near: <vertex>, type: "setback", setback: <distance> }]), or round fewer of the edges meeting there',
  BLD_CHAMFER_ANGLE_RANGE: 'give the angle in degrees strictly between 0 and 90, measured on the side1 face',
} as const;

/** `codedRejection` for the codes above, with their remediation. */
export const blendRejection = tableRejection(REMEDIATION);
