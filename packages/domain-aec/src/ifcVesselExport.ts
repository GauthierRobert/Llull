/**
 * IFC body of a cylindrical vessel: extruded IfcCircleProfileDef.
 * @layer domain-aec
 */

import type { EquipmentElement } from '@core/model/building';
import { circleProfile, direction, ifcReal, point3, type Context } from './ifcStep';
import { shapeOf } from './industrial/equipmentShape';

/**
 * @invariant vertical: axis +Z from the placement origin (level); horizontal: axis along local x,
 * centred on the element location, placement origin at the axis height (radius above the level)
 * @returns the extruded solid, or null for a box
 */
export function vesselSolid(context: Context, element: EquipmentElement): string | null {
  const shape = shapeOf(element);
  if (shape === 'box') return null;
  const [length, width, height] = element.size.map((value) => context.mm(value)) as [
    number,
    number,
    number,
  ];
  if (shape === 'vertical_vessel') {
    const profile = circleProfile(context, length / 2);
    const axes = context.writer.add(
      `IFCAXIS2PLACEMENT3D(${point3(context, 0, 0, 0)},${context.zAxis},${context.xAxis})`,
    );
    return context.writer.add(
      `IFCEXTRUDEDAREASOLID(${profile},${axes},${context.zAxis},${ifcReal(height)})`,
    );
  }
  const profile = circleProfile(context, width / 2);
  const axes = context.writer.add(
    `IFCAXIS2PLACEMENT3D(${point3(context, -length / 2, 0, 0)},${direction(context, [1, 0, 0])},${direction(context, [0, 0, 1])})`,
  );
  return context.writer.add(
    `IFCEXTRUDEDAREASOLID(${profile},${axes},${context.zAxis},${ifcReal(length)})`,
  );
}
