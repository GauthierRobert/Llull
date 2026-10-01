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
  Layer,
  LineEntity,
  MeshData,
  MeshSolidEntity,
  PolylineEntity,
  TextEntity,
  Vec2,
  Vec3,
} from '../../model/types';
import type {
  BeamElement,
  BimCategory,
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
import { triangulatePolygon } from '../../../lib/triangulate';

/** AIA / US National CAD Standard layer per category. */
export const CATEGORY_LAYER: Readonly<Record<BimCategory, { name: string; color: string }>> = {
  grid: { name: 'S-GRID', color: '#d04a4a' },
  wall: { name: 'A-WALL', color: '#8a8a8a' },
  door: { name: 'A-DOOR', color: '#8b5a2b' },
  window: { name: 'A-GLAZ', color: '#4a90c2' },
  slab: { name: 'S-SLAB', color: '#9a9a90' },
  column: { name: 'S-COLS', color: '#6d6d6d' },
  beam: { name: 'S-BEAM', color: '#7d8a96' },
  stair: { name: 'A-FLOR-STRS', color: '#a08060' },
  room: { name: 'A-AREA', color: '#3c8d5a' },
};

export function layerIdFor(category: BimCategory): string {
  return `layer-${CATEGORY_LAYER[category].name}`;
}

const MATERIAL_COLOR: Readonly<Record<string, string>> = {
  concrete: '#b4b2aa',
  masonry: '#b0623a',
  brick: '#b0623a',
  block: '#a7a39a',
  timber: '#c19a6b',
  wood: '#c19a6b',
  steel: '#7d8a96',
  glass: '#8ec9e8',
  gypsum: '#e6e2d8',
  drywall: '#e6e2d8',
  stone: '#9c968a',
};

export function colorForMaterial(material: string, fallback: string): string {
  return MATERIAL_COLOR[material.toLowerCase()] ?? fallback;
}

interface EvaluationContext {
  readonly doc: CadDocument;
  readonly building: BuildingModel;
}

interface EntityStub {
  readonly part: string;
  readonly label: string;
}

function base(
  element: BuildingElement,
  stub: EntityStub,
  position: Vec3,
  rotation: Vec3,
  color: string,
): {
  id: string;
  position: Vec3;
  rotation: Vec3;
  layerId: string;
  color: string;
  name: string;
  tags: string[];
} {
  return {
    id: `${element.id}:${stub.part}`,
    position,
    rotation,
    layerId: layerIdFor(element.category),
    color,
    name: `${stub.label}`,
    tags: ['bim', element.category, `element:${element.id}`],
  };
}

function orientedBox(
  element: BuildingElement,
  stub: EntityStub,
  center: Vec3,
  angle: number,
  size: Vec3,
  color: string,
): BoxEntity {
  return { ...base(element, stub, center, [0, 0, angle], color), kind: 'box', size };
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
 * Plan extension (+) or retraction (−) at one wall end so corners close cleanly:
 * at an L/X joint the earlier wall extends by half the other's thickness and the later wall
 * retracts by half the earlier one's; at a T joint the abutting wall retracts.
 */
export function endAdjustment(
  building: BuildingModel,
  wall: WallElement,
  end: 'start' | 'end',
): number {
  const point = wall[end];
  const frame = wallFrame(wall);
  const ownIndex = building.elementOrder.indexOf(wall.id);
  for (const other of wallsOnLevel(building, wall.levelId)) {
    if (other.id === wall.id) continue;
    const otherFrame = wallFrame(other);
    const cross =
      frame.direction[0] * otherFrame.direction[1] - frame.direction[1] * otherFrame.direction[0];
    if (Math.abs(cross) < 0.05) continue;
    const tolerance = Math.max(Math.min(wall.thickness, other.thickness) * 0.05, 1e-9);
    const atOtherEnd =
      distance(point, other.start) <= tolerance || distance(point, other.end) <= tolerance;
    if (atOtherEnd) {
      const otherIndex = building.elementOrder.indexOf(other.id);
      return ownIndex < otherIndex ? other.thickness / 2 : -other.thickness / 2;
    }
    const projection = projectOntoSegment(point, other.start, other.end);
    if (projection.distance <= tolerance && projection.t > 0 && projection.t < 1) {
      return -other.thickness / 2;
    }
  }
  return 0;
}

/** Vertical rectangular pieces [s0,s1]×[z0,z1] (wall-local) left solid after cutting the openings. */
export function wallPieces(
  wall: WallElement,
  openings: ReadonlyArray<OpeningElement>,
  startAdjustment: number,
  endAdjustmentValue: number,
): Array<{ s0: number; s1: number; z0: number; z1: number }> {
  const length = wallFrame(wall).length;
  const pieces: Array<{ s0: number; s1: number; z0: number; z1: number }> = [];
  let cursor = startAdjustment === 0 ? 0 : -startAdjustment;
  const finish = length + endAdjustmentValue;
  for (const opening of openings) {
    const left = opening.offset - opening.width / 2;
    const right = opening.offset + opening.width / 2;
    if (left > cursor) pieces.push({ s0: cursor, s1: left, z0: 0, z1: wall.height });
    if (opening.sillHeight > 0) pieces.push({ s0: left, s1: right, z0: 0, z1: opening.sillHeight });
    const head = opening.sillHeight + opening.height;
    if (head < wall.height) pieces.push({ s0: left, s1: right, z0: head, z1: wall.height });
    cursor = Math.max(cursor, right);
  }
  if (finish > cursor) pieces.push({ s0: cursor, s1: finish, z0: 0, z1: wall.height });
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
    endAdjustment(context.building, wall, 'start'),
    endAdjustment(context.building, wall, 'end'),
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
): MeshData {
  const { vertices, triangles } = triangulatePolygon(boundary, openings);
  const count = vertices.length;
  const positions: number[] = [];
  for (const z of [top, bottom]) for (const [x, y] of vertices) positions.push(x, y, z);
  const indices: number[] = [];
  for (const [a, b, c] of triangles) indices.push(a, b, c, c + count, b + count, a + count);
  let ringStart = 0;
  for (const ringLength of [boundary.length, ...openings.map((opening) => opening.length)]) {
    for (let index = 0; index < ringLength; index++) {
      const current = ringStart + index;
      const next = ringStart + ((index + 1) % ringLength);
      indices.push(current + count, next + count, next, current + count, next, current);
    }
    ringStart += ringLength;
  }
  return { positions, indices };
}

function evaluateSlab(slab: SlabElement, level: BuildingLevel): Entity[] {
  const bottom = level.elevation + slab.offset - slab.thickness;
  const stub = { part: 'body', label: `${slab.role === 'roof' ? 'Roof' : 'Slab'} ${slab.mark}` };
  const color = colorForMaterial(slab.material, '#b4b2aa');
  const openings = slab.openings ?? [];
  if (openings.length > 0) {
    const mesh: MeshSolidEntity = {
      ...base(slab, stub, [0, 0, 0], [0, 0, 0], color),
      kind: 'mesh',
      mesh: slabMesh(slab.boundary, openings, bottom, bottom + slab.thickness),
    };
    return [mesh];
  }
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
  }
}

function ensureLayers(
  layers: Record<string, Layer>,
  layerOrder: string[],
  categories: ReadonlySet<BimCategory>,
): { layers: Record<string, Layer>; layerOrder: string[] } {
  let nextLayers = layers;
  let nextOrder = layerOrder;
  for (const category of categories) {
    const id = layerIdFor(category);
    if (nextLayers[id]) continue;
    const { name, color } = CATEGORY_LAYER[category];
    nextLayers = { ...nextLayers, [id]: { id, name, visible: true, locked: false, color } };
    nextOrder = [...nextOrder, id];
  }
  return { layers: nextLayers, layerOrder: nextOrder };
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
  const usedCategories = new Set<BimCategory>();
  for (const elementId of building.elementOrder) {
    const element = building.elements[elementId];
    if (!element) continue;
    const generated = evaluateElement(context, element);
    for (const entity of generated) {
      entities[entity.id] = entity;
      order.push(entity.id);
    }
    if (generated.length > 0) usedCategories.add(element.category);
    elements[elementId] = { ...element, entityIds: generated.map((entity) => entity.id) };
  }
  const { layers, layerOrder } = ensureLayers(doc.layers, doc.layerOrder, usedCategories);
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
