/**
 * @layer domain-aec
 */

/** Outside diameter in mm per nominal size DN (EN 10220 / ASME B36.10 steel pipe). */
export const PIPE_OUTSIDE_DIAMETER_MM: Readonly<Record<number, number>> = {
  15: 21.3,
  20: 26.9,
  25: 33.7,
  32: 42.4,
  40: 48.3,
  50: 60.3,
  65: 76.1,
  80: 88.9,
  100: 114.3,
  125: 139.7,
  150: 168.3,
  200: 219.1,
  250: 273,
  300: 323.9,
  350: 355.6,
  400: 406.4,
};

/** Outside diameter (mm) of nominal size `dn`, or null when `dn` is not a tabulated size. */
export function outsideDiameterMm(dn: number): number | null {
  return PIPE_OUTSIDE_DIAMETER_MM[dn] ?? null;
}
