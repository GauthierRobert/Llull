/**
 * Geometry of an API 650 vertical tank (plant 03 EQP §5.6). Frame: origin on the axis at the level, +Z up; the bottom plate occupies 0..bottom.thickness,
 * the shell starts on it. `diameter` is the nominal (inside) diameter; each course wall grows outward by its thickness. Levels count from the top of
 * the bottom plate. Volumes are in document units cubed.
 */

import type { NozzleRecord, TankTemplate } from '../plantData';
import { offsetAlong, point, rad, type NozzlePlacement } from './placement';

/** z of the shell base (top of the bottom plate). */
export const tankBase = (template: TankTemplate): number => template.bottom.thickness;

/** Bottom elevation of each course above the shell base. */
export function courseBottoms(template: TankTemplate): number[] {
  let bottom = 0;
  return template.courses.map((height) => {
    const here = bottom;
    bottom += height;
    return here;
  });
}

/** Thickness of the course containing `elevation` above the shell base (clamped to the first / last course). */
export function thicknessAt(template: TankTemplate, elevation: number): number {
  const bottoms = courseBottoms(template);
  const found = bottoms.findIndex((bottom, position) => elevation < bottom + (template.courses[position] as number));
  return template.courseThicknesses[found < 0 ? bottoms.length - 1 : found] as number;
}

/** Outside radius of the top course (the roof eave). */
export const eaveRadius = (template: TankTemplate): number =>
  template.diameter / 2 + (template.courseThicknesses[template.courseThicknesses.length - 1] as number);

/** Height of the roof apex above the top of the shell. */
export function roofRise(template: TankTemplate): number {
  const { roof } = template;
  const eave = eaveRadius(template);
  if (roof.type === 'cone') return (roof.slope ?? 0) * eave;
  if (roof.type === 'dome') {
    const sphere = roof.radius ?? eave;
    return sphere - Math.sqrt(Math.max(0, sphere * sphere - eave * eave));
  }
  return 0;
}

/** Liquid volume at level `h` above the shell base (cylinder; the roof and the bottom plate are not part of it). */
export const tankLiquidVolume = (template: TankTemplate, h: number): number => Math.PI * (template.diameter / 2) ** 2 * h;

export function tankPlacement(template: TankTemplate, nozzle: NozzleRecord): NozzlePlacement | null {
  const { location, projection } = nozzle;
  if (location.on !== 'shell' || !('elevation' in location)) return null;
  const angle = rad(location.orientationDeg);
  const direction = point(Math.sin(angle), Math.cos(angle), 0);
  const centre = point(0, 0, tankBase(template) + location.elevation);
  const start = template.diameter / 2 + thicknessAt(template, location.elevation) / 2;
  return { base: offsetAlong(centre, direction, start), face: offsetAlong(centre, direction, projection), direction };
}
