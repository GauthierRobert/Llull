/**
 * Plan symbols of pipe supports on layer P-SUPP, drawn on the plan of the support's level (as its
 * pipe): shoe = filled (cut-style) square, hanger = circle with a cross, guide = square with a tick along each
 * side of the pipe, anchor = hatched square with both diagonals; the support mark beside it.
 * @layer domain-aec
 * @pure
 */

import type { Vec2 } from '@core/model/types';
import type { BuildingModel, PipeSupportElement } from '@core/model/building';
import { fromMm } from './model';
import {
  type PlanPrimitive,
  type PlanSource,
  annotationText,
  layerName,
  thinLine,
} from './planModel';
import { pipeAngle } from './industrial/supportParts';

/** Side of a support symbol, mm (diameter for the hanger circle). */
const SYMBOL_SIZE = 300;
const LABEL_HEIGHT = 150;

export function supportPrimitives(
  doc: PlanSource,
  building: BuildingModel,
  support: PipeSupportElement,
): PlanPrimitive[] {
  const pipe = building.elements[support.pipeId];
  const angle = pipe?.category === 'pipe' ? pipeAngle(pipe, support.position) : 0;
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const half = fromMm(doc, SYMBOL_SIZE) / 2;
  const centre: Vec2 = [support.position[0], support.position[1]];
  const at = (along: number, across: number): Vec2 => [
    centre[0] + along * cos - across * sin,
    centre[1] + along * sin + across * cos,
  ];
  const layer = layerName('pipeSupport');
  const line = (a: Vec2, b: Vec2): PlanPrimitive => thinLine(layer, a, b);
  const square: Vec2[] = [at(-half, -half), at(half, -half), at(half, half), at(-half, half)];
  const symbol = ((): PlanPrimitive[] => {
    switch (support.type) {
      case 'shoe':
        return [{ type: 'polygon', layer, style: 'cut', points: square, fill: 'solid' }];
      case 'hanger':
        return [
          { type: 'circle', layer, style: 'thin', center: centre, radius: half },
          line(at(-half, 0), at(half, 0)),
          line(at(0, -half), at(0, half)),
        ];
      case 'guide': {
        const tick = half * (1 + 1 / 3);
        return [
          { type: 'polygon', layer, style: 'thin', points: square },
          line(at(-half, tick), at(half, tick)),
          line(at(-half, -tick), at(half, -tick)),
        ];
      }
      case 'anchor':
        return [
          { type: 'polygon', layer, style: 'thin', points: square, fill: 'hatch' },
          line(at(-half, -half), at(half, half)),
          line(at(-half, half), at(half, -half)),
        ];
    }
  })();
  return [
    ...symbol,
    annotationText(
      layer,
      [centre[0] + half * 1.6, centre[1] + half * 1.6],
      fromMm(doc, LABEL_HEIGHT),
      support.mark,
    ),
  ];
}
