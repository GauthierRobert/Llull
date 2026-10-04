/**
 * Weight per metre of a steel process pipe from its outside diameter: standard wall (ASME B36.10M
 * STD / EN 10220 series) plus the contents.
 * @layer domain-aec
 * @pure
 */

import { GRAVITY } from './steelMemberBars';

/** [outside diameter mm, standard wall mm] — ASME B36.10M STD (Sch 40 up to NPS 10, 9.53 above). */
const STANDARD_WALL: ReadonlyArray<readonly [number, number]> = [
  [21.3, 2.77],
  [26.9, 2.87],
  [33.7, 3.38],
  [42.4, 3.56],
  [48.3, 3.68],
  [60.3, 3.91],
  [76.1, 5.16],
  [88.9, 5.49],
  [114.3, 6.02],
  [139.7, 6.55],
  [168.3, 7.11],
  [219.1, 8.18],
  [273, 9.27],
  [323.9, 9.53],
  [355.6, 9.53],
  [406.4, 9.53],
  [457, 9.53],
  [508, 9.53],
  [610, 9.53],
];

const MATCH_TOLERANCE_MM = 1.5;
const STEEL_DENSITY = 7850; // kg/m³

/**
 * Wall thickness (mm): the standard wall of the tabulated outside diameter within 1.5 mm, else
 * max(2.5, OD / 40).
 */
export function pipeWallThickness(outsideDiameter: number): number {
  const match = STANDARD_WALL.find(
    ([diameter]) => Math.abs(diameter - outsideDiameter) <= MATCH_TOLERANCE_MM,
  );
  return match?.[1] ?? Math.max(2.5, outsideDiameter / 40);
}

/**
 * Weight of a pipe run per metre (kN/m): steel wall + contents of density `contentDensity` kg/m³.
 * @failure outsideDiameter <= 0 -> 0
 */
export function pipeWeightPerMetre(outsideDiameter: number, contentDensity: number): number {
  if (!(outsideDiameter > 0)) return 0;
  const wall = pipeWallThickness(outsideDiameter);
  const inside = Math.max(0, outsideDiameter - 2 * wall);
  const metres = (millimetres: number): number => millimetres / 1000;
  const steelArea = (Math.PI / 4) * (metres(outsideDiameter) ** 2 - metres(inside) ** 2);
  const insideArea = (Math.PI / 4) * metres(inside) ** 2;
  return ((steelArea * STEEL_DENSITY + insideArea * contentDensity) * GRAVITY) / 1000;
}
