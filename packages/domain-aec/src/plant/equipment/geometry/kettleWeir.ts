/**
 * Kettle weir plate (plant 03 EQP §13.10): a flat plate across the enlarged shell, a circular segment of the enlarged inside radius up to `weirHeight`
 * above the lowest inside point. Closed forms only. `weirStation` is measured from the rear end of the shell toward the front (a floating / U rear has no
 * rear tubesheet; the shell end is where one would stand), to the plate CENTRE.
 */

import { powInt } from '@lib/powInt';
import type { ExchangerTemplate } from '../plantData';
import type { ExchangerGeometry } from './exchangerFrame';

export interface KettleWeir {
  /** Inside radius of the enlarged shell the plate spans. */
  readonly radius: number;
  readonly height: number;
  readonly thickness: number;
  /** Axial x of the front and rear faces of the plate. */
  readonly xFront: number;
  readonly xRear: number;
  /** Area of the circular segment (document units squared) and metal volume of the plate. */
  readonly area: number;
  readonly volume: number;
  /** Distance of the plate centroid below the shell axis. */
  readonly centroidBelowAxis: number;
  /** Liquid held on the bundle side up to the weir: segment area x enlarged-cylinder length between the cone and the plate front face (bundle displacement NOT subtracted). */
  readonly liquidVolume: number;
  readonly liquidLength: number;
}

/** Area of the segment of a circle of radius `radius` below the chord at `height` above the lowest point (0 < height < 2 radius). */
function circularSegmentArea(radius: number, height: number): number {
  const d = radius - height;
  return radius * radius * Math.acos(d / radius) - d * Math.sqrt(Math.max(0, 2 * radius * height - height * height));
}

/** Distance of the centroid of that segment from the circle centre, toward the arc: 4 R sin^3(theta/2) / (3 (theta - sin theta)), theta = 2 acos((R - h) / R). */
function segmentCentroidDepth(radius: number, height: number): number {
  const theta = 2 * Math.acos((radius - height) / radius);
  return (4 * radius * powInt(Math.sin(theta / 2), 3)) / (3 * (theta - Math.sin(theta)));
}

/** Why the weir does not lie inside the enlarged cylinder, or null. Lengths in document units. */
export function weirPositionProblem(station: number, thickness: number, enlargedLength: number): string | null {
  if (station - thickness / 2 < 0 || station + thickness / 2 > enlargedLength)
    return `weirStation ${station} with weirThickness ${thickness} puts the plate outside the enlarged length 0..${enlargedLength} (measured from the rear end of the shell)`;
  return null;
}

/** The weir of a kettle template, or null (no kettle, or the weir position / thickness were not given). */
export function kettleWeir(template: ExchangerTemplate, geometry: ExchangerGeometry): KettleWeir | null {
  const { kettle } = template;
  if (kettle?.weirStation === undefined || kettle.weirThickness === undefined) return null;
  const radius = kettle.enlargedInsideDiameter / 2;
  const height = kettle.weirHeight;
  const area = circularSegmentArea(radius, height);
  const xRear = geometry.shellTo - kettle.weirStation + kettle.weirThickness / 2;
  const xFront = xRear - kettle.weirThickness;
  const liquidLength = Math.max(0, xFront - (geometry.shellTo - kettle.enlargedLength));
  return {
    radius,
    height,
    thickness: kettle.weirThickness,
    xFront,
    xRear,
    area,
    volume: area * kettle.weirThickness,
    centroidBelowAxis: segmentCentroidDepth(radius, height),
    liquidVolume: area * liquidLength,
    liquidLength,
  };
}
