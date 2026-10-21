/**
 * Plausibility checks of an engine model (FR-FPR-76): values that run but are not like a real engine. Each finding states the value, the
 * expected band and where the band comes from (a source, or "named default"). All are warnings (FPR_UNREALISTIC).
 */

export interface PlausibilityFinding {
  readonly code: 'FPR_UNREALISTIC';
  readonly status: 'warn';
  readonly quantity: string;
  readonly value: number;
  readonly band: readonly [min: number, max: number];
  readonly unit: string;
  /** A source reference, or "named default". */
  readonly basis: string;
  readonly ids: readonly string[];
  readonly message: string;
}

/** Band of the mechanical efficiency BMEP / IMEP at rated speed (named default; a real engine is about 0.85-0.90 [E-R11]). */
export const MECHANICAL_EFFICIENCY_BAND = [0.75, 0.95] as const;
/** MBT phasing [E-R16]: CA50 8-10 deg ATDC, peak pressure near 15 deg ATDC; the tolerances around them are named defaults. */
export const CA50_BAND_DEG = [3, 15] as const;
export const PEAK_ANGLE_BAND_DEG = [5, 25] as const;
/** Rotax 912-class propeller limits [E-R4]: shaft inertia 0.15-0.60 kg·m², at most 315 N·m at the propeller (912 S / ULS). */
export const ROTAX_PROPELLER_INERTIA_BAND = [0.15, 0.6] as const;
export const ROTAX_MAX_PROPELLER_TORQUE_NM = 315;
/** Rotax 912 reduction ratios (crank / propeller): 51/21 and 50/22 [E-R4]. */
const ROTAX_REDUCTIONS = [51 / 21, 50 / 22] as const;

const finding = (
  quantity: string,
  value: number,
  band: readonly [number, number],
  unit: string,
  basis: string,
  ids: readonly string[],
  message: string,
): PlausibilityFinding => ({ code: 'FPR_UNREALISTIC', status: 'warn', quantity, value, band, unit, basis, ids, message });

/** The finding when `value` lies outside `band`, else none. */
export function outsideBand(
  quantity: string,
  value: number,
  band: readonly [number, number],
  unit: string,
  basis: string,
  ids: readonly string[],
  hint: string,
): PlausibilityFinding[] {
  if (!Number.isFinite(value) || (value >= band[0] && value <= band[1])) return [];
  const suffix = unit === '' ? '' : ` ${unit}`;
  return [
    finding(
      quantity,
      value,
      band,
      unit,
      basis,
      ids,
      `${quantity} ${Number(value.toPrecision(4))}${suffix} is outside ${band[0]}..${band[1]}${suffix} (${basis}): ${hint}`,
    ),
  ];
}

/** True when a gear ratio (driven / driver speed) is a Rotax 912 reduction (within 1 %). */
export function isRotaxReduction(ratio: number): boolean {
  return ROTAX_REDUCTIONS.some((reduction) => Math.abs(Math.abs(1 / ratio) - reduction) <= 0.01 * reduction);
}

/** Angle (deg ATDC, in -180..540) the cycle angle `phiDeg` of a four-stroke / two-stroke curve corresponds to: phi 0 is firing TDC. */
export const degreesAfterTdc = (phiDeg: number, cycleDeg: number): number => (phiDeg > cycleDeg / 2 ? phiDeg - cycleDeg : phiDeg);
