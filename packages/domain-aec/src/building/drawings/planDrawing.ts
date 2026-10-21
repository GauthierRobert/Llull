import type { WallElement } from '@aec/building/types';
import { fromMm } from '@core/model/units';
import { elementsOf, existingLevelId, getBuilding, orderedElements } from '../model';
import { wallFrame } from '../geometry/wallGeometry';
import { type PlanDrawing, type PlanSource, band, layerName } from './planModel';
import { type DrawingPrimitive, drawingBounds } from '@core/model/drawing';
import {
  columnPrimitive,
  curvedWallPrimitives,
  dimensionPrimitives,
  gridPrimitives,
  roomPrimitives,
  slabPrimitives,
  wallPrimitives,
} from './planArchitectural';
import { stairPrimitives } from './planStairs';
import { crossingColumnPrimitives, industrialPrimitives } from './planIndustrial';
import { supportPrimitives } from './planSupports';

/**
 * Builds the plan of `levelId` (or the active / lowest level).
 * @failure no such level -> null
 */
export function buildPlanDrawing(doc: PlanSource, levelId: string | undefined, options: { dimensions?: boolean } = {}): PlanDrawing | null {
  const building = getBuilding(doc);
  const resolvedId = existingLevelId(building, levelId);
  const level = resolvedId !== undefined ? building.levels[resolvedId] : undefined;
  if (!level) return null;
  const cutHeight = fromMm(doc, 1200);
  const primitives: DrawingPrimitive[] = [];
  const walls: WallElement[] = [];
  for (const element of orderedElements(building)) {
    if (!('levelId' in element)) continue;
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
      case 'pipeSupport':
        primitives.push(...supportPrimitives(doc, building, element));
        break;
      case 'room':
        primitives.push(...roomPrimitives(doc, element));
        break;
    }
  }
  for (const grid of elementsOf(building, 'grid')) primitives.push(...gridPrimitives(doc, grid));
  if (options.dimensions !== false) primitives.push(...dimensionPrimitives(doc, building, walls));
  return { level, primitives, bounds: drawingBounds(primitives) };
}
