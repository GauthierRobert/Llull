/**
 * Evaluated entities of a pipe support (boxes and a rod, oriented along the pipe).
 * @layer domain-aec
 * @pure
 */

import type { CadDocument, CylinderEntity, Entity, Vec3 } from '@core/model/types';
import type { BuildingLevel, PipeElement, PipeSupportElement } from '@core/model/building';
import { CATEGORY_LAYER, base, orientedBox } from '../entities';
import { supportShape } from './supportParts';

export function evaluatePipeSupport(
  doc: Pick<CadDocument, 'units'>,
  support: PipeSupportElement,
  pipe: PipeElement | undefined,
  level: BuildingLevel,
): Entity[] {
  if (!pipe) return [];
  const { angle, parts } = supportShape(doc, support, pipe);
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  const color = CATEGORY_LAYER.pipeSupport.color;
  return parts.map((part): Entity => {
    const centre: Vec3 = [
      support.position[0] - sin * part.across,
      support.position[1] + cos * part.across,
      level.elevation + part.z,
    ];
    const stub = { part: part.name, label: part.label };
    if (part.kind === 'box')
      return orientedBox(support, stub, centre, angle, [...part.size], color);
    const rod: CylinderEntity = {
      ...base(support, stub, centre, [0, 0, 0], color),
      kind: 'cylinder',
      radius: part.radius,
      height: part.height,
    };
    return rod;
  });
}
