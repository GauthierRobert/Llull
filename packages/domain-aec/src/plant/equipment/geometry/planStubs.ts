/**
 * Plan representation of equipment nozzles (03 EQP §6, README D3): per nozzle, the neck axis from the point on the wall to the flange face as a line,
 * the flange as a short line across the neck (or, for a nozzle that points up or down, a circle of the flange outside diameter), and the mark as text
 * at the flange. Positions are the same as the 3D ports (`placeNozzle`, equipment frame turned by the plan angle about the location).
 * @invariant pure; draws ALL nozzles of the equipment (no cut-plane filter: a nozzle above or below the plan cut is shown); one group per nozzle, in nozzle order; a nozzle without a placement draws nothing
 */

import type { DrawingPrimitive } from '@core/model/drawing';
import type { Vec2 } from '@core/model/vectors';
import { planPoint } from '@lib/vec2';
import type { EquipmentElement } from '@aec/building/types';
import { placeNozzle } from './ports';

/** Horizontal reach (document units) under which a nozzle counts as vertical: the stub has no length on the plan. */
const VERTICAL_REACH = 1e-6;

export function nozzlePlanStubs(element: EquipmentElement, layer: string, textHeight: number): DrawingPrimitive[] {
  const plant = element.plant;
  if (plant === undefined) return [];
  const primitives: DrawingPrimitive[] = [];
  for (const nozzle of plant.nozzles) {
    const placement = placeNozzle(plant.template, nozzle);
    if (placement === null) continue;
    const at = (point: readonly number[]): Vec2 => planPoint(element.location, element.angle, [point[0] ?? 0, point[1] ?? 0]);
    const [base, face] = [at(placement.base), at(placement.face)];
    const reach = Math.hypot(face[0] - base[0], face[1] - base[1]);
    const radius = nozzle.flange.outsideDiameter / 2;
    if (reach <= VERTICAL_REACH) {
      primitives.push({ type: 'circle', layer, style: 'thin', center: face, radius });
      primitives.push({ type: 'circle', layer, style: 'thin', center: face, radius: nozzle.neckOutsideDiameter / 2 });
      primitives.push({
        type: 'text',
        layer,
        style: 'annotation',
        at: [face[0] + radius + textHeight / 2, face[1]],
        height: textHeight,
        content: nozzle.mark,
      });
      continue;
    }
    const along: Vec2 = [(face[0] - base[0]) / reach, (face[1] - base[1]) / reach];
    const across: Vec2 = [-along[1], along[0]];
    primitives.push({ type: 'line', layer, style: 'thin', a: base, b: face });
    primitives.push({
      type: 'line',
      layer,
      style: 'thin',
      a: [face[0] + across[0] * radius, face[1] + across[1] * radius],
      b: [face[0] - across[0] * radius, face[1] - across[1] * radius],
    });
    primitives.push({
      type: 'text',
      layer,
      style: 'annotation',
      at: [face[0] + along[0] * textHeight, face[1] + along[1] * textHeight],
      height: textHeight,
      content: nozzle.mark,
    });
  }
  return primitives;
}
