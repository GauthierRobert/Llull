/**
 * Equipment shapes (box, vertical vessel, horizontal vessel) and size normalisation.
 * @layer domain-aec
 */

import type { EquipmentElement, EquipmentShape } from '@core/model/building';
import type { Vec3 } from '@core/model/types';
import { z } from '@core/commands/schema';
import { toVec3 } from './memberSupport';

export const equipmentShapeSchema = z.enum(['box', 'vertical_vessel', 'horizontal_vessel']);

export const EQUIPMENT_SHAPES: ReadonlyArray<string> = equipmentShapeSchema.options;

export const SHAPE_PARAM_TEXT =
  'Shape: "box" (default), "vertical_vessel" (cylinder, axis along Z: size = [diameter, ignored, ' +
  'height]; the width is set equal to the diameter) or "horizontal_vessel" (cylinder, axis along its ' +
  'local x: size = [length, diameter, ignored]; the height is set equal to the diameter and the ' +
  'bottom rests on the level). Plans draw a vertical vessel as a circle.';

export function shapeOf(equipment: Pick<EquipmentElement, 'shape'>): EquipmentShape {
  return equipment.shape ?? 'box';
}

/**
 * @invariant vessel sizes are stored as their bounding box (clash, floor loads and elevations use it)
 * @returns the normalised bounding-box size, or null when invalid
 */
export function normaliseEquipmentSize(shape: EquipmentShape, size: unknown): Vec3 | null {
  const value = toVec3(size);
  if (!value || !Array.isArray(size) || size.length !== 3) return null;
  const [first, second, third] = value;
  switch (shape) {
    case 'box':
      return value.every((n) => n > 0) ? value : null;
    case 'vertical_vessel':
      return first > 0 && third > 0 ? [first, first, third] : null;
    case 'horizontal_vessel':
      return first > 0 && second > 0 ? [first, second, second] : null;
  }
}

export function describeEquipmentShape(shape: EquipmentShape, size: Vec3, units: string): string {
  switch (shape) {
    case 'box':
      return `${size.join(' × ')} ${units}`;
    case 'vertical_vessel':
      return `vertical vessel Ø${size[0]} × ${size[2]} ${units}`;
    case 'horizontal_vessel':
      return `horizontal vessel Ø${size[1]} × ${size[0]} ${units} long`;
  }
}
