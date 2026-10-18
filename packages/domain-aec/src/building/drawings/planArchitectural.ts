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
import { polygonCentroid } from '@lib/polygon';
import { curvedBandBetween, curvedWallExtent, tangentWall } from '../geometry/curvedWallGeometry';
import { fromMm, toMetres } from '@core/model/units';
import { planAreaM2 } from '../../shared/planArea';
import { gridBubbleCenters } from '../geometry/gridGeometry';
import { doorSwing, openingsOf, pointAlong, wallExtent, wallFrame, wallPieces } from '../geometry/wallGeometry';
import { layerBoundaries } from '../elements/wallLayers';
import { DIMENSION_LAYER, type PlanSource, annotationText, band, isCut, layerName, thinLine } from './planModel';
import type { DrawingPrimitive } from '@core/model/drawing';
import { pointsExtent } from '@lib/extent';

/** Plan symbol of a door (leaf + swing) or window (three lines) in a straight wall frame. */
function openingSymbol(wall: Pick<WallElement, 'start' | 'end' | 'thickness'>, opening: OpeningElement): DrawingPrimitive[] {
  const layer = layerName(opening.category);
  if (opening.category === 'window') {
    const frame = wallFrame(wall);
    const half = wall.thickness / 2;
    const left = opening.offset - opening.width / 2;
    const right = opening.offset + opening.width / 2;
    return [-half, 0, half].map((across) => thinLine(layer, pointAlong(wall, frame, left, across), pointAlong(wall, frame, right, across)));
  }
  const { hinge, leafEnd, startAngle, endAngle } = doorSwing(wall, opening);
  return [
    { type: 'arc', layer, style: 'thin', center: hinge, radius: opening.width, startAngle, endAngle },
    thinLine(layer, hinge, leafEnd),
  ];
}

export function wallPrimitives(building: BuildingModel, wall: WallElement, cutHeight: number): DrawingPrimitive[] {
  const frame = wallFrame(wall);
  const half = wall.thickness / 2;
  const layer = layerName('wall');
  const primitives: DrawingPrimitive[] = [];
  const openings = openingsOf(building, wall.id);
  const extent = wallExtent(building, wall);
  const addCut = (from: number, to: number): void => {
    primitives.push({ type: 'polygon', layer, style: 'cut', fill: 'hatch', points: band(wall, from, to, half) });
  };
  let cursor = extent.start;
  for (const opening of openings.filter((candidate) => isCut(candidate, cutHeight - wall.baseOffset))) {
    const left = opening.offset - opening.width / 2;
    if (left > cursor) addCut(cursor, left);
    cursor = Math.max(cursor, opening.offset + opening.width / 2);
  }
  if (extent.end > cursor) addCut(cursor, extent.end);
  // Build-up: a thin line along every layer boundary of each cut piece.
  const boundaries = layerBoundaries(wall);
  if (boundaries.length > 0) {
    const pieces = primitives.flatMap((primitive) => (primitive.type === 'polygon' ? [primitive.points] : []));
    for (const piece of pieces) {
      const along = piece.map((point) => (point[0] - wall.start[0]) * frame.direction[0] + (point[1] - wall.start[1]) * frame.direction[1]);
      const [from, to] = [Math.min(...along), Math.max(...along)];
      for (const across of boundaries) {
        primitives.push(thinLine(layer, pointAlong(wall, frame, from, across), pointAlong(wall, frame, to, across)));
      }
    }
  }
  for (const opening of openings) primitives.push(...openingSymbol(wall, opening));
  return primitives;
}

const GRID_BUBBLE_RADIUS_MM = 400;

/** Dimension text in millimetres (construction convention). */
export function dimensionLabel(doc: PlanSource, value: number): string {
  return String(Math.round(toMetres(doc, value) * 1000));
}

function dimension(a: Vec2, b: Vec2, offset: number, label: string): DrawingPrimitive {
  return { type: 'dimension', layer: DIMENSION_LAYER, style: 'annotation', a, b, offset, label };
}

/** Outer edge of the grid bubble ring per side ([minX, minY, maxX, maxY]), or null without grids. */
function bubbleRing(doc: PlanSource, grids: ReadonlyArray<GridElement>): [number, number, number, number] | null {
  const radius = fromMm(doc, GRID_BUBBLE_RADIUS_MM);
  const circles = grids.flatMap((grid) => gridBubbleCenters(grid, radius));
  if (circles.length === 0) return null;
  const extent = pointsExtent(circles);
  return [extent.minX - radius, extent.minY - radius, extent.maxX + radius, extent.maxY + radius];
}

/** Overall wall extents + grid spacing chains; all chains are anchored outside the grid bubble ring so they never cross a bubble. */
export function dimensionPrimitives(doc: PlanSource, building: BuildingModel, walls: ReadonlyArray<WallElement>): DrawingPrimitive[] {
  const primitives: DrawingPrimitive[] = [];
  const gap = fromMm(doc, 1200);
  const grids = Object.values(building.elements).filter((element) => element.category === 'grid');
  const ring = bubbleRing(doc, grids);
  const clear = fromMm(doc, 200);
  if (walls.length > 0) {
    const half = Math.max(...walls.map((wall) => wall.thickness)) / 2;
    const extent = pointsExtent(walls.flatMap((wall) => [wall.start, wall.end]));
    const [minX, minY, maxX, maxY] = [extent.minX - half, extent.minY - half, extent.maxX + half, extent.maxY + half];
    const [baseX, baseY] = ring ? [Math.min(minX, ring[0] - clear), Math.min(minY, ring[1] - clear)] : [minX, minY];
    primitives.push(dimension([minX, baseY], [maxX, baseY], gap, dimensionLabel(doc, maxX - minX)));
    primitives.push(dimension([baseX, maxY], [baseX, minY], gap, dimensionLabel(doc, maxY - minY)));
  }
  const numbered = grids.filter((grid) => Math.abs(grid.start[0] - grid.end[0]) < 1e-9).sort((a, b) => a.start[0] - b.start[0]);
  const lettered = grids.filter((grid) => Math.abs(grid.start[1] - grid.end[1]) < 1e-9).sort((a, b) => a.start[1] - b.start[1]);
  for (let index = 0; index + 1 < numbered.length; index++) {
    const [a, b] = [numbered[index], numbered[index + 1]];
    if (!a || !b) continue;
    const top = Math.max(a.start[1], a.end[1], b.start[1], b.end[1], ring ? ring[3] + clear : -Infinity);
    primitives.push(dimension([b.start[0], top], [a.start[0], top], gap / 2, dimensionLabel(doc, b.start[0] - a.start[0])));
  }
  for (let index = 0; index + 1 < lettered.length; index++) {
    const [a, b] = [lettered[index], lettered[index + 1]];
    if (!a || !b) continue;
    const right = Math.max(a.start[0], a.end[0], b.start[0], b.end[0], ring ? ring[2] + clear : -Infinity);
    primitives.push(dimension([right, a.start[1]], [right, b.start[1]], gap / 2, dimensionLabel(doc, b.start[1] - a.start[1])));
  }
  return primitives;
}

/** Cut band of a curved wall (hatched pieces + opening symbols), or its hidden outline above the cut. */
export function curvedWallPrimitives(building: BuildingModel, wall: CurvedWallElement, cutHeight: number): DrawingPrimitive[] {
  const extent = curvedWallExtent(building, wall);
  const outline = curvedBandBetween(wall, extent.start, extent.end);
  if (!outline) return [];
  const layer = layerName('wall');
  const localCut = cutHeight - wall.baseOffset;
  if (!(localCut >= 0 && localCut < wall.height)) return [{ type: 'polygon', layer, style: 'hidden', points: outline }];
  const openings = openingsOf(building, wall.id);
  const primitives: DrawingPrimitive[] = [];
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
export function slabPrimitives(slab: SlabElement): DrawingPrimitive[] {
  const layer = layerName('slab');
  const primitives: DrawingPrimitive[] = [{ type: 'polygon', layer, style: 'thin', points: slab.boundary }];
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

export function columnPrimitive(column: ColumnElement): DrawingPrimitive {
  const layer = layerName('column');
  if (column.shape === 'circular') {
    return { type: 'circle', layer, style: 'cut', fill: 'hatch', center: column.location, radius: column.width / 2 };
  }
  const [x, y] = column.location;
  const axis = { start: [x - column.width / 2, y] as Vec2, end: [x + column.width / 2, y] as Vec2 };
  return { type: 'polygon', layer, style: 'cut', fill: 'hatch', points: band(axis, 0, column.width, column.depth / 2) };
}

/** Room name and "mark · area" tags at the outline centroid. */
export function roomPrimitives(doc: PlanSource, room: RoomElement): DrawingPrimitive[] {
  const [cx, cy] = polygonCentroid(room.boundary);
  const textHeight = fromMm(doc, 250);
  const area = planAreaM2(doc, room.boundary);
  const layer = layerName('room');
  return [
    annotationText(layer, [cx, cy + textHeight * 0.7], textHeight, room.name),
    annotationText(layer, [cx, cy - textHeight * 0.9], textHeight * 0.8, `${room.mark} · ${area.toFixed(2)} m²`),
  ];
}

/** Axis line with a labelled bubble at each end. */
export function gridPrimitives(doc: PlanSource, grid: GridElement): DrawingPrimitive[] {
  const bubbleRadius = fromMm(doc, GRID_BUBBLE_RADIUS_MM);
  const layer = layerName('grid');
  // Grid lines are chain lines (ISO 128 type 04), like every axis.
  const primitives: DrawingPrimitive[] = [{ type: 'line', layer, style: 'center', a: grid.start, b: grid.end }];
  for (const center of gridBubbleCenters(grid, bubbleRadius)) {
    primitives.push(
      { type: 'circle', layer, style: 'thin', center, radius: bubbleRadius },
      annotationText(layer, [center[0], center[1] - bubbleRadius * 0.4], bubbleRadius * 0.9, grid.mark),
    );
  }
  return primitives;
}
