/**
 * Doors and windows hosted by walls.
 * @layer domain-aec
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type {
  BuildingModel,
  CurvedWallElement,
  OpeningElement,
  WallElement,
} from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { projectOntoSegment } from '@lib/polygon';
import {
  fromMm,
  getBuilding,
  nextElementId,
  nextMark,
  withElement,
  elementAffected,
} from './model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from './evaluateElements';
import { openingsOf, wallExtent, wallFrame, type WallExtent } from './wallGeometry';
import { arcOffsetOf, curvedWallExtent, curvedWallLength } from './curvedWallGeometry';
import { openingFitError } from './walls';

type OpeningKind = 'door' | 'window';

const DEFAULTS_MM: Readonly<
  Record<OpeningKind, { width: number; height: number; sill: number; material: string }>
> = {
  door: { width: 900, height: 2100, sill: 0, material: 'timber' },
  window: { width: 1200, height: 1200, sill: 900, material: 'glass' },
};

function resolveOffset(
  wall: WallElement | CurvedWallElement,
  offset: number | undefined,
  at: Vec2 | undefined,
): number {
  if (offset !== undefined) return offset;
  if (wall.category === 'curvedWall') {
    return at ? arcOffsetOf(wall, at) : curvedWallLength(wall) / 2;
  }
  const { length } = wallFrame(wall);
  return at ? projectOntoSegment(at, wall.start, wall.end).t * length : length / 2;
}

/** Built extent of a host wall along its axis (curved walls: the whole arc length). */
function hostExtent(building: BuildingModel, host: WallElement | CurvedWallElement): WallExtent {
  return host.category === 'wall' ? wallExtent(building, host) : curvedWallExtent(building, host);
}

function addOpening(doc: CadDocument, kind: OpeningKind, params: AddOpeningParams): CommandResult {
  const name = `add_${kind}`;
  const building = getBuilding(doc);
  const wall = building.elements[params.wallId];
  if (!wall || (wall.category !== 'wall' && wall.category !== 'curvedWall')) {
    return noop(
      doc,
      `${name} failed: no wall '${params.wallId}'. Use describe_building to list walls.`,
    );
  }
  const defaults = DEFAULTS_MM[kind];
  const width = params.width ?? fromMm(doc, defaults.width);
  const height = params.height ?? Math.min(fromMm(doc, defaults.height), wall.height);
  const sillHeight = params.sillHeight ?? fromMm(doc, defaults.sill);
  const offset = resolveOffset(wall, params.offset, params.at);
  if (width <= 0 || height <= 0 || sillHeight < 0) {
    return noop(doc, `${name} failed: width/height must be > 0, sillHeight >= 0.`);
  }
  const opening: OpeningElement = {
    id: nextElementId(building, kind),
    category: kind,
    mark: params.mark?.trim() || nextMark(building, kind),
    entityIds: [],
    hostId: wall.id,
    offset,
    width,
    height,
    sillHeight,
    swing: params.swing ?? 'left',
    material: params.material?.trim() || defaults.material,
  };
  const fitError = openingFitError(
    wall,
    opening,
    openingsOf(building, wall.id),
    hostExtent(building, wall),
  );
  if (fitError) return noop(doc, `${name} failed: ${fitError}.`);
  const document = regenerateBuilding(doc, withElement(building, opening));
  return {
    document,
    summary:
      `Added ${kind} ${opening.mark} (${opening.id}) ${width}×${height} in wall ${wall.mark} at ` +
      `${offset.toFixed(3)} from its start, sill ${sillHeight}.`,
    affected: elementAffected(document, [opening.id, wall.id]),
    data: { elementId: opening.id },
  };
}

interface OpeningShape {
  wallId: z.ZodString;
  offset: z.ZodOptional<z.ZodNumber>;
  at: z.ZodOptional<ReturnType<typeof vec2>>;
  width: z.ZodOptional<z.ZodNumber>;
  height: z.ZodOptional<z.ZodNumber>;
  sillHeight: z.ZodOptional<z.ZodNumber>;
  material: z.ZodOptional<z.ZodString>;
  mark: z.ZodOptional<z.ZodString>;
}

function openingShape(kind: OpeningKind): OpeningShape {
  const defaults = DEFAULTS_MM[kind];
  return {
    wallId: z
      .string()
      .describe('Host wall element id: a straight ("wall-1") or curved ("curvedWall-1") wall.'),
    offset: z
      .number()
      .optional()
      .describe(
        'Distance along the wall from its start to the opening CENTER. Default: wall midpoint.',
      ),
    at: vec2('Alternative to offset: a plan point [x, y] projected onto the wall.').optional(),
    width: z.number().optional().describe(`Opening width. Default ${defaults.width} mm.`),
    height: z.number().optional().describe(`Opening height. Default ${defaults.height} mm.`),
    sillHeight: z
      .number()
      .optional()
      .describe(`Height of the opening bottom above the wall base. Default ${defaults.sill} mm.`),
    material: z.string().optional().describe(`Material. Default ${defaults.material}.`),
    mark: z
      .string()
      .optional()
      .describe(`Schedule mark. Default next ${kind === 'door' ? 'D' : 'WN'}n.`),
  };
}

const doorParams = z.object({
  ...openingShape('door'),
  swing: z
    .enum(['left', 'right'])
    .optional()
    .describe(
      'Hinge side looking from wall start to end. The door opens toward the wall’s left side. Default left.',
    ),
});

const windowParams = z.object(openingShape('window'));

type AddOpeningParams = z.output<typeof doorParams>;

/**
 * @command add_door
 * @pure
 * @affects creates the door (leaf + plan swing) and re-cuts the host wall
 * @failure unknown wall / does not fit / overlaps another opening -> no-op
 */
export const addDoor = defineCommand({
  name: 'add_door',
  description:
    'Insert a door into a wall: cuts the wall, adds the door leaf (3D) and its swing arc (plan). ' +
    'Refused if it does not fit in the wall or overlaps another opening.',
  params: doorParams,
  run: (doc, params): CommandResult => addOpening(doc, 'door', params),
});

/**
 * @command add_window
 * @pure
 * @affects creates the window glazing and re-cuts the host wall
 * @failure unknown wall / does not fit / overlaps another opening -> no-op
 */
export const addWindow = defineCommand({
  name: 'add_window',
  description:
    'Insert a window into a wall: cuts the wall between sill and head and adds the glazing. ' +
    'Refused if it does not fit in the wall or overlaps another opening.',
  params: windowParams,
  run: (doc, params): CommandResult => addOpening(doc, 'window', params),
});

/**
 * @command update_opening
 * @pure
 * @affects regenerates the opening and its host wall
 * @failure unknown opening / invalid values / would not fit -> no-op
 */
export const updateOpening = defineCommand({
  name: 'update_opening',
  description:
    'Edit a door or window: slide it along its wall (offset), resize it, change sill height, swing, ' +
    'material or mark. The host wall is re-cut.',
  params: z.object({
    openingId: z.string().describe('Door/window element id, e.g. "door-1".'),
    offset: z.number().optional().describe('New center distance from the wall start.'),
    width: z.number().optional().describe('New width (> 0).'),
    height: z.number().optional().describe('New height (> 0).'),
    sillHeight: z.number().optional().describe('New sill height (>= 0).'),
    swing: z.enum(['left', 'right']).optional().describe('Door hinge side.'),
    material: z.string().optional().describe('New material.'),
    mark: z.string().optional().describe('New schedule mark.'),
  }),
  run: (
    doc,
    { openingId, offset, width, height, sillHeight, swing, material, mark },
  ): CommandResult => {
    const building = getBuilding(doc);
    const opening = building.elements[openingId];
    if (!opening || (opening.category !== 'door' && opening.category !== 'window')) {
      return noop(doc, `update_opening failed: no door or window '${openingId}'.`);
    }
    const wall = building.elements[opening.hostId];
    if (!wall || (wall.category !== 'wall' && wall.category !== 'curvedWall')) {
      return noop(doc, `update_opening failed: host wall '${opening.hostId}' is missing.`);
    }
    const updated: OpeningElement = {
      ...opening,
      offset: offset ?? opening.offset,
      width: width ?? opening.width,
      height: height ?? opening.height,
      sillHeight: sillHeight ?? opening.sillHeight,
      swing: swing ?? opening.swing,
      material: material?.trim() || opening.material,
      mark: mark?.trim() || opening.mark,
    };
    if (updated.width <= 0 || updated.height <= 0 || updated.sillHeight < 0) {
      return noop(doc, 'update_opening failed: width/height must be > 0, sillHeight >= 0.');
    }
    const fitError = openingFitError(
      wall,
      updated,
      openingsOf(building, wall.id),
      hostExtent(building, wall),
    );
    if (fitError) return noop(doc, `update_opening refused: ${fitError}.`);
    const document = regenerateBuilding(doc, withElement(building, updated));
    return {
      document,
      summary: `Updated ${updated.category} ${updated.mark} (${openingId}): ${updated.width}×${updated.height} at ${updated.offset.toFixed(3)}, sill ${updated.sillHeight}.`,
      affected: elementAffected(document, [openingId, wall.id]),
    };
  },
});
