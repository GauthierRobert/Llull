/**
 * Slabs, columns, beams and stairs.
 * @layer core/commands/building
 */

import type { Vec2 } from '../../model/types';
import type {
  BeamElement,
  BuildingModel,
  ColumnElement,
  SlabElement,
  SlabRole,
  StairElement,
  WallElement,
} from '../../model/building';
import type { CommandDefinition, CommandResult } from '../types';
import { distance, isValidPolygon, offsetPolygon, polygonArea } from '../../../lib/polygon';
import {
  fromMm,
  getBuilding,
  isFiniteNumber,
  isVec2,
  isVec2List,
  lengthOf,
  nextElementId,
  nextMark,
  noChange,
  resolveLevel,
  toVec2,
  withElement,
} from './model';
import { regenerateBuilding } from './evaluate';

const LEVEL_ID_PROPERTY = {
  type: 'string',
  description: 'Level id. Default: active level (a "Level 0" is created if none).',
} as const;

function positiveOrUndefined(value: number | undefined): boolean {
  return value === undefined || (isFiniteNumber(value) && value > 0);
}

/**
 * Drops walls with a free endpoint (one touching no other wall's endpoint) until none remain —
 * removes partitions T-joined to a perimeter so the enclosing loop is left.
 */
function pruneDanglingWalls(walls: ReadonlyArray<WallElement>, tolerance: number): WallElement[] {
  let kept = [...walls];
  for (;;) {
    const joined = (point: Vec2, self: WallElement): boolean =>
      kept.some(
        (other) =>
          other !== self &&
          (distance(other.start, point) <= tolerance || distance(other.end, point) <= tolerance),
      );
    const next = kept.filter((wall) => joined(wall.start, wall) && joined(wall.end, wall));
    if (next.length === kept.length) return kept;
    kept = next;
  }
}

/**
 * Chains walls that share endpoints into a closed centerline loop (dangling partitions ignored).
 * @failure walls do not form exactly one closed loop -> null
 */
export function wallLoop(walls: ReadonlyArray<WallElement>): Vec2[] | null {
  const tolerance = Math.max((walls[0]?.thickness ?? 0) * 0.05, 1e-9);
  const pruned = pruneDanglingWalls(walls, tolerance);
  const first = pruned[0];
  if (!first || pruned.length < 3) return null;
  const remaining = pruned.slice(1);
  const loop: Vec2[] = [first.start];
  let cursor = first.end;
  while (remaining.length > 0) {
    const index = remaining.findIndex(
      (wall) =>
        distance(wall.start, cursor) <= tolerance || distance(wall.end, cursor) <= tolerance,
    );
    if (index < 0) return null;
    const wall = remaining.splice(index, 1)[0] as WallElement;
    loop.push(cursor);
    cursor = distance(wall.start, cursor) <= tolerance ? wall.end : wall.start;
  }
  return distance(cursor, first.start) <= tolerance ? loop : null;
}

interface AddSlabParams {
  boundary?: Vec2[];
  wallIds?: string[];
  wallFace?: 'outer' | 'center' | 'inner';
  levelId?: string;
  thickness?: number;
  offset?: number;
  role?: SlabRole;
  material?: string;
}

/**
 * @command add_slab
 * @pure
 * @affects creates 1 slab (extrusion on layer S-SLAB)
 * @failure no valid boundary / walls not a closed loop / thickness <= 0 -> no-op
 */
export const addSlab: CommandDefinition<AddSlabParams> = {
  name: 'add_slab',
  description:
    'Add a floor, roof or foundation slab whose TOP sits at the level elevation + offset. Give either ' +
    'a plan boundary polygon or wallIds forming a closed loop (edge at the wall centerlines by default, see wallFace).',
  paramsSchema: {
    type: 'object',
    properties: {
      boundary: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
        description: 'Closed plan polygon [[x, y], …] (≥ 3 vertices).',
      },
      wallIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Alternative to boundary: wall ids forming a closed loop.',
      },
      wallFace: {
        type: 'string',
        enum: ['outer', 'center', 'inner'],
        description:
          'With wallIds: slab edge at the outer wall faces, the wall centerlines (default — the slab bears into the walls), or the inner faces.',
      },
      levelId: LEVEL_ID_PROPERTY,
      thickness: { type: 'number', description: 'Slab thickness (> 0). Default 200 mm.' },
      offset: {
        type: 'number',
        description:
          'Top-of-slab offset from the level elevation. Default 0 (roof: put it on the level above).',
      },
      role: {
        type: 'string',
        enum: ['floor', 'roof', 'foundation'],
        description: 'Slab role used in schedules and IFC. Default floor.',
      },
      material: { type: 'string', description: 'Material. Default concrete.' },
    },
    required: [],
  },
  run: (
    doc,
    {
      boundary,
      wallIds,
      wallFace = 'center',
      levelId,
      thickness,
      offset = 0,
      role = 'floor',
      material,
    },
  ): CommandResult => {
    const building = getBuilding(doc);
    let outline: Vec2[] | null = null;
    if (boundary !== undefined) {
      outline = isVec2List(boundary, 3) ? boundary.map(toVec2) : null;
    } else if (Array.isArray(wallIds)) {
      const walls = wallIds.map((id) => building.elements[id]);
      if (walls.every((wall): wall is WallElement => wall?.category === 'wall')) {
        const loop = wallLoop(walls);
        const halfThickness = Math.max(...walls.map((wall) => wall.thickness)) / 2;
        const shift =
          wallFace === 'outer' ? halfThickness : wallFace === 'inner' ? -halfThickness : 0;
        outline = loop ? (shift === 0 ? loop : offsetPolygon(loop, shift)).map(toVec2) : null;
      }
    }
    if (!outline || !isValidPolygon(outline)) {
      return noChange(
        doc,
        'add_slab failed: give a boundary polygon of ≥ 3 non-collinear [x, y] points, or wallIds forming a closed loop.',
      );
    }
    const resolvedThickness = thickness ?? fromMm(doc, 200);
    if (!isFiniteNumber(resolvedThickness) || resolvedThickness <= 0 || !isFiniteNumber(offset)) {
      return noChange(doc, 'add_slab failed: thickness must be > 0 and offset finite.');
    }
    const resolution = resolveLevel(doc, building, levelId);
    if (!resolution.ok) return noChange(doc, `add_slab failed: ${resolution.reason}.`);
    const slab: SlabElement = {
      id: nextElementId(resolution.building, 'slab'),
      category: 'slab',
      mark: nextMark(resolution.building, 'slab'),
      entityIds: [],
      levelId: resolution.level.id,
      boundary: outline,
      thickness: resolvedThickness,
      offset,
      role: role === 'roof' || role === 'foundation' ? role : 'floor',
      material: material?.trim() || 'concrete',
    };
    const document = regenerateBuilding(doc, withElement(resolution.building, slab));
    return {
      document,
      summary: `Added ${slab.role} slab ${slab.mark} (${slab.id}) on ${resolution.level.name}: area ${polygonArea(outline).toFixed(3)} ${doc.units}², thickness ${resolvedThickness}.`,
      affected: document.building?.elements[slab.id]?.entityIds ?? [],
      data: { elementId: slab.id },
    };
  },
};

interface AddColumnParams {
  location?: Vec2;
  atGridIntersections?: boolean;
  shape?: 'rectangular' | 'circular';
  width?: number;
  depth?: number;
  height?: number;
  levelId?: string;
  material?: string;
}

/** Plan intersections of every pair of grid axes (segment–segment). */
export function gridIntersections(building: BuildingModel): Vec2[] {
  const grids = Object.values(building.elements).filter((element) => element.category === 'grid');
  const points: Vec2[] = [];
  for (let i = 0; i < grids.length; i++) {
    for (let j = i + 1; j < grids.length; j++) {
      const a = grids[i];
      const b = grids[j];
      if (!a || !b || a.category !== 'grid' || b.category !== 'grid') continue;
      const d1: Vec2 = [a.end[0] - a.start[0], a.end[1] - a.start[1]];
      const d2: Vec2 = [b.end[0] - b.start[0], b.end[1] - b.start[1]];
      const denominator = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(denominator) < 1e-12) continue;
      const t =
        ((b.start[0] - a.start[0]) * d2[1] - (b.start[1] - a.start[1]) * d2[0]) / denominator;
      const u =
        ((b.start[0] - a.start[0]) * d1[1] - (b.start[1] - a.start[1]) * d1[0]) / denominator;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      points.push([a.start[0] + t * d1[0], a.start[1] + t * d1[1]]);
    }
  }
  return points;
}

/**
 * @command add_column
 * @pure
 * @affects creates 1 column, or one per grid intersection
 * @failure no location and no grid intersections / invalid size -> no-op
 */
export const addColumn: CommandDefinition<AddColumnParams> = {
  name: 'add_column',
  description:
    'Add a structural column standing on a level, at a plan location or (atGridIntersections: true) ' +
    'at every structural grid intersection. Rectangular width × depth, or circular with diameter = width.',
  paramsSchema: {
    type: 'object',
    properties: {
      location: { type: 'array', items: { type: 'number' }, description: 'Column center [x, y].' },
      atGridIntersections: {
        type: 'boolean',
        description: 'Place one column at every grid-axis intersection instead of at location.',
      },
      shape: {
        type: 'string',
        enum: ['rectangular', 'circular'],
        description: 'Section shape. Default rectangular.',
      },
      width: {
        type: 'number',
        description: 'Section width (diameter if circular). Default 300 mm.',
      },
      depth: { type: 'number', description: 'Section depth (rectangular). Default = width.' },
      height: { type: 'number', description: 'Column height. Default: the level height.' },
      levelId: LEVEL_ID_PROPERTY,
      material: { type: 'string', description: 'Material. Default concrete.' },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const building = getBuilding(doc);
    const locations = params.atGridIntersections
      ? gridIntersections(building)
      : isVec2(params.location)
        ? [toVec2(params.location)]
        : [];
    if (locations.length === 0) {
      return noChange(
        doc,
        params.atGridIntersections
          ? 'add_column failed: the structural grid has no intersections (add_grid_system first).'
          : 'add_column failed: location must be [x, y] (or set atGridIntersections).',
      );
    }
    const width = params.width ?? fromMm(doc, 300);
    const depth = params.depth ?? width;
    if (
      !positiveOrUndefined(width) ||
      !positiveOrUndefined(depth) ||
      !positiveOrUndefined(params.height)
    ) {
      return noChange(doc, 'add_column failed: width, depth and height must be > 0.');
    }
    const resolution = resolveLevel(doc, building, params.levelId);
    if (!resolution.ok) return noChange(doc, `add_column failed: ${resolution.reason}.`);
    let next = resolution.building;
    const ids: string[] = [];
    for (const location of locations) {
      const column: ColumnElement = {
        id: nextElementId(next, 'column'),
        category: 'column',
        mark: nextMark(next, 'column'),
        entityIds: [],
        levelId: resolution.level.id,
        location,
        shape: params.shape === 'circular' ? 'circular' : 'rectangular',
        width,
        depth,
        height: params.height ?? resolution.level.height,
        material: params.material?.trim() || 'concrete',
      };
      next = withElement(next, column);
      ids.push(column.id);
    }
    const document = regenerateBuilding(doc, next);
    return {
      document,
      summary: `Added ${ids.length} ${params.shape === 'circular' ? 'circular' : 'rectangular'} column(s) ${ids.join(', ')} on ${resolution.level.name}.`,
      affected: ids.flatMap((id) => document.building?.elements[id]?.entityIds ?? []),
      data: { elementIds: ids },
    };
  },
};

interface AddBeamParams {
  start: Vec2;
  end: Vec2;
  width?: number;
  depth?: number;
  topOffset?: number;
  levelId?: string;
  material?: string;
}

/**
 * @command add_beam
 * @pure
 * @affects creates 1 beam (box on layer S-BEAM)
 * @failure zero length / size <= 0 -> no-op
 */
export const addBeam: CommandDefinition<AddBeamParams> = {
  name: 'add_beam',
  description:
    'Add a horizontal beam from start to end (plan [x, y]). Its top sits at the top of the level ' +
    '(elevation + level height) + topOffset — i.e. under the next floor slab by default.',
  paramsSchema: {
    type: 'object',
    properties: {
      start: { type: 'array', items: { type: 'number' }, description: 'Beam axis start [x, y].' },
      end: { type: 'array', items: { type: 'number' }, description: 'Beam axis end [x, y].' },
      width: { type: 'number', description: 'Section width. Default 300 mm.' },
      depth: { type: 'number', description: 'Section depth. Default 500 mm.' },
      topOffset: {
        type: 'number',
        description: 'Offset of the beam top from the top of the level. Default 0.',
      },
      levelId: LEVEL_ID_PROPERTY,
      material: { type: 'string', description: 'Material. Default concrete.' },
    },
    required: ['start', 'end'],
  },
  run: (doc, { start, end, width, depth, topOffset = 0, levelId, material }): CommandResult => {
    if (!isVec2(start) || !isVec2(end) || lengthOf(start, end) <= 0) {
      return noChange(doc, 'add_beam failed: start and end must be distinct [x, y] points.');
    }
    const resolvedWidth = width ?? fromMm(doc, 300);
    const resolvedDepth = depth ?? fromMm(doc, 500);
    if (
      !positiveOrUndefined(resolvedWidth) ||
      !positiveOrUndefined(resolvedDepth) ||
      !isFiniteNumber(topOffset)
    ) {
      return noChange(doc, 'add_beam failed: width and depth must be > 0, topOffset finite.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noChange(doc, `add_beam failed: ${resolution.reason}.`);
    const beam: BeamElement = {
      id: nextElementId(resolution.building, 'beam'),
      category: 'beam',
      mark: nextMark(resolution.building, 'beam'),
      entityIds: [],
      levelId: resolution.level.id,
      start: toVec2(start),
      end: toVec2(end),
      width: resolvedWidth,
      depth: resolvedDepth,
      topOffset,
      material: material?.trim() || 'concrete',
    };
    const document = regenerateBuilding(doc, withElement(resolution.building, beam));
    return {
      document,
      summary: `Added beam ${beam.mark} (${beam.id}) ${resolvedWidth}×${resolvedDepth}, span ${lengthOf(start, end).toFixed(3)} ${doc.units}.`,
      affected: document.building?.elements[beam.id]?.entityIds ?? [],
      data: { elementId: beam.id },
    };
  },
};

interface AddStairParams {
  start: Vec2;
  angle?: number;
  width?: number;
  riserCount?: number;
  treadDepth?: number;
  levelId?: string;
  material?: string;
}

/**
 * @command add_stair
 * @pure
 * @affects creates riserCount step solids on layer A-FLOR-STRS
 * @failure invalid start / riserCount < 2 / sizes <= 0 -> no-op
 */
export const addStair: CommandDefinition<AddStairParams> = {
  name: 'add_stair',
  description:
    'Add a straight-run stair climbing one full level. Riser count defaults to the level height ÷ 175 mm ' +
    '(rounded up), so risers are equal; tread default 280 mm. The summary reports the Blondel rule ' +
    '(2R + G, comfortable between 600 and 650 mm).',
  paramsSchema: {
    type: 'object',
    properties: {
      start: {
        type: 'array',
        items: { type: 'number' },
        description: 'Plan point [x, y] at the middle of the first riser.',
      },
      angle: {
        type: 'number',
        description:
          'Run direction in radians, counter-clockwise from +X. Default 0 (climbs toward +X).',
      },
      width: { type: 'number', description: 'Stair width. Default 1000 mm.' },
      riserCount: { type: 'number', description: 'Number of risers (integer ≥ 2).' },
      treadDepth: { type: 'number', description: 'Tread (going) depth. Default 280 mm.' },
      levelId: LEVEL_ID_PROPERTY,
      material: { type: 'string', description: 'Material. Default concrete.' },
    },
    required: ['start'],
  },
  run: (
    doc,
    { start, angle = 0, width, riserCount, treadDepth, levelId, material },
  ): CommandResult => {
    if (!isVec2(start) || !isFiniteNumber(angle)) {
      return noChange(doc, 'add_stair failed: start must be [x, y] and angle finite.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noChange(doc, `add_stair failed: ${resolution.reason}.`);
    const levelHeight = resolution.level.height;
    const count = riserCount ?? Math.ceil(levelHeight / fromMm(doc, 175));
    const resolvedWidth = width ?? fromMm(doc, 1000);
    const resolvedTread = treadDepth ?? fromMm(doc, 280);
    if (
      !Number.isInteger(count) ||
      count < 2 ||
      !positiveOrUndefined(resolvedWidth) ||
      !positiveOrUndefined(resolvedTread)
    ) {
      return noChange(
        doc,
        'add_stair failed: riserCount must be an integer ≥ 2, width and treadDepth > 0.',
      );
    }
    const riserHeight = levelHeight / count;
    const stair: StairElement = {
      id: nextElementId(resolution.building, 'stair'),
      category: 'stair',
      mark: nextMark(resolution.building, 'stair'),
      entityIds: [],
      levelId: resolution.level.id,
      start: toVec2(start),
      angle,
      width: resolvedWidth,
      riserCount: count,
      riserHeight,
      treadDepth: resolvedTread,
      material: material?.trim() || 'concrete',
    };
    const document = regenerateBuilding(doc, withElement(resolution.building, stair));
    const blondelMm = (2 * riserHeight + resolvedTread) / fromMm(doc, 1);
    return {
      document,
      summary:
        `Added stair ${stair.mark} (${stair.id}): ${count} risers of ${riserHeight.toFixed(1)}, tread ${resolvedTread}, ` +
        `run ${(count * resolvedTread).toFixed(1)} ${doc.units}; 2R+G = ${blondelMm.toFixed(0)} mm` +
        `${blondelMm < 600 || blondelMm > 650 ? ' (outside the 600–650 mm comfort range)' : ''}.`,
      affected: document.building?.elements[stair.id]?.entityIds ?? [],
      data: { elementId: stair.id },
    };
  },
};
