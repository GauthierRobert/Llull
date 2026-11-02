/** Entity builders shared by the derived-geometry evaluators of plant equipment: a revolved section and a support box, both tagged to the element. */

import type { BoxEntity, RevolutionEntity, Vec3 } from '@core/model/types';
import type { Vec2 } from '@core/model/vectors';
import type { CurveSegment } from '@core/model/curve';
import type { BuildingLevel, EquipmentElement } from '@aec/building/types';
import { base, orientedBox } from '../../../building/evaluate/entities';
import { toWorld } from '../geometry/ports';

export const BODY_COLOR = '#c27c2c';
export const SUPPORT_COLOR = '#7d8a96';
const REVOLUTION_SEGMENTS = 64;

/** A closed section to revolve: its tessellation and, when exact, its curves. */
export interface Section {
  readonly profile: Vec2[];
  readonly curves?: CurveSegment<Vec2>[];
}

/** Closed polygon section (straight edges only) from its corner points. */
export function polygonSection(points: readonly Vec2[]): Section {
  const profile = [...points];
  return {
    profile,
    curves: profile.map(
      (point, index): CurveSegment<Vec2> => ({ type: 'line', points: [point, profile[(index + 1) % profile.length] as Vec2] }),
    ),
  };
}

export function revolutionPart(
  element: EquipmentElement,
  part: { name: string; label: string },
  position: Vec3,
  rotation: Vec3,
  section: Section,
  axis: Vec3,
  angle = 2 * Math.PI,
): RevolutionEntity {
  return {
    ...base(element, { part: part.name, label: part.label }, position, rotation, BODY_COLOR),
    kind: 'revolution',
    profile: section.profile,
    axis,
    angle,
    segments: REVOLUTION_SEGMENTS,
    ...(section.curves === undefined ? {} : { curves: section.curves }),
  };
}

/** Oriented box at the equipment-frame point `local` (support blocks, pump envelope boxes). */
export function supportBox(
  element: EquipmentElement,
  level: BuildingLevel,
  part: string,
  label: string,
  local: Vec3,
  size: Vec3,
): BoxEntity {
  return orientedBox(element, { part, label }, toWorld(element, level, local), element.angle, size, SUPPORT_COLOR);
}
