/** Stable refusal codes (04 DIR §7.1) of the NURBS pole editing commands. */

import { tableRejection } from '../noop';

export const DIR_NURBS_REMEDIATION: Readonly<Record<string, string>> = {
  DIR_POINT_OUTSIDE_DOMAIN: 'Give u (and v) inside the knot domain: inspect_nurbs lists it.',
  DIR_POLE_RANGE: 'Pole indices are 0..nU-1 (rows, along u) and 0..nV-1 (columns, along v): inspect_nurbs gives the grid size.',
  DIR_OPERATION_PARAMS: 'Give the parameters the operation needs, exactly as the command description states.',
  DIR_TRIMS_BLOCK: 'This operation changes the parameterisation: trim_surface the sheet again afterwards, or edit an untrimmed sheet.',
  DIR_DISPLACEMENT_ZERO: 'Give a displacement / delta with at least one non-zero finite component.',
  DIR_FALLOFF_INVALID: 'falloff is { radius >= 0 (in poles), shape? }.',
};

export const refuseDirNurbs = tableRejection(DIR_NURBS_REMEDIATION);
