/**
 * Evaluators of the architectural building elements: wall, opening, slab, column, beam, stair,
 * room and grid → document entities.
 * @layer domain-aec
 */

import type {
  ArcEntity,
  BoxEntity,
  CadDocument,
  CircleEntity,
  CylinderEntity,
  Entity,
  ExtrusionEntity,
  LineEntity,
  PolylineEntity,
  TextEntity,
  Vec3,
} from '@core/model/types';
import type {
  BeamElement,
  BuildingLevel,
  BuildingModel,
  ColumnElement,
  CurvedWallElement,
  GridElement,
  OpeningElement,
  RoomElement,
  SlabElement,
  StairElement,
  WallElement,
} from '@core/model/building';
import { polygonArea, polygonCentroid, toCounterClockwise } from '@lib/polygon';
import { fromMm, toMetres } from './model';
import { prismMesh } from './mesh';
import { base, CATEGORY_LAYER, colorForMaterial, meshEntity, orientedBox } from './entities';
import { curvedBandBetween } from './curvedWallGeometry';
import { gridBubbleCenters } from './grid';
import {
  doorSwing,
  openingsOf,
  pointAlong,
  wallExtent,
  wallFrame,
  wallPieces,
  type WallExtent,
} from './wallGeometry';
import { stairPoint } from './stairGeometry';

export interface EvaluationContext {
  readonly doc: CadDocument;
  readonly building: BuildingModel;
}

export function evaluateWall(
  context: EvaluationContext,
  wall: WallElement,
  level: BuildingLevel,
): Entity[] {
  const frame = wallFrame(wall);
  const baseZ = level.elevation + wall.baseOffset;
  const color = colorForMaterial(wall.material, '#c9c4b8');
  const pieces = wallPieces(
    wall,
    openingsOf(context.building, wall.id),
    wallExtent(context.building, wall),
  );
  return pieces.map((piece, index) => {
    const [x, y] = pointAlong(wall, frame, (piece.s0 + piece.s1) / 2);
    return orientedBox(
      wall,
      { part: `body-${index}`, label: `Wall ${wall.mark}` },
      [x, y, baseZ + (piece.z0 + piece.z1) / 2],
      frame.angle,
      [piece.s1 - piece.s0, wall.thickness, piece.z1 - piece.z0],
      color,
    );
  });
}

export function evaluateOpening(
  context: EvaluationContext,
  opening: OpeningElement,
  wall: WallElement,
  level: BuildingLevel,
): Entity[] {
  const frame = wallFrame(wall);
  const baseZ = level.elevation + wall.baseOffset;
  const [cx, cy] = pointAlong(wall, frame, opening.offset);
  const centerZ = baseZ + opening.sillHeight + opening.height / 2;
  if (opening.category === 'window') {
    const glassThickness = Math.min(fromMm(context.doc, 24), wall.thickness / 2);
    return [
      orientedBox(
        opening,
        { part: 'glass', label: `Window ${opening.mark}` },
        [cx, cy, centerZ],
        frame.angle,
        [opening.width, glassThickness, opening.height],
        colorForMaterial(opening.material, '#8ec9e8'),
      ),
    ];
  }
  const leafThickness = Math.min(fromMm(context.doc, 40), wall.thickness);
  const planZ = level.elevation + fromMm(context.doc, 10);
  const { hinge, leafEnd, startAngle, endAngle } = doorSwing(wall, opening);
  const leaf: BoxEntity = orientedBox(
    opening,
    { part: 'leaf', label: `Door ${opening.mark}` },
    [cx, cy, centerZ],
    frame.angle,
    [opening.width, leafThickness, opening.height],
    colorForMaterial(opening.material, '#8b5a2b'),
  );
  const swingArc: ArcEntity = {
    ...base(
      opening,
      { part: 'swing', label: `Door ${opening.mark} swing` },
      [0, 0, planZ],
      [0, 0, 0],
      '#8b5a2b',
    ),
    kind: 'arc',
    center: hinge,
    radius: opening.width,
    startAngle,
    endAngle,
  };
  const swingLeaf: LineEntity = {
    ...base(
      opening,
      { part: 'swing-leaf', label: `Door ${opening.mark} leaf (plan)` },
      [0, 0, planZ],
      [0, 0, 0],
      '#8b5a2b',
    ),
    kind: 'line',
    start: hinge,
    end: leafEnd,
  };
  return [leaf, swingArc, swingLeaf];
}

export function evaluateSlab(slab: SlabElement, level: BuildingLevel): Entity[] {
  const bottom = level.elevation + slab.offset - slab.thickness;
  const stub = { part: 'body', label: `${slab.role === 'roof' ? 'Roof' : 'Slab'} ${slab.mark}` };
  const color = colorForMaterial(slab.material, '#b4b2aa');
  const openings = slab.openings ?? [];
  const mesh =
    openings.length > 0
      ? prismMesh(slab.boundary, openings, ([x, y], side) => [
          x,
          y,
          side === 1 ? bottom + slab.thickness : bottom,
        ])
      : null;
  if (mesh) return [meshEntity(slab, stub, mesh, color)];
  const extrusion: ExtrusionEntity = {
    ...base(slab, stub, [0, 0, bottom], [0, 0, 0], color),
    kind: 'extrusion',
    profile: toCounterClockwise(slab.boundary),
    depth: slab.thickness,
  };
  return [extrusion];
}

export function evaluateColumn(column: ColumnElement, level: BuildingLevel): Entity[] {
  const center: Vec3 = [
    column.location[0],
    column.location[1],
    level.elevation + column.height / 2,
  ];
  const stub = { part: 'body', label: `Column ${column.mark}` };
  const color = colorForMaterial(column.material, '#9a9a90');
  if (column.shape === 'circular') {
    const cylinder: CylinderEntity = {
      ...base(column, stub, center, [0, 0, 0], color),
      kind: 'cylinder',
      radius: column.width / 2,
      height: column.height,
    };
    return [cylinder];
  }
  return [orientedBox(column, stub, center, 0, [column.width, column.depth, column.height], color)];
}

export function evaluateBeam(beam: BeamElement, level: BuildingLevel): Entity[] {
  const frame = wallFrame(beam);
  const top = level.elevation + level.height + beam.topOffset;
  return [
    orientedBox(
      beam,
      { part: 'body', label: `Beam ${beam.mark}` },
      [(beam.start[0] + beam.end[0]) / 2, (beam.start[1] + beam.end[1]) / 2, top - beam.depth / 2],
      frame.angle,
      [frame.length, beam.width, beam.depth],
      colorForMaterial(beam.material, '#7d8a96'),
    ),
  ];
}

export function evaluateStair(stair: StairElement, level: BuildingLevel): Entity[] {
  const color = colorForMaterial(stair.material, '#b4b2aa');
  const steps: Entity[] = [];
  for (let index = 0; index < stair.riserCount; index++) {
    const along = (index + 0.5) * stair.treadDepth;
    const stepHeight = (index + 1) * stair.riserHeight;
    steps.push(
      orientedBox(
        stair,
        { part: `step-${index}`, label: `Stair ${stair.mark} step ${index + 1}` },
        [...stairPoint(stair, along, 0), level.elevation + stepHeight / 2],
        stair.angle,
        [stair.treadDepth, stair.width, stepHeight],
        color,
      ),
    );
  }
  return steps;
}

export function evaluateRoom(
  context: EvaluationContext,
  room: RoomElement,
  level: BuildingLevel,
): Entity[] {
  const planZ = level.elevation + fromMm(context.doc, 5);
  const color = CATEGORY_LAYER.room.color;
  const [cx, cy] = polygonCentroid(room.boundary);
  const textHeight = fromMm(context.doc, 250);
  const areaSquareMetres = polygonArea(room.boundary) * toMetres(context.doc, 1) ** 2;
  const outline: PolylineEntity = {
    ...base(
      room,
      { part: 'outline', label: `Room ${room.mark} ${room.name}` },
      [0, 0, planZ],
      [0, 0, 0],
      color,
    ),
    kind: 'polyline',
    points: room.boundary,
    closed: true,
  };
  const nameTag: TextEntity = {
    ...base(
      room,
      { part: 'tag-name', label: `Room ${room.mark} name` },
      [cx, cy + textHeight * 0.8, planZ],
      [0, 0, 0],
      color,
    ),
    kind: 'text',
    content: `${room.name} ${room.mark}`,
    height: textHeight,
    anchor: 'center',
  };
  const areaTag: TextEntity = {
    ...base(
      room,
      { part: 'tag-area', label: `Room ${room.mark} area` },
      [cx, cy - textHeight * 0.8, planZ],
      [0, 0, 0],
      color,
    ),
    kind: 'text',
    content: `${areaSquareMetres.toFixed(2)} m²`,
    height: textHeight * 0.8,
    anchor: 'center',
  };
  return [outline, nameTag, areaTag];
}

export function evaluateGrid(context: EvaluationContext, grid: GridElement): Entity[] {
  const color = CATEGORY_LAYER.grid.color;
  const bubbleRadius = fromMm(context.doc, 400);
  const [startCenter, endCenter] = gridBubbleCenters(grid, bubbleRadius);
  const axis: LineEntity = {
    ...base(grid, { part: 'axis', label: `Grid ${grid.mark}` }, [0, 0, 0], [0, 0, 0], color),
    kind: 'line',
    start: grid.start,
    end: grid.end,
  };
  const entities: Entity[] = [axis];
  for (const [part, center] of [
    ['start', startCenter],
    ['end', endCenter],
  ] as const) {
    const bubble: CircleEntity = {
      ...base(
        grid,
        { part: `bubble-${part}`, label: `Grid ${grid.mark} bubble` },
        [0, 0, 0],
        [0, 0, 0],
        color,
      ),
      kind: 'circle',
      center,
      radius: bubbleRadius,
    };
    const label: TextEntity = {
      ...base(
        grid,
        { part: `label-${part}`, label: `Grid ${grid.mark} label` },
        [center[0], center[1] - bubbleRadius * 0.4, 0],
        [0, 0, 0],
        color,
      ),
      kind: 'text',
      content: grid.mark,
      height: bubbleRadius * 0.9,
      anchor: 'center',
    };
    entities.push(bubble, label);
  }
  return entities;
}

export function evaluateCurvedWall(
  wall: CurvedWallElement,
  level: BuildingLevel,
  openings: ReadonlyArray<OpeningElement>,
  extent: WallExtent,
): Entity[] {
  const bottom = level.elevation + wall.baseOffset;
  const color = colorForMaterial(wall.material, '#c9c4b8');
  const pieces = wallPieces(wall, openings, extent);
  return pieces.flatMap((piece, index): Entity[] => {
    const band = curvedBandBetween(wall, piece.s0, piece.s1);
    const mesh = band
      ? prismMesh(band, [], ([x, y], side) => [x, y, bottom + (side ? piece.z1 : piece.z0)])
      : null;
    if (!mesh) return [];
    const part = pieces.length === 1 ? 'body' : `body-${index}`;
    return [meshEntity(wall, { part, label: `Wall ${wall.mark}` }, mesh, color)];
  });
}
