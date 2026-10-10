/**
 * Slabs, columns, beams and stairs.
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import type {
  BeamElement,
  BuildingModel,
  ColumnElement,
  SlabElement,
  StairElement,
  WallElement,
} from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { distance, isValidPolygon, offsetPolygon, polygonArea } from '@lib/polygon';
import {
  fromMm,
  getBuilding,
  isVec2List,
  nextElementId,
  nextMark,
  resolveLevel,
  toMetres,
  toMm,
  toVec2,
  withElement,
} from './model';
import { noop } from '@core/commands/noop';
import { duplicateSummary, findTwin, samePoint, sameRing, sameSegment } from './duplicates';
import { commitBuilding } from './evaluateElements';

const levelIdParam = (): z.ZodOptional<z.ZodString> =>
  z
    .string()
    .optional()
    .describe('Level id. Default: active level (a "Level 0" is created if none).');

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

/**
 * Plan outline of a room / slab from an explicit boundary or a closed wall loop.
 * @failure walls on different levels -> `failure`; invalid input -> outline null
 */
export function resolveOutline(
  building: BuildingModel,
  source: { boundary: unknown; wallIds: string[] | undefined },
  wallShift: (halfThickness: number) => number,
  dropRepeatedPoints = false,
): { outline: Vec2[] | null; wallLevelId?: string | undefined; failure?: string } {
  if (source.boundary !== undefined) {
    if (!isVec2List(source.boundary, 3)) return { outline: null };
    const points = source.boundary.map(toVec2);
    return {
      outline: dropRepeatedPoints
        ? points.filter((point, index) => {
            const previous = points[(index - 1 + points.length) % points.length] as Vec2;
            return index === 0 || point[0] !== previous[0] || point[1] !== previous[1];
          })
        : points,
    };
  }
  const walls = (source.wallIds ?? []).map((id) => building.elements[id]);
  if (
    source.wallIds === undefined ||
    !walls.every((wall): wall is WallElement => wall?.category === 'wall')
  ) {
    return { outline: null };
  }
  if (new Set(walls.map((wall) => wall.levelId)).size > 1) {
    return { outline: null, failure: 'wallIds belong to different levels' };
  }
  const loop = wallLoop(walls);
  const shift = wallShift(Math.max(...walls.map((wall) => wall.thickness)) / 2);
  const outline = loop ? (shift === 0 ? loop : offsetPolygon(loop, shift)) : null;
  return { outline, wallLevelId: walls[0]?.levelId };
}

/**
 * @command add_slab
 * @pure
 * @affects creates 1 slab (extrusion on layer S-SLAB)
 * @failure no valid boundary / walls not a closed loop / thickness <= 0 -> no-op
 */
export const addSlab = defineCommand({
  name: 'add_slab',
  description:
    'Add a floor, roof or foundation slab whose TOP sits at the level elevation + offset. Give either ' +
    'a plan boundary polygon or wallIds forming a closed loop (edge at the wall centerlines by default, see wallFace). ' +
    'Refused if a slab with the same outline, offset and role already exists on the level.',
  params: z.object({
    boundary: z
      .array(z.array(z.number()))
      .optional()
      .describe('Closed plan polygon [[x, y], …] (≥ 3 vertices).'),
    wallIds: z
      .array(z.string())
      .optional()
      .describe('Alternative to boundary: wall ids forming a closed loop.'),
    wallFace: z
      .enum(['outer', 'center', 'inner'])
      .optional()
      .describe(
        'With wallIds: slab edge at the outer wall faces, the wall centerlines (default — the slab bears into the walls), or the inner faces.',
      ),
    levelId: levelIdParam(),
    thickness: z
      .number()
      .optional()
      .describe('Slab thickness (> 0), in document units. Default 200 mm.'),
    offset: z
      .number()
      .optional()
      .describe(
        'Top-of-slab offset from the level elevation. Default 0 (roof: put it on the level above).',
      ),
    role: z
      .enum(['floor', 'roof', 'foundation'])
      .optional()
      .describe('Slab role used in schedules and IFC. Default floor.'),
    material: z.string().optional().describe('Material. Default concrete.'),
  }),
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
    const { outline, wallLevelId, failure } = resolveOutline(
      building,
      { boundary, wallIds },
      (half) => (wallFace === 'outer' ? half : wallFace === 'inner' ? -half : 0),
      true,
    );
    if (failure) return noop(doc, `add_slab failed: ${failure}.`);
    if (!outline || !isValidPolygon(outline)) {
      return noop(
        doc,
        'add_slab failed: give a boundary polygon of ≥ 3 non-collinear [x, y] points, or wallIds forming a closed loop.',
      );
    }
    const resolvedThickness = thickness ?? fromMm(doc, 200);
    if (resolvedThickness <= 0) {
      return noop(doc, 'add_slab failed: thickness must be > 0.');
    }
    const resolution = resolveLevel(doc, building, levelId ?? wallLevelId);
    if (!resolution.ok) return noop(doc, `add_slab failed: ${resolution.reason}.`);
    const slabTwin = findTwin(
      resolution.building,
      'slab',
      resolution.level.id,
      (element) =>
        element.offset === offset && element.role === role && sameRing(element.boundary, outline),
    );
    if (slabTwin)
      return noop(doc, duplicateSummary('add_slab', slabTwin, 'a slab with this outline'));
    const slab: SlabElement = {
      id: nextElementId(resolution.building, 'slab'),
      category: 'slab',
      mark: nextMark(resolution.building, 'slab'),
      entityIds: [],
      levelId: resolution.level.id,
      boundary: outline,
      thickness: resolvedThickness,
      offset,
      role,
      material: material?.trim() || 'concrete',
    };
    return commitBuilding(
      doc,
      withElement(resolution.building, slab),
      [slab.id],
      `Added ${slab.role} slab ${slab.mark} (${slab.id}) on ${resolution.level.name}: area ${(polygonArea(outline) * toMetres(doc, 1) ** 2).toFixed(2)} m², thickness ${resolvedThickness} ${doc.units}.`,
      { elementId: slab.id },
    );
  },
});

/** Plan intersections of every pair of grid axes (segment–segment). */
export function gridIntersections(building: BuildingModel): Vec2[] {
  const grids = Object.values(building.elements).filter((element) => element.category === 'grid');
  const points: Vec2[] = [];
  for (let i = 0; i < grids.length; i++) {
    for (let j = i + 1; j < grids.length; j++) {
      const a = grids[i];
      const b = grids[j];
      if (!a || !b) continue;
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
export const addColumn = defineCommand({
  name: 'add_column',
  description:
    'Add a structural column standing on a level, at a plan location or (atGridIntersections: true) ' +
    'at every structural grid intersection. Rectangular width × depth, or circular with diameter = width. ' +
    'Locations that already hold a column on the level are skipped (listed in the summary); refused when all are occupied.',
  params: z.object({
    location: vec2('Column center [x, y].').optional(),
    atGridIntersections: z
      .boolean()
      .optional()
      .describe('Place one column at every grid-axis intersection instead of at location.'),
    shape: z
      .enum(['rectangular', 'circular'])
      .optional()
      .describe('Section shape. Default rectangular.'),
    width: z
      .number()
      .optional()
      .describe('Section width (diameter if circular), in document units. Default 300 mm.'),
    depth: z
      .number()
      .optional()
      .describe('Section depth (rectangular), in document units. Default = width.'),
    height: z
      .number()
      .optional()
      .describe('Column height, in document units. Default: the level height.'),
    levelId: levelIdParam(),
    material: z.string().optional().describe('Material. Default concrete.'),
  }),
  run: (doc, params): CommandResult => {
    const building = getBuilding(doc);
    const locations = params.atGridIntersections
      ? gridIntersections(building)
      : params.location
        ? [params.location]
        : [];
    if (locations.length === 0) {
      return noop(
        doc,
        params.atGridIntersections
          ? 'add_column failed: the structural grid has no intersections (add_grid_system first).'
          : 'add_column failed: location must be [x, y] (or set atGridIntersections).',
      );
    }
    const shape = params.shape ?? 'rectangular';
    const width = params.width ?? fromMm(doc, 300);
    const depth = params.depth ?? width;
    if (width <= 0 || depth <= 0 || (params.height !== undefined && params.height <= 0)) {
      return noop(doc, 'add_column failed: width, depth and height must be > 0.');
    }
    const resolution = resolveLevel(doc, building, params.levelId);
    if (!resolution.ok) return noop(doc, `add_column failed: ${resolution.reason}.`);
    let next = resolution.building;
    const ids: string[] = [];
    const existing = Object.values(next.elements).filter(
      (element): element is ColumnElement =>
        element.category === 'column' && element.levelId === resolution.level.id,
    );
    const occupied = (location: Vec2): ColumnElement | undefined =>
      existing.find(
        (column) => column.location[0] === location[0] && column.location[1] === location[1],
      );
    const skipped = locations.flatMap((location) => {
      const twin = occupied(location);
      return twin ? [`[${location.join(', ')}] (${twin.id})`] : [];
    });
    if (skipped.length === locations.length) {
      return noop(
        doc,
        `add_column: ${skipped.length === 1 ? 'a column already stands' : 'columns already stand'} at ${skipped.join(', ')} on ${resolution.level.id}; nothing added (use update/delete_building_element to change them).`,
      );
    }
    for (const location of locations) {
      if (occupied(location)) continue;
      const column: ColumnElement = {
        id: nextElementId(next, 'column'),
        category: 'column',
        mark: nextMark(next, 'column'),
        entityIds: [],
        levelId: resolution.level.id,
        location,
        shape,
        width,
        depth,
        height: params.height ?? resolution.level.height,
        material: params.material?.trim() || 'concrete',
      };
      next = withElement(next, column);
      ids.push(column.id);
    }
    return commitBuilding(
      doc,
      next,
      ids,
      `Added ${ids.length} ${shape} column(s) ${ids.join(', ')} on ${resolution.level.name}.` +
        (skipped.length > 0
          ? ` Skipped ${skipped.length} occupied location(s): ${skipped.join(', ')}.`
          : ''),
      { elementIds: ids },
    );
  },
});

/**
 * @command add_beam
 * @pure
 * @affects creates 1 beam (box on layer S-BEAM)
 * @failure zero length / size <= 0 -> no-op
 */
export const addBeam = defineCommand({
  name: 'add_beam',
  description:
    'Add a horizontal beam from start to end (plan [x, y]). Its top sits at the top of the level ' +
    '(elevation + level height) + topOffset — i.e. under the next floor slab by default. Refused if a ' +
    'beam over the same span (either direction) at the same topOffset already exists on the level.',
  params: z.object({
    start: vec2('Beam axis start [x, y].'),
    end: vec2('Beam axis end [x, y].'),
    width: z.number().optional().describe('Section width, in document units. Default 300 mm.'),
    depth: z.number().optional().describe('Section depth, in document units. Default 500 mm.'),
    topOffset: z
      .number()
      .optional()
      .describe('Offset of the beam top from the top of the level, in document units. Default 0.'),
    levelId: levelIdParam(),
    material: z.string().optional().describe('Material. Default concrete.'),
  }),
  run: (doc, { start, end, width, depth, topOffset = 0, levelId, material }): CommandResult => {
    if (distance(start, end) <= 0) {
      return noop(doc, 'add_beam failed: start and end must be distinct [x, y] points.');
    }
    const resolvedWidth = width ?? fromMm(doc, 300);
    const resolvedDepth = depth ?? fromMm(doc, 500);
    if (resolvedWidth <= 0 || resolvedDepth <= 0) {
      return noop(doc, 'add_beam failed: width and depth must be > 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noop(doc, `add_beam failed: ${resolution.reason}.`);
    const twin = findTwin(
      resolution.building,
      'beam',
      resolution.level.id,
      (element) =>
        element.topOffset === topOffset && sameSegment(element.start, element.end, start, end),
    );
    if (twin) return noop(doc, duplicateSummary('add_beam', twin, 'a beam over this span'));
    const beam: BeamElement = {
      id: nextElementId(resolution.building, 'beam'),
      category: 'beam',
      mark: nextMark(resolution.building, 'beam'),
      entityIds: [],
      levelId: resolution.level.id,
      start,
      end,
      width: resolvedWidth,
      depth: resolvedDepth,
      topOffset,
      material: material?.trim() || 'concrete',
    };
    return commitBuilding(
      doc,
      withElement(resolution.building, beam),
      [beam.id],
      `Added beam ${beam.mark} (${beam.id}) ${resolvedWidth}×${resolvedDepth}, span ${distance(start, end).toFixed(3)} ${doc.units}.`,
      { elementId: beam.id },
    );
  },
});

const MAX_RISERS = 200;

/**
 * @command add_stair
 * @pure
 * @affects creates riserCount step solids on layer A-FLOR-STRS
 * @failure invalid start / riserCount < 2 / sizes <= 0 -> no-op
 */
export const addStair = defineCommand({
  name: 'add_stair',
  description:
    'Add a straight-run stair climbing one full level. Riser count defaults to the level height ÷ 175 mm ' +
    '(rounded up), so risers are equal; tread default 280 mm. The summary reports the Blondel rule ' +
    '(2R + G, comfortable between 600 and 650 mm). Refused above 200 risers or if a stair with the same ' +
    'start and angle already exists on the level.',
  params: z.object({
    start: vec2('Plan point [x, y] at the middle of the first riser.'),
    angle: z
      .number()
      .optional()
      .describe(
        'Run direction in radians, counter-clockwise from +X. Default 0 (climbs toward +X).',
      ),
    width: z.number().optional().describe('Stair width, in document units. Default 1000 mm.'),
    riserCount: z
      .number()
      .optional()
      .describe(
        'Number of risers (integer, 2 to 200). Default: level height ÷ 175 mm, rounded up.',
      ),
    treadDepth: z
      .number()
      .optional()
      .describe('Tread (going) depth, in document units. Default 280 mm.'),
    levelId: levelIdParam(),
    material: z.string().optional().describe('Material. Default concrete.'),
  }),
  run: (
    doc,
    { start, angle = 0, width, riserCount, treadDepth, levelId, material },
  ): CommandResult => {
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noop(doc, `add_stair failed: ${resolution.reason}.`);
    const levelHeight = resolution.level.height;
    const count = riserCount ?? Math.ceil(levelHeight / fromMm(doc, 175));
    const resolvedWidth = width ?? fromMm(doc, 1000);
    const resolvedTread = treadDepth ?? fromMm(doc, 280);
    if (!Number.isInteger(count) || count < 2 || resolvedWidth <= 0 || resolvedTread <= 0) {
      return noop(
        doc,
        'add_stair failed: riserCount must be an integer ≥ 2, width and treadDepth > 0.',
      );
    }
    if (count > MAX_RISERS) {
      return noop(
        doc,
        `add_stair failed: ${count} risers exceed the limit of ${MAX_RISERS}; the level is ${levelHeight} ${doc.units} high — pass a smaller riserCount for a partial flight or stack stairs.`,
      );
    }
    const riserHeight = levelHeight / count;
    const stairTwin = findTwin(
      resolution.building,
      'stair',
      resolution.level.id,
      (element) => element.angle === angle && samePoint(element.start, start),
    );
    if (stairTwin) {
      return noop(
        doc,
        duplicateSummary('add_stair', stairTwin, 'a stair from this start and angle'),
      );
    }
    const stair: StairElement = {
      id: nextElementId(resolution.building, 'stair'),
      category: 'stair',
      mark: nextMark(resolution.building, 'stair'),
      entityIds: [],
      levelId: resolution.level.id,
      start,
      angle,
      width: resolvedWidth,
      riserCount: count,
      riserHeight,
      treadDepth: resolvedTread,
      material: material?.trim() || 'concrete',
    };
    const blondelMm = toMm(doc, 2 * riserHeight + resolvedTread);
    return commitBuilding(
      doc,
      withElement(resolution.building, stair),
      [stair.id],
      `Added stair ${stair.mark} (${stair.id}): ${count} risers of ${Number(riserHeight.toPrecision(4))}, tread ${resolvedTread}, ` +
        `run ${(count * resolvedTread).toFixed(1)} ${doc.units}; 2R+G = ${blondelMm.toFixed(0)} mm` +
        `${blondelMm < 600 || blondelMm > 650 ? ' (outside the 600–650 mm comfort range)' : ''}.`,
      { elementId: stair.id },
    );
  },
});
