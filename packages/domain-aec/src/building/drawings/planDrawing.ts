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
import { appendAll } from '@lib/appendAll';

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
      appendAll(primitives, crossingColumnPrimitives(doc, element, level, cutHeight));
      continue;
    }
    switch (element.category) {
      case 'wall':
        walls.push(element);
        appendAll(primitives, wallPrimitives(building, element, cutHeight));
        break;
      case 'curvedWall':
        appendAll(primitives, curvedWallPrimitives(building, element, cutHeight));
        break;
      case 'slab':
        appendAll(primitives, slabPrimitives(element));
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
        appendAll(primitives, stairPrimitives(doc, element));
        break;
      case 'member':
      case 'footing':
      case 'panel':
      case 'equipment':
      case 'pipe':
      case 'tray':
      case 'plate':
        appendAll(primitives, industrialPrimitives(doc, element, cutHeight));
        break;
      case 'pipeSupport':
        appendAll(primitives, supportPrimitives(doc, building, element));
        break;
      case 'room':
        appendAll(primitives, roomPrimitives(doc, element));
        break;
    }
  }
  for (const grid of elementsOf(building, 'grid')) appendAll(primitives, gridPrimitives(doc, grid));
  if (options.dimensions !== false) appendAll(primitives, dimensionPrimitives(doc, building, walls));
  return { level, primitives, bounds: drawingBounds(primitives) };
}
