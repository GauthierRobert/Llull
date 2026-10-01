/**
 * Pure floor-plan drawing of one level: a horizontal cut (default 1.2 m above the floor) of the
 * building model, as neutral 2D primitives consumed by the DXF and SVG sheet writers.
 * Coordinates are model plan coordinates in document units.
 * @layer core/commands/building
 * @pure
 */

import type { CadDocument, Vec2 } from '../../model/types';
import type {
  BimCategory,
  BuildingLevel,
  BuildingModel,
  OpeningElement,
  WallElement,
} from '../../model/building';
import { polygonArea, polygonCentroid } from '../../../lib/polygon';
import { fromMm, getBuilding, toMetres } from './model';
import { CATEGORY_LAYER, endAdjustment, openingsOf, pointAlong, wallFrame } from './evaluate';

export type PlanStyle = 'cut' | 'thin' | 'hidden' | 'annotation';

export type PlanPrimitive =
  | {
      readonly type: 'polygon';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly points: Vec2[];
    }
  | {
      readonly type: 'polyline';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly points: Vec2[];
    }
  | {
      readonly type: 'line';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly a: Vec2;
      readonly b: Vec2;
    }
  | {
      readonly type: 'arc';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly center: Vec2;
      readonly radius: number;
      readonly startAngle: number;
      readonly endAngle: number;
    }
  | {
      readonly type: 'circle';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly center: Vec2;
      readonly radius: number;
    }
  | {
      readonly type: 'text';
      readonly layer: string;
      readonly style: PlanStyle;
      readonly at: Vec2;
      readonly height: number;
      readonly content: string;
    }
  | {
      readonly type: 'dimension';
      readonly layer: string;
      readonly style: PlanStyle;
      /** Measured points; the dimension line sits `offset` away on the right of a→b. */
      readonly a: Vec2;
      readonly b: Vec2;
      readonly offset: number;
      readonly label: string;
    };

export interface PlanDrawing {
  readonly level: BuildingLevel;
  readonly primitives: PlanPrimitive[];
  /** [minX, minY, maxX, maxY] of all primitives (model units). */
  readonly bounds: readonly [number, number, number, number];
}

export const DIMENSION_LAYER = 'A-ANNO-DIMS';

/** The document slices a plan depends on. */
export type PlanSource = Pick<CadDocument, 'building' | 'units'>;

function layerName(category: BimCategory): string {
  return CATEGORY_LAYER[category].name;
}

function band(
  axis: Pick<WallElement, 'start' | 'end'>,
  s0: number,
  s1: number,
  halfWidth: number,
): Vec2[] {
  const frame = wallFrame(axis);
  return [
    pointAlong(axis, frame, s0, -halfWidth),
    pointAlong(axis, frame, s1, -halfWidth),
    pointAlong(axis, frame, s1, halfWidth),
    pointAlong(axis, frame, s0, halfWidth),
  ];
}

function isCut(opening: OpeningElement, cutHeight: number): boolean {
  return opening.sillHeight < cutHeight && opening.sillHeight + opening.height > cutHeight;
}

function wallPrimitives(
  building: BuildingModel,
  wall: WallElement,
  cutHeight: number,
): PlanPrimitive[] {
  const frame = wallFrame(wall);
  const half = wall.thickness / 2;
  const primitives: PlanPrimitive[] = [];
  const openings = openingsOf(building, wall.id);
  let cursor = -endAdjustment(building, wall, 'start');
  const finish = frame.length + endAdjustment(building, wall, 'end');
  for (const opening of openings.filter((candidate) =>
    isCut(candidate, cutHeight - wall.baseOffset),
  )) {
    const left = opening.offset - opening.width / 2;
    if (left > cursor) {
      primitives.push({
        type: 'polygon',
        layer: layerName('wall'),
        style: 'cut',
        points: band(wall, cursor, left, half),
      });
    }
    cursor = Math.max(cursor, opening.offset + opening.width / 2);
  }
  if (finish > cursor) {
    primitives.push({
      type: 'polygon',
      layer: layerName('wall'),
      style: 'cut',
      points: band(wall, cursor, finish, half),
    });
  }
  for (const opening of openings) {
    const left = opening.offset - opening.width / 2;
    const right = opening.offset + opening.width / 2;
    if (opening.category === 'window') {
      for (const across of [-half, 0, half]) {
        primitives.push({
          type: 'line',
          layer: layerName('window'),
          style: 'thin',
          a: pointAlong(wall, frame, left, across),
          b: pointAlong(wall, frame, right, across),
        });
      }
      continue;
    }
    const hinge = pointAlong(wall, frame, opening.swing === 'left' ? left : right, half);
    const openAngle = frame.angle + Math.PI / 2;
    const [startAngle, endAngle] =
      opening.swing === 'left' ? [frame.angle, openAngle] : [openAngle, frame.angle + Math.PI];
    primitives.push(
      {
        type: 'arc',
        layer: layerName('door'),
        style: 'thin',
        center: hinge,
        radius: opening.width,
        startAngle,
        endAngle,
      },
      {
        type: 'line',
        layer: layerName('door'),
        style: 'thin',
        a: hinge,
        b: [
          hinge[0] + Math.cos(openAngle) * opening.width,
          hinge[1] + Math.sin(openAngle) * opening.width,
        ],
      },
    );
  }
  return primitives;
}

export function boundsOf(
  primitives: ReadonlyArray<PlanPrimitive>,
): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (point: Vec2, pad = 0): void => {
    minX = Math.min(minX, point[0] - pad);
    minY = Math.min(minY, point[1] - pad);
    maxX = Math.max(maxX, point[0] + pad);
    maxY = Math.max(maxY, point[1] + pad);
  };
  for (const primitive of primitives) {
    switch (primitive.type) {
      case 'polygon':
      case 'polyline':
        primitive.points.forEach((point) => include(point));
        break;
      case 'line':
        include(primitive.a);
        include(primitive.b);
        break;
      case 'arc':
      case 'circle':
        include(primitive.center, primitive.radius);
        break;
      case 'text':
        include(primitive.at, primitive.height);
        break;
      case 'dimension':
        include(primitive.a, primitive.offset * 1.5);
        include(primitive.b, primitive.offset * 1.5);
        break;
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : [0, 0, 0, 0];
}

/** Dimension text in millimetres (construction convention). */
export function dimensionLabel(doc: PlanSource, value: number): string {
  return String(Math.round(toMetres(doc, value) * 1000));
}

function dimension(a: Vec2, b: Vec2, offset: number, label: string): PlanPrimitive {
  return { type: 'dimension', layer: DIMENSION_LAYER, style: 'annotation', a, b, offset, label };
}

/** Overall wall extents + grid spacing chains. */
function dimensionPrimitives(
  doc: PlanSource,
  building: BuildingModel,
  walls: ReadonlyArray<WallElement>,
): PlanPrimitive[] {
  const primitives: PlanPrimitive[] = [];
  const gap = fromMm(doc, 1200);
  if (walls.length > 0) {
    const half = Math.max(...walls.map((wall) => wall.thickness)) / 2;
    const xs = walls.flatMap((wall) => [wall.start[0], wall.end[0]]);
    const ys = walls.flatMap((wall) => [wall.start[1], wall.end[1]]);
    const minX = Math.min(...xs) - half;
    const maxX = Math.max(...xs) + half;
    const minY = Math.min(...ys) - half;
    const maxY = Math.max(...ys) + half;
    primitives.push(dimension([minX, minY], [maxX, minY], gap, dimensionLabel(doc, maxX - minX)));
    primitives.push(dimension([minX, maxY], [minX, minY], gap, dimensionLabel(doc, maxY - minY)));
  }
  const grids = Object.values(building.elements).filter((element) => element.category === 'grid');
  const numbered = grids
    .filter((grid) => Math.abs(grid.start[0] - grid.end[0]) < 1e-9)
    .sort((a, b) => a.start[0] - b.start[0]);
  const lettered = grids
    .filter((grid) => Math.abs(grid.start[1] - grid.end[1]) < 1e-9)
    .sort((a, b) => a.start[1] - b.start[1]);
  for (let index = 0; index + 1 < numbered.length; index++) {
    const [a, b] = [numbered[index], numbered[index + 1]];
    if (!a || !b) continue;
    const top = Math.max(a.start[1], a.end[1], b.start[1], b.end[1]);
    primitives.push(
      dimension(
        [b.start[0], top],
        [a.start[0], top],
        gap / 2,
        dimensionLabel(doc, b.start[0] - a.start[0]),
      ),
    );
  }
  for (let index = 0; index + 1 < lettered.length; index++) {
    const [a, b] = [lettered[index], lettered[index + 1]];
    if (!a || !b) continue;
    const right = Math.max(a.start[0], a.end[0], b.start[0], b.end[0]);
    primitives.push(
      dimension(
        [right, a.start[1]],
        [right, b.start[1]],
        gap / 2,
        dimensionLabel(doc, b.start[1] - a.start[1]),
      ),
    );
  }
  return primitives;
}

function stairPrimitives(
  doc: PlanSource,
  stair: Extract<BuildingModel['elements'][string], { category: 'stair' }>,
): PlanPrimitive[] {
  const direction: Vec2 = [Math.cos(stair.angle), Math.sin(stair.angle)];
  const normal: Vec2 = [-direction[1], direction[0]];
  const half = stair.width / 2;
  const at = (along: number, across: number): Vec2 => [
    stair.start[0] + direction[0] * along + normal[0] * across,
    stair.start[1] + direction[1] * along + normal[1] * across,
  ];
  const run = stair.riserCount * stair.treadDepth;
  const layer = layerName('stair');
  const primitives: PlanPrimitive[] = [
    {
      type: 'polygon',
      layer,
      style: 'thin',
      points: [at(0, -half), at(run, -half), at(run, half), at(0, half)],
    },
  ];
  for (let index = 1; index < stair.riserCount; index++) {
    const along = index * stair.treadDepth;
    primitives.push({
      type: 'line',
      layer,
      style: 'thin',
      a: at(along, -half),
      b: at(along, half),
    });
  }
  primitives.push(
    {
      type: 'polyline',
      layer,
      style: 'thin',
      points: [at(stair.treadDepth / 2, 0), at(run - stair.treadDepth / 2, 0)],
    },
    {
      type: 'text',
      layer,
      style: 'annotation',
      at: at(-fromMm(doc, 400), 0),
      height: fromMm(doc, 200),
      content: `UP ${stair.riserCount}R`,
    },
  );
  return primitives;
}

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
