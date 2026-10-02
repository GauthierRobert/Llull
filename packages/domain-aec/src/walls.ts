/**
 * Walls: straight, parametric, joined at corners, hosting doors and windows.
 * @layer domain-aec
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type { BuildingModel, OpeningElement, WallElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
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
  elementAffected,
} from './model';
import { openingsOf, regenerateBuilding, wallExtent, wallFrame, type WallExtent } from './evaluate';
import { curvedWallExtent } from './curvedWallGeometry';

/**
 * Why `opening` does not fit in `wall` (alongside `others`), or null when it fits.
 * @invariant opening lies within [0, length] along the wall, below the wall top, overlapping no other opening
 */
export function openingFitError(
  wall: Pick<WallElement, 'start' | 'end' | 'height' | 'mark'>,
  opening: Pick<OpeningElement, 'id' | 'offset' | 'width' | 'height' | 'sillHeight' | 'mark'>,
  others: ReadonlyArray<OpeningElement>,
  extent: WallExtent = { start: 0, end: wallFrame(wall).length },
): string | null {
  const left = opening.offset - opening.width / 2;
  const right = opening.offset + opening.width / 2;
  const tolerance = 1e-9;
  if (left < extent.start - tolerance || right > extent.end + tolerance) {
    return `${opening.mark} spans ${left.toFixed(3)}…${right.toFixed(3)} but wall ${wall.mark} is built from ${extent.start.toFixed(3)} to ${extent.end.toFixed(3)} along its axis`;
  }
  if (opening.sillHeight + opening.height > wall.height + tolerance) {
    return `${opening.mark} top (${opening.sillHeight + opening.height}) exceeds wall ${wall.mark} height ${wall.height}`;
  }
  for (const other of others) {
    if (other.id === opening.id) continue;
    const otherLeft = other.offset - other.width / 2;
    const otherRight = other.offset + other.width / 2;
    if (left < otherRight - tolerance && otherLeft < right - tolerance) {
      return `${opening.mark} overlaps ${other.mark} in wall ${wall.mark}`;
    }
  }
  return null;
}

const WALL_OPTION_SHAPE = {
  thickness: z
    .number()
    .optional()
    .describe('Wall thickness (document units, > 0). Default 200 mm.'),
  height: z
    .number()
    .optional()
    .describe('Wall height above its base (document units, > 0). Default: the level height.'),
  levelId: z
    .string()
    .optional()
    .describe(
      'Level to place the wall on. Default: active level (a "Level 0" is created if none).',
    ),
  baseOffset: z.number().optional().describe('Base offset above the level elevation. Default 0.'),
  material: z
    .string()
    .optional()
    .describe(
      'Material name used by quantities/cost: concrete (default), masonry, brick, block, timber, steel, gypsum…',
    ),
};

type WallOptions = z.output<z.ZodObject<typeof WALL_OPTION_SHAPE>>;

type WallBuild =
  | { readonly ok: true; readonly building: BuildingModel; readonly wallIds: string[] }
  | { readonly ok: false; readonly reason: string };

function buildWalls(
  doc: CadDocument,
  segments: ReadonlyArray<readonly [Vec2, Vec2]>,
  options: WallOptions,
): WallBuild {
  const thickness = options.thickness ?? fromMm(doc, 200);
  const baseOffset = options.baseOffset ?? 0;
  if (!isFiniteNumber(thickness) || thickness <= 0) {
    return { ok: false, reason: `thickness must be > 0 (got ${String(options.thickness)})` };
  }
  if (!isFiniteNumber(baseOffset)) return { ok: false, reason: 'baseOffset must be finite' };
  const resolution = resolveLevel(doc, getBuilding(doc), options.levelId);
  if (!resolution.ok) return { ok: false, reason: resolution.reason };
  const height = options.height ?? resolution.level.height;
  if (!isFiniteNumber(height) || height <= 0) {
    return { ok: false, reason: `height must be > 0 (got ${String(options.height)})` };
  }
  let building = resolution.building;
  const wallIds: string[] = [];
  for (const [start, end] of segments) {
    if (lengthOf(start, end) <= 0) {
      return {
        ok: false,
        reason: `segment [${start.join(', ')}]→[${end.join(', ')}] has zero length`,
      };
    }
    const wall: WallElement = {
      id: nextElementId(building, 'wall'),
      category: 'wall',
      mark: nextMark(building, 'wall'),
      entityIds: [],
      levelId: resolution.level.id,
      start: toVec2(start),
      end: toVec2(end),
      thickness,
      height,
      baseOffset,
      material: options.material?.trim() || 'concrete',
    };
    building = withElement(building, wall);
    wallIds.push(wall.id);
  }
  return { ok: true, building, wallIds };
}

function wallResult(doc: CadDocument, build: Extract<WallBuild, { ok: true }>): CommandResult {
  const document = regenerateBuilding(doc, build.building);
  const walls = build.wallIds
    .map((id) => document.building?.elements[id])
    .filter((element): element is WallElement => element?.category === 'wall');
  const totalLength = walls.reduce((sum, wall) => sum + lengthOf(wall.start, wall.end), 0);
  const first = walls[0];
  const level = first ? document.building?.levels[first.levelId] : undefined;
  return {
    document,
    summary:
      `Added ${walls.length} wall(s) ${walls.map((wall) => `${wall.mark} (${wall.id})`).join(', ')} ` +
      `on ${level?.name ?? 'level'}: total length ${totalLength.toFixed(3)} ${doc.units}, ` +
      `thickness ${first?.thickness ?? 0}, height ${first?.height ?? 0}, ${first?.material ?? ''}.`,
    affected: elementAffected(document, build.wallIds),
    data: { wallIds: build.wallIds },
  };
}

/**
 * @command add_wall
 * @pure
 * @affects creates 1 wall element (evaluated into box pieces on layer A-WALL)
 * @failure zero length / thickness <= 0 / unknown level -> no-op
 */
export const addWall = defineCommand({
  name: 'add_wall',
  description:
    'Add a straight wall along its plan centerline from start to end ([x, y], document units) on a ' +
    'building level. Walls meeting at endpoints (L/T/X corners) are joined automatically. Doors and ' +
    'windows are then hosted with add_door / add_window.',
  params: z.object({
    start: vec2('Centerline start [x, y].'),
    end: vec2('Centerline end [x, y].'),
    ...WALL_OPTION_SHAPE,
  }),
  run: (doc, { start, end, ...options }): CommandResult => {
    if (!isVec2(start) || !isVec2(end)) {
      return noChange(doc, 'add_wall failed: start and end must be [x, y] points.');
    }
    const build = buildWalls(doc, [[start, end]], options);
    return build.ok ? wallResult(doc, build) : noChange(doc, `add_wall failed: ${build.reason}.`);
  },
});

/**
 * @command draw_walls
 * @pure
 * @affects creates (points.length - 1) walls, +1 when closed
 * @failure < 2 points / zero-length segment -> no-op
 */
export const drawWalls = defineCommand({
  name: 'draw_walls',
  description:
    'Draw a chain of joined walls through plan points ([[x, y], …]); closed: true adds the closing ' +
    'wall (e.g. a building perimeter). Same options as add_wall.',
  params: z.object({
    points: z.array(z.array(z.number())).describe('Centerline vertices [[x, y], …], at least 2.'),
    closed: z
      .boolean()
      .optional()
      .describe('Close the loop back to the first point. Default false.'),
    ...WALL_OPTION_SHAPE,
  }),
  run: (doc, { points, closed = false, ...options }): CommandResult => {
    if (!isVec2List(points, 2) || (closed && points.length < 3)) {
      return noChange(
        doc,
        'draw_walls failed: points must be a list of [x, y] (at least 2, or 3 when closed).',
      );
    }
    const segments: Array<readonly [Vec2, Vec2]> = [];
    for (let index = 0; index < points.length - 1; index++) {
      segments.push([points[index] as Vec2, points[index + 1] as Vec2]);
    }
    if (closed) segments.push([points[points.length - 1] as Vec2, points[0] as Vec2]);
    const build = buildWalls(doc, segments, options);
    return build.ok ? wallResult(doc, build) : noChange(doc, `draw_walls failed: ${build.reason}.`);
  },
});

/**
 * @command update_wall
 * @pure
 * @affects regenerates the wall, its openings and the walls joined to it
 * @failure unknown wall / invalid values / hosted opening would no longer fit -> no-op
 */
export const updateWall = defineCommand({
  name: 'update_wall',
  description:
    'Edit a wall parametrically: move its endpoints, change thickness, height, base offset, material ' +
    'or level. Hosted doors/windows stay attached (refused if one would no longer fit).',
  params: z.object({
    wallId: z.string().describe('Wall element id, e.g. "wall-2".'),
    start: vec2('New centerline start [x, y].').optional(),
    end: vec2('New centerline end [x, y].').optional(),
    thickness: z.number().optional().describe('New thickness (> 0).'),
    height: z.number().optional().describe('New height (> 0).'),
    baseOffset: z.number().optional().describe('New base offset above the level.'),
    material: z.string().optional().describe('New material name.'),
    levelId: z.string().optional().describe('Move the wall to another level.'),
  }),
  run: (
    doc,
    { wallId, start, end, thickness, height, baseOffset, material, levelId },
  ): CommandResult => {
    const building = getBuilding(doc);
    const wall = building.elements[wallId];
    if (!wall || wall.category !== 'wall') {
      return noChange(doc, `update_wall failed: no wall '${wallId}'.`);
    }
    if ((start !== undefined && !isVec2(start)) || (end !== undefined && !isVec2(end))) {
      return noChange(doc, 'update_wall failed: start/end must be [x, y].');
    }
    const positive = (value: number | undefined): boolean =>
      value === undefined || (isFiniteNumber(value) && value > 0);
    if (
      !positive(thickness) ||
      !positive(height) ||
      (baseOffset !== undefined && !isFiniteNumber(baseOffset))
    ) {
      return noChange(
        doc,
        'update_wall failed: thickness/height must be > 0 and baseOffset finite.',
      );
    }
    if (levelId !== undefined && !building.levels[levelId]) {
      return noChange(doc, `update_wall failed: no level '${levelId}'.`);
    }
    // A new overall thickness or material no longer matches a build-up: the wall becomes
    // single-layer.
    const { layers, ...single } = wall;
    const newMaterial = material?.trim();
    const keepLayers =
      (thickness === undefined || thickness === wall.thickness) &&
      (!newMaterial || newMaterial === wall.material);
    const updated: WallElement = {
      ...single,
      ...(keepLayers && layers ? { layers } : {}),
      start: start ? toVec2(start) : wall.start,
      end: end ? toVec2(end) : wall.end,
      thickness: thickness ?? wall.thickness,
      height: height ?? wall.height,
      baseOffset: baseOffset ?? wall.baseOffset,
      material: material?.trim() || wall.material,
      levelId: levelId ?? wall.levelId,
    };
    if (lengthOf(updated.start, updated.end) <= 0) {
      return noChange(doc, 'update_wall failed: start and end would coincide.');
    }
    const next = withElement(building, updated);
    const issues = openingFitIssues(next, new Set([wall.levelId, updated.levelId]));
    if (issues.length > 0) return noChange(doc, `update_wall refused: ${issues[0]}.`);
    const document = regenerateBuilding(doc, next);
    return {
      document,
      summary:
        `Updated wall ${updated.mark} (${wallId}): [${updated.start.join(', ')}]→[${updated.end.join(', ')}], ` +
        `thickness ${updated.thickness}, height ${updated.height}, ${updated.material}` +
        `${!keepLayers && layers ? ' (build-up removed)' : ''}.`,
      affected: elementAffected(document, [wallId]),
    };
  },
});

/**
 * Every hosted opening on `levelIds` that no longer fits its wall's built extent / height.
 * @pure
 */
export function openingFitIssues(building: BuildingModel, levelIds: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  for (const element of Object.values(building.elements)) {
    if (element.category !== 'wall' && element.category !== 'curvedWall') continue;
    if (!levelIds.has(element.levelId)) continue;
    const openings = openingsOf(building, element.id);
    const extent =
      element.category === 'wall'
        ? wallExtent(building, element)
        : curvedWallExtent(building, element);
    for (const opening of openings) {
      const error = openingFitError(element, opening, openings, extent);
      if (error) issues.push(error);
    }
  }
  return issues;
}
