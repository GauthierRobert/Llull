/**
 * The named tolerances of check_blends and where they come from (AF-31): g0 (1e-6 x the diagonal), g0Profile and g0Corner (5 x g0: the B-spline fit of
 * a re-skinned profile blend, the plate-surface fit of a corner patch), g1AngleRad, g2Rel. A row kind is listed only when the check holds one.
 * @invariant pure; lengths in document units
 */

import { roundSignificant } from '../../lib/significant';

/** Re-skinned profile faces are B-spline approximations like corner patches: their contacts and junctions are judged against this multiple of g0; the native builder refuses at exactly this limit. */
export const PROFILE_G0_FACTOR = 5;
/** Corner patches may leave the edges they are sewn to by this multiple of the default gap (the native build accepts 5e-6 x the diagonal). */
export const CORNER_G0_FACTOR = 5;

const sig = (value: number): number => roundSignificant(value, 10);

interface Named {
  readonly value: number;
  readonly unit: string;
  readonly defaulted: boolean;
  readonly source: string;
}

export function namedTolerances(input: {
  readonly g0Used: number;
  readonly unit: string;
  readonly g0Given: boolean;
  readonly g1AngleRad: number;
  readonly g1Given: boolean;
  readonly g2Rel: number;
  readonly g2Given: boolean;
  readonly profiled: boolean;
  readonly cornered: boolean;
}): Record<string, Named> {
  const { g0Used, unit, g0Given } = input;
  return {
    g0: {
      value: sig(g0Used),
      unit,
      defaulted: !g0Given,
      source: 'check_continuity default: 1e-6 x the bounding-box diagonal of each solid (the largest is shown)',
    },
    ...(input.profiled
      ? {
          g0Profile: {
            value: sig(g0Given ? g0Used : g0Used * PROFILE_G0_FACTOR),
            unit,
            defaulted: !g0Given,
            source:
              'profile blends (conic / curvature rows, contacts and junctions): 5x the default g0, the accuracy of the B-spline fit of a re-skinned blend; the native builder refuses at the same limit',
          },
        }
      : {}),
    ...(input.cornered
      ? {
          g0Corner: {
            value: sig(g0Given ? g0Used : g0Used * CORNER_G0_FACTOR),
            unit,
            defaulted: !g0Given,
            source:
              'plate corner patches (kind "corner", profile "patch"): 5x the default g0, the accuracy of the plate-surface fit of a setback patch (an exact star is judged at g0)',
          },
        }
      : {}),
    g1AngleRad: { value: input.g1AngleRad, unit: 'rad', defaulted: !input.g1Given, source: 'OCCT MakeFilling TolAng default' },
    g2Rel: { value: input.g2Rel, unit: 'ratio', defaulted: !input.g2Given, source: 'check_continuity default' },
  };
}
