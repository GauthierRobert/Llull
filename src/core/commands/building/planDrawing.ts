/**
 * plan: planDrawing.
 * @layer core/commands/building
 */

import type { Vec2 } from '../../model/types';
import type { WallElement } from '../../model/building';
import { polygonArea, polygonCentroid } from '../../../lib/polygon';
import { fromMm, getBuilding, toMetres } from './model';
import { openingsOf, wallFrame } from './evaluate';
import {
  curvedBandBetween,
  curvedWallExtent,
  curvedWallPieces,
  tangentWall,
} from './curvedWallGeometry';
import {
  type PlanDrawing,
  type PlanPrimitive,
  type PlanSource,
  band,
  layerName,
} from './planModel';
import {
  boundsOf,
  dimensionPrimitives,
  openingSymbol,
  stairPrimitives,
  wallPrimitives,
} from './planArchitectural';
import { industrialPrimitives } from './planIndustrial';

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
    if (!element || !('levelId' in element) || element.levelId !== level.id) continue;
    switch (element.category) {
      case 'wall':
        walls.push(element);
        primitives.push(...wallPrimitives(building, element, cutHeight));
        break;
      case 'curvedWall': {
        const extent = curvedWallExtent(building, element);
        const band = curvedBandBetween(element, extent.start, extent.end);
        if (!band) break;
        const openings = openingsOf(building, element.id);
        const localCut = cutHeight - element.baseOffset;
        if (!(localCut >= 0 && localCut < element.height)) {
          primitives.push({
            type: 'polygon',
            layer: layerName('wall'),
            style: 'hidden',
            points: band,
          });
          break;
        }
        for (const piece of curvedWallPieces(element, openings, extent)) {
          if (!(piece.z0 <= localCut && localCut < piece.z1)) continue;
          const points = curvedBandBetween(element, piece.s0, piece.s1);
          if (points) {
            primitives.push({
              type: 'polygon',
              layer: layerName('wall'),
              style: 'cut',
              fill: 'hatch',
              points,
            });
          }
        }
        for (const opening of openings) {
          primitives.push(...openingSymbol(tangentWall(element, opening.offset), opening));
        }
        break;
      }
      case 'slab':
        primitives.push({
          type: 'polygon',
          layer: layerName('slab'),
          style: 'thin',
          points: element.boundary,
        });
        for (const opening of element.openings ?? []) {
          const far = opening[Math.floor(opening.length / 2)] as Vec2;
          const near = opening[Math.floor(opening.length / 2) - 1] as Vec2;
          primitives.push(
            { type: 'polygon', layer: layerName('slab'), style: 'thin', points: opening },
            {
              type: 'line',
              layer: layerName('slab'),
              style: 'thin',
              a: opening[0] as Vec2,
              b: far,
            },
            {
              type: 'line',
              layer: layerName('slab'),
              style: 'thin',
              a: opening[opening.length - 1] as Vec2,
              b: near,
            },
          );
        }
        break;
      case 'column': {
        const [x, y] = element.location;
        primitives.push(
          element.shape === 'circular'
            ? {
                type: 'circle',
                layer: layerName('column'),
                style: 'cut',
                center: element.location,
                radius: element.width / 2,
              }
            : {
                type: 'polygon',
                layer: layerName('column'),
                style: 'cut',
                fill: 'hatch',
                points: band(
                  { start: [x - element.width / 2, y], end: [x + element.width / 2, y] },
                  0,
                  element.width,
                  element.depth / 2,
                ),
              },
        );
        break;
      }
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
      case 'room': {
        const [cx, cy] = polygonCentroid(element.boundary);
        const textHeight = fromMm(doc, 250);
        const area = polygonArea(element.boundary) * toMetres(doc, 1) ** 2;
        primitives.push(
          {
            type: 'text',
            layer: layerName('room'),
            style: 'annotation',
            at: [cx, cy + textHeight * 0.7],
            height: textHeight,
            content: element.name,
          },
          {
            type: 'text',
            layer: layerName('room'),
            style: 'annotation',
            at: [cx, cy - textHeight * 0.9],
            height: textHeight * 0.8,
            content: `${element.mark} · ${area.toFixed(2)} m²`,
          },
        );
        break;
      }
    }
  }
  const bubbleRadius = fromMm(doc, 400);
  for (const id of building.elementOrder) {
    const element = building.elements[id];
    if (element?.category !== 'grid') continue;
    const frame = wallFrame(element);
    primitives.push({
      type: 'line',
      layer: layerName('grid'),
      style: 'thin',
      a: element.start,
      b: element.end,
    });
    for (const [point, sign] of [
      [element.start, -1],
      [element.end, 1],
    ] as const) {
      const center: Vec2 = [
        point[0] + sign * frame.direction[0] * bubbleRadius,
        point[1] + sign * frame.direction[1] * bubbleRadius,
      ];
      primitives.push(
        { type: 'circle', layer: layerName('grid'), style: 'thin', center, radius: bubbleRadius },
        {
          type: 'text',
          layer: layerName('grid'),
          style: 'annotation',
          at: [center[0], center[1] - bubbleRadius * 0.4],
          height: bubbleRadius * 0.9,
          content: element.mark,
        },
      );
    }
  }
  if (options.dimensions !== false) primitives.push(...dimensionPrimitives(doc, building, walls));
  return { level, primitives, bounds: boundsOf(primitives) };
}
