/**
 * Weight per metre of a steel process pipe from its outside diameter: standard wall (ASME B36.10M
 * STD / EN 10220 series) plus the contents.
 * @layer domain-aec
 * @pure
 */

import { GRAVITY } from '../numeric';
import { OUTSIDE_DIAMETER_TOLERANCE_MM, PIPE_SIZES } from './pipeSizes';

const STEEL_DENSITY = 7850; // kg/m³

/**
 * Wall thickness (mm): the standard wall of the tabulated outside diameter within 1.5 mm, else
 * max(2.5, OD / 40).
 */
export function pipeWallThickness(outsideDiameter: number): number {
  const match = PIPE_SIZES.find(
    ([, diameter]) => Math.abs(diameter - outsideDiameter) <= OUTSIDE_DIAMETER_TOLERANCE_MM,
  );
  return match?.[2] ?? Math.max(2.5, outsideDiameter / 40);
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
