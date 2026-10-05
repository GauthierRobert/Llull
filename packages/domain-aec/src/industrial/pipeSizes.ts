/**
 * Nominal steel pipe sizes: outside diameter (EN 10220 / ASME B36.10M), standard wall (ASME B36.10M
 * STD: Sch 40 up to NPS 10, 9.53 mm above) and the maximum support spacing of horizontal, water-filled
 * pipe (MSS SP-69 Table 3 / ASME B31.1 Table 121.5, water service, ft converted to m, one decimal:
 * NPS ≤ 1¼ 7 ft, 1½ 9, 2 10, 2½ 11, 3 12, 4 14, 5 16, 6 17, 8 19, 10 22, 12 23, 14 25, 16 27, 18 28,
 * 20 30, 24 32 ft).
 * @layer domain-aec
 */

/** [DN, outside diameter mm, standard wall mm, maximum support span m]. */
export const PIPE_SIZES: ReadonlyArray<readonly [number, number, number, number]> = [
  [15, 21.3, 2.77, 2.1],
  [20, 26.9, 2.87, 2.1],
  [25, 33.7, 3.38, 2.1],
  [32, 42.4, 3.56, 2.1],
  [40, 48.3, 3.68, 2.7],
  [50, 60.3, 3.91, 3.0],
  [65, 76.1, 5.16, 3.4],
  [80, 88.9, 5.49, 3.7],
  [100, 114.3, 6.02, 4.3],
  [125, 139.7, 6.55, 4.9],
  [150, 168.3, 7.11, 5.2],
  [200, 219.1, 8.18, 5.8],
  [250, 273, 9.27, 6.7],
  [300, 323.9, 9.53, 7.0],
  [350, 355.6, 9.53, 7.6],
  [400, 406.4, 9.53, 8.2],
  [450, 457, 9.53, 8.5],
  [500, 508, 9.53, 9.1],
  [600, 610, 9.53, 9.8],
];

/** An outside diameter within this of a tabulated one (mm) is that size. */
export const OUTSIDE_DIAMETER_TOLERANCE_MM = 1.5;

/** Largest DN whose outside diameter add_pipe_run takes from the table (larger sizes need `diameter`). */
const MAX_ORDERED_DN = 400;

/** Outside diameter in mm per nominal size DN that add_pipe_run accepts without an explicit diameter. */
export const PIPE_OUTSIDE_DIAMETER_MM: Readonly<Record<number, number>> = Object.fromEntries(
  PIPE_SIZES.filter(([dn]) => dn <= MAX_ORDERED_DN).map(([dn, diameter]) => [dn, diameter]),
);

/** Outside diameter (mm) of nominal size `dn`, or null when `dn` is not a tabulated size. */
export function outsideDiameterMm(dn: number): number | null {
  return PIPE_OUTSIDE_DIAMETER_MM[dn] ?? null;
}
