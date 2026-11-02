/**
 * Derived geometry of an API 650 tank (plant 03 EQP §2): bottom plate, one revolved ring per shell course (its own thickness), the roof (cone,
 * dome sampled at 32 steps, or flat plate) and nozzles, all tagged `element:<id>`. Wall thickness grows outward from the nominal diameter.
 */

import type { Entity, Vec3 } from '@core/model/types';
import type { Vec2 } from '@core/model/vectors';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import { toWorld } from '../geometry/ports';
import { courseBottoms, eaveRadius, roofRise, tankBase } from '../geometry/tankFrame';
import { ringSection } from '../geometry/vesselProfile';
import type { TankTemplate } from '../plantData';
import { evaluateNozzles } from './evaluateNozzles';
import { polygonSection, revolutionPart, type Section } from './revolutionPart';

const DOME_STEPS = 32;

/** Roof plate section about the tank axis; `top` = z of the shell top. */
function roofSection(template: TankTemplate, top: number): Section {
  const { roof } = template;
  const eave = eaveRadius(template);
  const rise = roofRise(template);
  if (roof.type === 'flat') return ringSection(0, eave, top, top + roof.thickness);
  if (roof.type === 'cone')
    return polygonSection([
      [0, top + rise],
      [eave, top],
      [eave, top - roof.thickness],
      [0, top + rise - roof.thickness],
    ]);
  const sphere = roof.radius ?? eave;
  const centre = top + rise - sphere;
  const surface = (radius: number, rho: number): Vec2 => [radius, centre + Math.sqrt(Math.max(0, rho * rho - radius * radius))];
  const radii = Array.from({ length: DOME_STEPS + 1 }, (_unused, index) => eave * (1 - index / DOME_STEPS));
  return {
    profile: [
      ...radii.map((radius) => surface(radius, sphere)),
      ...[...radii].reverse().map((radius) => surface(radius, sphere - roof.thickness)),
    ],
  };
}

/** Entities of an API 650 tank element, nozzles included. */
export function evaluateTank(element: EquipmentElement, level: BuildingLevel, template: TankTemplate): Entity[] {
  const origin = toWorld(element, level, [0, 0, 0]);
  const rotation: Vec3 = [0, 0, element.angle];
  const radius = template.diameter / 2;
  const base = tankBase(template);
  const part = (name: string, label: string, section: Section): Entity =>
    revolutionPart(element, { name, label: `${label} ${element.mark}` }, origin, rotation, section, [0, 0, 1]);
  const bottoms = courseBottoms(template);
  return [
    part('bottom', 'Bottom plate', ringSection(0, eaveRadius(template), 0, base)),
    ...template.courses.map((height, index) =>
      part(
        `course-${index + 1}`,
        `Course ${index + 1}`,
        ringSection(
          radius,
          radius + (template.courseThicknesses[index] as number),
          base + (bottoms[index] as number),
          base + (bottoms[index] as number) + height,
        ),
      ),
    ),
    part('roof', 'Roof', roofSection(template, base + template.shellHeight)),
    ...evaluateNozzles(element, level),
  ];
}
