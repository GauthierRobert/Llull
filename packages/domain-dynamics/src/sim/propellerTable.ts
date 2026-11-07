/**
 * Propeller coefficients against advance ratio (FR-FPR-75, TECHNICAL_SPEC 5.8): J = V / (n D) with n in rev/s; C_T(J) and C_P(J) by monotone
 * cubic (PCHIP, Fritsch-Carlson) interpolation of the table, clamped at its ends. J = 0 uses the propeller's static coefficients.
 */

import type { PropellerLoad } from '@core/model/dynamics';
import { pchipAt } from '@lib/pchip';

export interface PropellerCoefficients {
  readonly advanceRatio: number;
  readonly thrustCoefficient: number;
  readonly powerCoefficient: number;
  /** J lies beyond the last table point (the coefficients are held at the end value): FPR_OUTSIDE_VALIDATED_RANGE. */
  readonly outsideTable: boolean;
  /** The coefficients come from the table (J > 0) rather than the static pair. */
  readonly tabulated: boolean;
}

/** Advance ratio of a propeller at shaft speed `omega` (rad/s): V / (n D), 0 when it is not turning or has no airspeed. */
export function advanceRatio(propeller: PropellerLoad, omega: number): number {
  const n = Math.abs(omega) / (2 * Math.PI);
  return n > 0 ? (propeller.airspeedMps ?? 0) / (n * propeller.diameter) : 0;
}

/** C_T, C_P of `propeller` at shaft speed `omega` (rad/s): the table by PCHIP when J > 0 and a table exists, else the static pair. */
export function propellerCoefficients(propeller: PropellerLoad, omega: number): PropellerCoefficients {
  const j = advanceRatio(propeller, omega);
  const { table } = propeller;
  if (table === undefined || !(j > 0))
    return {
      advanceRatio: j,
      thrustCoefficient: propeller.thrustCoefficient,
      powerCoefficient: propeller.powerCoefficient,
      outsideTable: false,
      tabulated: false,
    };
  const points = [...table.points].sort((a, b) => a[0] - b[0]);
  const js = points.map((point) => point[0]);
  const lastJ = js[js.length - 1] ?? 0;
  return {
    advanceRatio: j,
    thrustCoefficient: pchipAt(
      js,
      points.map((point) => point[1]),
      j,
    ),
    powerCoefficient: pchipAt(
      js,
      points.map((point) => point[2]),
      j,
    ),
    outsideTable: j > lastJ,
    tabulated: true,
  };
}
