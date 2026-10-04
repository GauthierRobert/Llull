/**
 * @layer domain-aec
 */

import type { WallElement } from '@core/model/building';
import { fromMm, getBuilding } from './model';
import { wallFrame } from './wallGeometry';
import {
  type PlanDrawing,
  type PlanPrimitive,
  type PlanSource,
  band,
  layerName,
} from './planModel';
import {
  boundsOf,
  columnPrimitive,
  curvedWallPrimitives,
  dimensionPrimitives,
  gridPrimitives,
  roomPrimitives,
  slabPrimitives,
  stairPrimitives,
  wallPrimitives,
} from './planArchitectural';
import { crossingColumnPrimitives, industrialPrimitives } from './planIndustrial';

/**
 * Builds the plan of `levelId` (or the active / lowest level).
 * @failure no such level -> null
 */
export function buildPlanDrawing(
  doc: PlanSource,
  levelId: string | undefined,
  options: { cutHeight?: number; dimensions?: boolean } = {},
): PlanDrawing | null {
  const building = getBuilding(doc);
  const resolvedId = levelId ?? building.activeLevelId ?? building.levelOrder[0];
  const level = resolvedId !== undefined ? building.levels[resolvedId] : undefined;
  if (!level) return null;
  const cutHeight = options.cutHeight ?? fromMm(doc, 1200);
  const primitives: PlanPrimitive[] = [];
  const walls: WallElement[] = [];
  for (const id of building.elementOrder) {
    const element = building.elements[id];
    if (!element || !('levelId' in element)) continue;
    if (element.levelId !== level.id) {
      primitives.push(...crossingColumnPrimitives(doc, element, level, cutHeight));
      continue;
    }
    switch (element.category) {
      case 'wall':
        walls.push(element);
        primitives.push(...wallPrimitives(building, element, cutHeight));
        break;
      case 'curvedWall':
        primitives.push(...curvedWallPrimitives(building, element, cutHeight));
        break;
      case 'slab':
        primitives.push(...slabPrimitives(element));
        break;
      case 'column':
        primitives.push(columnPrimitive(element));
        break;
      case 'beam':
        primitives.push({
          type: 'polygon',
          layer: layerName('beam'),
          style: 'hidden',
          points: band(element, 0, wallFrame(element).length, element.width / 2),
        });
        break;
      case 'stair':
        primitives.push(...stairPrimitives(doc, element));
        break;
      case 'member':
      case 'footing':
      case 'panel':
      case 'equipment':
      case 'pipe':
      case 'tray':
      case 'plate':
        primitives.push(...industrialPrimitives(doc, element, cutHeight));
        break;
      case 'room':
        primitives.push(...roomPrimitives(doc, element));
        break;
    }
  }
  for (const id of building.elementOrder) {
    const element = building.elements[id];
    if (element?.category === 'grid') primitives.push(...gridPrimitives(doc, element));
  }
  if (options.dimensions !== false) primitives.push(...dimensionPrimitives(doc, building, walls));
  return { level, primitives, bounds: boundsOf(primitives) };
}
