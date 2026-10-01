/**
 * Evaluates the constructive building model into ordinary document entities (architecture L8).
 *
 * @layer core/commands/building
 * @pure
 * @invariant evaluated entity ids are deterministic: `<elementId>:<part>`
 * @invariant no new entity kinds — walls/slabs/… become box / cylinder / extrusion / 2D shapes
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
  MeshData,
  PolylineEntity,
  TextEntity,
  Vec2,
  Vec3,
} from '../../model/types';
import type {
  BeamElement,
  BuildingElement,
  BuildingLevel,
  BuildingModel,
  ColumnElement,
  GridElement,
  OpeningElement,
  RoomElement,
  SlabElement,
  StairElement,
  WallElement,
} from '../../model/building';
import {
  polygonArea,
  polygonCentroid,
  projectOntoSegment,
  distance,
  toCounterClockwise,
} from '../../../lib/polygon';
import { fromMm, toMetres } from './model';
import { prismMesh } from './mesh';
import {
  evaluateEquipment,
  evaluateFooting,
  evaluateMember,
  evaluatePanel,
  evaluatePipe,
  evaluateTray,
  evaluatePlate,
} from './industrial/evaluate';

import {
  base,
  CATEGORY_LAYER,
  colorForMaterial,
  ensureLayers,
  meshEntity,
  orientedBox,
} from './entities';
export { CATEGORY_LAYER, colorForMaterial, layerIdFor } from './entities';

interface EvaluationContext {
  readonly doc: CadDocument;
  readonly building: BuildingModel;
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

export interface WallFrame {
  readonly length: number;
  readonly angle: number;
  readonly direction: Vec2;
  readonly normal: Vec2;
}

export function wallFrame(wall: Pick<WallElement, 'start' | 'end'>): WallFrame {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dy);
  const direction: Vec2 = length === 0 ? [1, 0] : [dx / length, dy / length];
  return {
    length,
    angle: Math.atan2(dy, dx),
    direction,
    normal: [-direction[1], direction[0]],
  };
}

export function pointAlong(
  wall: Pick<WallElement, 'start'>,
  frame: WallFrame,
  s: number,
  n = 0,
): Vec2 {
  return [
    wall.start[0] + frame.direction[0] * s + frame.normal[0] * n,
    wall.start[1] + frame.direction[1] * s + frame.normal[1] * n,
  ];
}

export function openingsOf(building: BuildingModel, wallId: string): OpeningElement[] {
  return building.elementOrder
    .map((id) => building.elements[id])
    .filter(
      (element): element is OpeningElement =>
        element !== undefined &&
        (element.category === 'door' || element.category === 'window') &&
        element.hostId === wallId,
    )
    .sort((a, b) => a.offset - b.offset);
}

function wallsOnLevel(building: BuildingModel, levelId: string): WallElement[] {
  return building.elementOrder
    .map((id) => building.elements[id])
    .filter(
      (element): element is WallElement =>
        element !== undefined && element.category === 'wall' && element.levelId === levelId,
    );
}

/**
 * Plan extension (+) or retraction (−) at one wall end so joints close cleanly (square-cut butt
 * joints). With φ the angle between the two walls' away-from-joint directions:
 * - L/X joint, earlier wall: its OUTER edge reaches the other wall's outer face —
 *   (t_other/2 + (t_self/2)·cos φ) / sin φ (signed cos: ≈ (t/2)·cot(φ/2) for obtuse joints);
 * - later wall at an L/X joint, or abutting wall at a T joint: retracts to the other wall's near
 *   face without leaving a gap — −(t_other/2 − (t_self/2)·|cos φ|) / sin φ.
 */
export function endAdjustment(
  building: BuildingModel,
  wall: WallElement,
  end: 'start' | 'end',
): number {
  const point = wall[end];
  const frame = wallFrame(wall);
  const away: Vec2 = end === 'start' ? frame.direction : [-frame.direction[0], -frame.direction[1]];
  const ownIndex = building.elementOrder.indexOf(wall.id);
  for (const other of wallsOnLevel(building, wall.levelId)) {
    if (other.id === wall.id) continue;
    const otherFrame = wallFrame(other);
    const sine = Math.abs(away[0] * otherFrame.direction[1] - away[1] * otherFrame.direction[0]);
    if (sine < 0.05) continue;
    const tolerance = Math.max(Math.min(wall.thickness, other.thickness) * 0.05, 1e-9);
    const retraction =
      -(
        other.thickness / 2 -
        (wall.thickness / 2) *
          Math.abs(away[0] * otherFrame.direction[0] + away[1] * otherFrame.direction[1])
      ) / sine;
    const atOtherStart = distance(point, other.start) <= tolerance;
    if (atOtherStart || distance(point, other.end) <= tolerance) {
      if (building.elementOrder.indexOf(other.id) < ownIndex) return retraction;
      const otherAway: Vec2 = atOtherStart
        ? otherFrame.direction
        : [-otherFrame.direction[0], -otherFrame.direction[1]];
      const cosine = away[0] * otherAway[0] + away[1] * otherAway[1];
      return (other.thickness / 2 + (wall.thickness / 2) * cosine) / sine;
    }
    const projection = projectOntoSegment(point, other.start, other.end);
    if (projection.distance <= tolerance && projection.t > 0 && projection.t < 1) {
      return retraction;
    }
  }
  return 0;
}

/** Along-wall interval [start, end] actually occupied by the wall body (joints applied). */
export interface WallExtent {
  readonly start: number;
  readonly end: number;
}

export function wallExtent(building: BuildingModel, wall: WallElement): WallExtent {
  const startAdjustment = endAdjustment(building, wall, 'start');
  return {
    start: startAdjustment === 0 ? 0 : -startAdjustment,
    end: wallFrame(wall).length + endAdjustment(building, wall, 'end'),
  };
}

/** Vertical rectangular pieces [s0,s1]×[z0,z1] (wall-local) left solid after cutting the openings. */
export function wallPieces(
  wall: WallElement,
  openings: ReadonlyArray<OpeningElement>,
  extent: WallExtent,
): Array<{ s0: number; s1: number; z0: number; z1: number }> {
  const pieces: Array<{ s0: number; s1: number; z0: number; z1: number }> = [];
  let cursor = extent.start;
  for (const opening of openings) {
    const left = Math.max(opening.offset - opening.width / 2, extent.start);
    const right = Math.min(opening.offset + opening.width / 2, extent.end);
    if (left > cursor) pieces.push({ s0: cursor, s1: left, z0: 0, z1: wall.height });
    if (opening.sillHeight > 0) pieces.push({ s0: left, s1: right, z0: 0, z1: opening.sillHeight });
    const head = opening.sillHeight + opening.height;
    if (head < wall.height) pieces.push({ s0: left, s1: right, z0: head, z1: wall.height });
    cursor = Math.max(cursor, right);
  }
  if (extent.end > cursor) pieces.push({ s0: cursor, s1: extent.end, z0: 0, z1: wall.height });
  return pieces.filter((piece) => piece.s1 - piece.s0 > 1e-9 && piece.z1 - piece.z0 > 1e-9);
}

function evaluateWall(
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

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

function evaluateOpening(
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
  const hingeS =
    opening.swing === 'left'
      ? opening.offset - opening.width / 2
      : opening.offset + opening.width / 2;
  const hinge = pointAlong(wall, frame, hingeS, wall.thickness / 2);
  const planZ = level.elevation + fromMm(context.doc, 10);
  const openAngle = frame.angle + Math.PI / 2;
  const leafEnd: Vec2 = [
    hinge[0] + Math.cos(openAngle) * opening.width,
    hinge[1] + Math.sin(openAngle) * opening.width,
  ];
  const [startAngle, endAngle] =
    opening.swing === 'left' ? [frame.angle, openAngle] : [openAngle, frame.angle + Math.PI];
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

// ---------------------------------------------------------------------------
// Slabs, columns, beams, stairs
// ---------------------------------------------------------------------------

/** Watertight world-space mesh of a slab with voids: triangulated top / bottom + side walls. */
export function slabMesh(
  boundary: ReadonlyArray<Vec2>,
  openings: ReadonlyArray<ReadonlyArray<Vec2>>,
  bottom: number,
  top: number,
): MeshData | null {
  return prismMesh(boundary, openings, ([x, y], side) => [x, y, side === 1 ? top : bottom]);
}

function evaluateSlab(slab: SlabElement, level: BuildingLevel): Entity[] {
  const bottom = level.elevation + slab.offset - slab.thickness;
  const stub = { part: 'body', label: `${slab.role === 'roof' ? 'Roof' : 'Slab'} ${slab.mark}` };
  const color = colorForMaterial(slab.material, '#b4b2aa');
  const openings = slab.openings ?? [];
  const mesh =
    openings.length > 0 ? slabMesh(slab.boundary, openings, bottom, bottom + slab.thickness) : null;
  if (mesh) return [meshEntity(slab, stub, mesh, color)];
  const extrusion: ExtrusionEntity = {
    ...base(slab, stub, [0, 0, bottom], [0, 0, 0], color),
    kind: 'extrusion',
    profile: toCounterClockwise(slab.boundary),
    depth: slab.thickness,
  };
  return [extrusion];
}

function evaluateColumn(column: ColumnElement, level: BuildingLevel): Entity[] {
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

function evaluateBeam(beam: BeamElement, level: BuildingLevel): Entity[] {
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

function evaluateStair(stair: StairElement, level: BuildingLevel): Entity[] {
  const direction: Vec2 = [Math.cos(stair.angle), Math.sin(stair.angle)];
  const color = colorForMaterial(stair.material, '#b4b2aa');
  const steps: Entity[] = [];
  for (let index = 0; index < stair.riserCount; index++) {
    const along = (index + 0.5) * stair.treadDepth;
    const stepHeight = (index + 1) * stair.riserHeight;
    steps.push(
      orientedBox(
        stair,
        { part: `step-${index}`, label: `Stair ${stair.mark} step ${index + 1}` },
        [
          stair.start[0] + direction[0] * along,
          stair.start[1] + direction[1] * along,
          level.elevation + stepHeight / 2,
        ],
        stair.angle,
        [stair.treadDepth, stair.width, stepHeight],
        color,
      ),
    );
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Rooms and grids (2D annotation)
// ---------------------------------------------------------------------------

function evaluateRoom(
  context: EvaluationContext,
  room: RoomElement,
  level: BuildingLevel,
): Entity[] {
  const planZ = level.elevation + fromMm(context.doc, 5);
  const color = CATEGORY_LAYER.room.color;
  const [cx, cy] = polygonCentroid(room.boundary);
  const textHeight = fromMm(context.doc, 250);
  const areaSquareMetres =
    polygonArea(room.boundary) * toMetres(context.doc, 1) * toMetres(context.doc, 1);
  const outline: PolylineEntity = {
    ...base(
      room,
      { part: 'outline', label: `Room ${room.mark} ${room.name}` },
      [0, 0, planZ],
      [0, 0, 0],
      color,
    ),
    kind: 'polyline',
    points: room.boundary.map((point): Vec2 => [point[0], point[1]]),
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

function evaluateGrid(context: EvaluationContext, grid: GridElement): Entity[] {
  const color = CATEGORY_LAYER.grid.color;
  const bubbleRadius = fromMm(context.doc, 400);
  const frame = wallFrame(grid);
  const offsetStart: Vec2 = [
    grid.start[0] - frame.direction[0] * bubbleRadius,
    grid.start[1] - frame.direction[1] * bubbleRadius,
  ];
  const offsetEnd: Vec2 = [
    grid.end[0] + frame.direction[0] * bubbleRadius,
    grid.end[1] + frame.direction[1] * bubbleRadius,
  ];
  const axis: LineEntity = {
    ...base(grid, { part: 'axis', label: `Grid ${grid.mark}` }, [0, 0, 0], [0, 0, 0], color),
    kind: 'line',
    start: grid.start,
    end: grid.end,
  };
  const entities: Entity[] = [axis];
  for (const [part, center] of [
    ['start', offsetStart],
    ['end', offsetEnd],
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

// ---------------------------------------------------------------------------
// Whole-building regeneration
// ---------------------------------------------------------------------------

function evaluateElement(context: EvaluationContext, element: BuildingElement): Entity[] {
  const { building } = context;
  if (element.category === 'grid') return evaluateGrid(context, element);
  if (element.category === 'door' || element.category === 'window') {
    const wall = building.elements[element.hostId];
    if (!wall || wall.category !== 'wall') return [];
    const level = building.levels[wall.levelId];
    return level ? evaluateOpening(context, element, wall, level) : [];
  }
  const leveled = element as Exclude<BuildingElement, GridElement | OpeningElement>;
  const level = building.levels[leveled.levelId];
  if (!level) return [];
  switch (leveled.category) {
    case 'wall':
      return evaluateWall(context, leveled, level);
    case 'slab':
      return evaluateSlab(leveled, level);
    case 'column':
      return evaluateColumn(leveled, level);
    case 'beam':
      return evaluateBeam(leveled, level);
    case 'stair':
      return evaluateStair(leveled, level);
    case 'room':
      return evaluateRoom(context, leveled, level);
    case 'member':
      return evaluateMember(context.doc, leveled, level);
    case 'footing':
      return evaluateFooting(leveled, level);
    case 'panel':
      return evaluatePanel(leveled, level);
    case 'equipment':
      return evaluateEquipment(leveled, level);
    case 'pipe':
      return evaluatePipe(leveled, level);
    case 'tray':
      return evaluateTray(context.doc, leveled, level);
    case 'plate': {
      const member = building.elements[leveled.memberId];
      return member?.category === 'member'
        ? evaluatePlate(context.doc, leveled, member, level)
        : [];
    }
  }
}

/**
 * Replaces all previously evaluated building entities with a fresh evaluation of `building`.
 * @pure
 * @returns the new document and, per element id, the generated entity ids
 */
export function regenerateBuilding(doc: CadDocument, building: BuildingModel): CadDocument {
  const previous = doc.building;
  const staleIds = new Set<string>();
  if (previous) {
    for (const element of Object.values(previous.elements)) {
      for (const id of element.entityIds) staleIds.add(id);
    }
  }
  const entities: Record<string, Entity> = {};
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (!staleIds.has(id)) entities[id] = entity;
  }
  const order = doc.order.filter((id) => !staleIds.has(id));
  const context: EvaluationContext = { doc, building };
  const elements: BuildingModel['elements'] = {};
  const usedLayers = new Set<string>();
  for (const elementId of building.elementOrder) {
    const element = building.elements[elementId];
    if (!element) continue;
    const generated = evaluateElement(context, element);
    for (const entity of generated) {
      entities[entity.id] = entity;
      order.push(entity.id);
    }
    for (const entity of generated) usedLayers.add(entity.layerId);
    elements[elementId] = { ...element, entityIds: generated.map((entity) => entity.id) };
  }
  const { layers, layerOrder } = ensureLayers(doc.layers, doc.layerOrder, usedLayers);
  return {
    ...doc,
    entities,
    order,
    layers,
    layerOrder,
    selection: doc.selection.filter((id) => entities[id] !== undefined),
    building: { ...building, elements },
  };
}
