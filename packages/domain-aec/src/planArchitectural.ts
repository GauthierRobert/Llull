/**
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import type { BuildingModel, OpeningElement, WallElement } from '@core/model/building';
import { fromMm, toMetres } from './model';
import { openingsOf, pointAlong, wallExtent, wallFrame } from './wallGeometry';
import { layerBoundaries } from './wallLayers';
import {
  DIMENSION_LAYER,
  type PlanPrimitive,
  type PlanSource,
  band,
  isCut,
  layerName,
} from './planModel';

/** Plan symbol of a door (leaf + swing) or window (three lines) in a straight wall frame. */
export function openingSymbol(
  wall: Pick<WallElement, 'start' | 'end' | 'thickness'>,
  opening: OpeningElement,
): PlanPrimitive[] {
  const frame = wallFrame(wall);
  const half = wall.thickness / 2;
  const primitives: PlanPrimitive[] = [];
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
    return primitives;
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

  return primitives;
}

export function wallPrimitives(
  building: BuildingModel,
  wall: WallElement,
  cutHeight: number,
): PlanPrimitive[] {
  const frame = wallFrame(wall);
  const half = wall.thickness / 2;
  const primitives: PlanPrimitive[] = [];
  const openings = openingsOf(building, wall.id);
  const extent = wallExtent(building, wall);
  let cursor = extent.start;
  const finish = extent.end;
  for (const opening of openings.filter((candidate) =>
    isCut(candidate, cutHeight - wall.baseOffset),
  )) {
    const left = opening.offset - opening.width / 2;
    if (left > cursor) {
      primitives.push({
        type: 'polygon',
        layer: layerName('wall'),
        style: 'cut',
        fill: 'hatch',
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
      fill: 'hatch',
      points: band(wall, cursor, finish, half),
    });
  }
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
        primitives.push({
          type: 'line',
          layer: layerName('wall'),
          style: 'thin',
          a: pointAlong(wall, frame, from, across),
          b: pointAlong(wall, frame, to, across),
        });
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
