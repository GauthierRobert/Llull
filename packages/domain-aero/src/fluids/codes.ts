/** Stable refusal codes of the fluids plugin (AF-11) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  FLD_PARAM_INVALID: 'give finite values in the documented units and ranges (see the command description)',
  FLD_INPUT_CONFLICT: 'give exactly one of the alternative inputs named in the message',
  FLD_MACH_RANGE: 'this relation needs a supersonic upstream Mach (> 1) or a Mach within the documented range',
  FLD_SHOCK_DETACHED:
    'the deflection exceeds the maximum for this Mach: the shock detaches (bow shock); reduce the angle or raise the Mach',
  FLD_EXPANSION_INVALID: 'expansion ratio Ae/At must be > 1 and the exit pressure below the chamber pressure',
  FLD_CONTOUR_INVALID: 'adjust the contraction ratio, angles or wall thickness so the contour closes (see the message)',
};

export const refuseFluid = tableRejection(REMEDIATION);
