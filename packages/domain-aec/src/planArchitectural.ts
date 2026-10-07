/**
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import type {
  BuildingModel,
  ColumnElement,
  CurvedWallElement,
  GridElement,
  OpeningElement,
  RoomElement,
  SlabElement,
  WallElement,
} from '@core/model/building';
import { polygonArea, polygonCentroid } from '@lib/polygon';
import { curvedBandBetween, curvedWallExtent, tangentWall } from './curvedWallGeometry';
import { fromMm, toMetres } from './model';
import { gridBubbleCenters } from './grid';
import {
  doorSwing,
  openingsOf,
  pointAlong,
  wallExtent,
  wallFrame,
  wallPieces,
} from './wallGeometry';
import { stairPoint } from './stairGeometry';
import { layerBoundaries } from './wallLayers';
import {
  DIMENSION_LAYER,
  type PlanPrimitive,
  type PlanSource,
  annotationText,
  band,
  isCut,
  layerName,
  thinLine,
} from './planModel';

/** Plan symbol of a door (leaf + swing) or window (three lines) in a straight wall frame. */
function openingSymbol(
  wall: Pick<WallElement, 'start' | 'end' | 'thickness'>,
  opening: OpeningElement,
): PlanPrimitive[] {
  const layer = layerName(opening.category);
  if (opening.category === 'window') {
    const frame = wallFrame(wall);
    const half = wall.thickness / 2;
    const left = opening.offset - opening.width / 2;
    const right = opening.offset + opening.width / 2;
    return [-half, 0, half].map((across) =>
      thinLine(
        layer,
        pointAlong(wall, frame, left, across),
        pointAlong(wall, frame, right, across),
      ),
    );
  }
  const { hinge, leafEnd, startAngle, endAngle } = doorSwing(wall, opening);
  return [
    {
      type: 'arc',
      layer,
      style: 'thin',
      center: hinge,
      radius: opening.width,
      startAngle,
      endAngle,
    },
    thinLine(layer, hinge, leafEnd),
  ];
}

export function wallPrimitives(
  building: BuildingModel,
  wall: WallElement,
  cutHeight: number,
): PlanPrimitive[] {
  const frame = wallFrame(wall);
  const half = wall.thickness / 2;
  const layer = layerName('wall');
  const primitives: PlanPrimitive[] = [];
  const openings = openingsOf(building, wall.id);
  const extent = wallExtent(building, wall);
  const addCut = (from: number, to: number): void => {
    primitives.push({
      type: 'polygon',
      layer,
      style: 'cut',
      fill: 'hatch',
      points: band(wall, from, to, half),
    });
  };
  let cursor = extent.start;
  for (const opening of openings.filter((candidate) =>
    isCut(candidate, cutHeight - wall.baseOffset),
  )) {
    const left = opening.offset - opening.width / 2;
    if (left > cursor) addCut(cursor, left);
    cursor = Math.max(cursor, opening.offset + opening.width / 2);
  }
  if (extent.end > cursor) addCut(cursor, extent.end);
  // Build-up: a thin line along every layer boundary of each cut piece.
  const boundaries = layerBoundaries(wall);
  if (boundaries.length > 0) {
    const pieces = primitives.flatMap((primitive) =>
      primitive.type === 'polygon' ? [primitive.points] : [],
    );
    for (const piece of pieces) {
      const along = piece.map(
        (point) =>
          (point[0] - wall.start[0]) * frame.direction[0] +
          (point[1] - wall.start[1]) * frame.direction[1],
      );
      const [from, to] = [Math.min(...along), Math.max(...along)];
      for (const across of boundaries) {
        primitives.push(
          thinLine(
            layer,
            pointAlong(wall, frame, from, across),
            pointAlong(wall, frame, to, across),
          ),
        );
      }
    }
  }
  for (const opening of openings) primitives.push(...openingSymbol(wall, opening));
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
export function dimensionPrimitives(
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

export function stairPrimitives(
  doc: PlanSource,
  stair: Extract<BuildingModel['elements'][string], { category: 'stair' }>,
): PlanPrimitive[] {
  const half = stair.width / 2;
  const at = (along: number, across: number): Vec2 => stairPoint(stair, along, across);
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
    primitives.push(thinLine(layer, at(along, -half), at(along, half)));
  }
  primitives.push(
    {
      type: 'polyline',
      layer,
      style: 'thin',
      points: [at(stair.treadDepth / 2, 0), at(run - stair.treadDepth / 2, 0)],
    },
    annotationText(layer, at(-fromMm(doc, 400), 0), fromMm(doc, 200), `UP ${stair.riserCount}R`),
  );
  return primitives;
}

/** Cut band of a curved wall (hatched pieces + opening symbols), or its hidden outline above the cut. */
export function curvedWallPrimitives(
  building: BuildingModel,
  wall: CurvedWallElement,
  cutHeight: number,
): PlanPrimitive[] {
  const extent = curvedWallExtent(building, wall);
  const outline = curvedBandBetween(wall, extent.start, extent.end);
  if (!outline) return [];
  const layer = layerName('wall');
  const localCut = cutHeight - wall.baseOffset;
  if (!(localCut >= 0 && localCut < wall.height)) {
    return [{ type: 'polygon', layer, style: 'hidden', points: outline }];
  }
  const openings = openingsOf(building, wall.id);
  const primitives: PlanPrimitive[] = [];
  for (const piece of wallPieces(wall, openings, extent)) {
    if (!(piece.z0 <= localCut && localCut < piece.z1)) continue;
    const points = curvedBandBetween(wall, piece.s0, piece.s1);
    if (points) primitives.push({ type: 'polygon', layer, style: 'cut', fill: 'hatch', points });
  }
  for (const opening of openings) {
    primitives.push(...openingSymbol(tangentWall(wall, opening.offset), opening));
  }
  return primitives;
}

/** Slab outline plus each opening outline with its diagonal break line. */
export function slabPrimitives(slab: SlabElement): PlanPrimitive[] {
  const layer = layerName('slab');
  const primitives: PlanPrimitive[] = [
    { type: 'polygon', layer, style: 'thin', points: slab.boundary },
  ];
  for (const opening of slab.openings ?? []) {
    const middle = Math.floor(opening.length / 2);
    primitives.push(
      { type: 'polygon', layer, style: 'thin', points: opening },
      thinLine(layer, opening[0] as Vec2, opening[middle] as Vec2),
      thinLine(layer, opening[opening.length - 1] as Vec2, opening[middle - 1] as Vec2),
    );
  }
  return primitives;
}

export function columnPrimitive(column: ColumnElement): PlanPrimitive {
  const layer = layerName('column');
  if (column.shape === 'circular') {
    return {
      type: 'circle',
      layer,
      style: 'cut',
      center: column.location,
      radius: column.width / 2,
    };
  }
  const [x, y] = column.location;
  const axis = { start: [x - column.width / 2, y] as Vec2, end: [x + column.width / 2, y] as Vec2 };
  return {
    type: 'polygon',
    layer,
    style: 'cut',
    fill: 'hatch',
    points: band(axis, 0, column.width, column.depth / 2),
  };
}

/** Room name and "mark · area" tags at the outline centroid. */
export function roomPrimitives(doc: PlanSource, room: RoomElement): PlanPrimitive[] {
  const [cx, cy] = polygonCentroid(room.boundary);
  const textHeight = fromMm(doc, 250);
  const area = polygonArea(room.boundary) * toMetres(doc, 1) ** 2;
  const layer = layerName('room');
  return [
    annotationText(layer, [cx, cy + textHeight * 0.7], textHeight, room.name),
    annotationText(
      layer,
      [cx, cy - textHeight * 0.9],
      textHeight * 0.8,
      `${room.mark} · ${area.toFixed(2)} m²`,
    ),
  ];
}

/** Axis line with a labelled bubble at each end. */
export function gridPrimitives(doc: PlanSource, grid: GridElement): PlanPrimitive[] {
  const bubbleRadius = fromMm(doc, 400);
  const layer = layerName('grid');
  const primitives: PlanPrimitive[] = [thinLine(layer, grid.start, grid.end)];
  for (const center of gridBubbleCenters(grid, bubbleRadius)) {
    primitives.push(
      { type: 'circle', layer, style: 'thin', center, radius: bubbleRadius },
      annotationText(
        layer,
        [center[0], center[1] - bubbleRadius * 0.4],
        bubbleRadius * 0.9,
        grid.mark,
      ),
    );
  }
  return primitives;
}
