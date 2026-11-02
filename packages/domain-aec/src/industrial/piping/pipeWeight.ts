/**
 * Weight per metre of a steel process pipe from its outside diameter: standard wall (ASME B36.10M STD / EN 10220 series) plus the contents.
 */

import type { PipeElement } from '../../building/types';
import { GRAVITY } from '../../shared/numeric';
import { pipeSizeByOutsideDiameter } from './pipeSizes';

const STEEL_DENSITY = 7850; // kg/m³

/** Wall thickness (mm): the standard wall of the tabulated (EN or ASME) outside diameter within 1.5 mm, else max(2.5, OD / 40). */
export function pipeWallThickness(outsideDiameter: number): number {
  return pipeSizeByOutsideDiameter(outsideDiameter)?.[2] ?? Math.max(2.5, outsideDiameter / 40);
}

/** Wall (mm) of a pipe element: the wall of its spec binding (01 PSC), else the legacy table at its outside diameter (mm). */
export const pipeWallMm = (element: Pick<PipeElement, 'spec'>, outsideDiameterMm: number): number =>
  element.spec?.wallMm ?? pipeWallThickness(outsideDiameterMm);

/**
 * Weight of a pipe run per metre (kN/m): steel wall + contents of density `contentDensity` kg/m³; `wallMm` overrides the legacy table wall.
 * @failure outsideDiameter <= 0 -> 0
 */
export function pipeWeightPerMetre(outsideDiameter: number, contentDensity: number, wallMm?: number): number {
  if (!(outsideDiameter > 0)) return 0;
  const wall = wallMm ?? pipeWallThickness(outsideDiameter);
  const inside = Math.max(0, outsideDiameter - 2 * wall);
  const metres = (millimetres: number): number => millimetres / 1000;
  const steelArea = (Math.PI / 4) * (metres(outsideDiameter) ** 2 - metres(inside) ** 2);
  const insideArea = (Math.PI / 4) * metres(inside) ** 2;
  return ((steelArea * STEEL_DENSITY + insideArea * contentDensity) * GRAVITY) / 1000;
}
