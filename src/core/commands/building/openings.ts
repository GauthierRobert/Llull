/**
 * Doors and windows hosted by walls.
 * @layer core/commands/building
 */

import type { CadDocument, Vec2 } from '../../model/types';
import type { OpeningElement, WallElement } from '../../model/building';
import type { CommandDefinition, CommandResult, ParamSpec } from '../types';
import { projectOntoSegment } from '../../../lib/polygon';
import {
  fromMm,
  getBuilding,
  isFiniteNumber,
  isVec2,
  nextElementId,
  nextMark,
  noChange,
  withElement,
  elementAffected,
} from './model';
import { openingsOf, regenerateBuilding, wallExtent, wallFrame } from './evaluate';
import { openingFitError } from './walls';

type OpeningKind = 'door' | 'window';

interface AddOpeningParams {
  wallId: string;
  offset?: number;
  at?: Vec2;
  width?: number;
  height?: number;
  sillHeight?: number;
  swing?: 'left' | 'right';
  material?: string;
  mark?: string;
}

const DEFAULTS_MM: Readonly<
  Record<OpeningKind, { width: number; height: number; sill: number; material: string }>
> = {
  door: { width: 900, height: 2100, sill: 0, material: 'timber' },
  window: { width: 1200, height: 1200, sill: 900, material: 'glass' },
};

function resolveOffset(
  wall: WallElement,
  offset: number | undefined,
  at: Vec2 | undefined,
): number | null {
  if (offset !== undefined) return isFiniteNumber(offset) ? offset : null;
  if (at !== undefined) {
    if (!isVec2(at)) return null;
    return projectOntoSegment(at, wall.start, wall.end).t * wallFrame(wall).length;
  }
  return wallFrame(wall).length / 2;
}

function addOpening(doc: CadDocument, kind: OpeningKind, params: AddOpeningParams): CommandResult {
  const name = `add_${kind}`;
  const building = getBuilding(doc);
  const wall = building.elements[params.wallId];
  if (!wall || wall.category !== 'wall') {
    return noChange(
      doc,
      `${name} failed: no wall '${params.wallId}'. Use describe_building to list walls.`,
    );
  }
  const defaults = DEFAULTS_MM[kind];
  const width = params.width ?? fromMm(doc, defaults.width);
  const height = params.height ?? Math.min(fromMm(doc, defaults.height), wall.height);
  const sillHeight = params.sillHeight ?? fromMm(doc, defaults.sill);
  const offset = resolveOffset(wall, params.offset, params.at);
  if (
    offset === null ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    !isFiniteNumber(sillHeight) ||
    width <= 0 ||
    height <= 0 ||
    sillHeight < 0
  ) {
    return noChange(
      doc,
      `${name} failed: width/height must be > 0, sillHeight >= 0, offset finite.`,
    );
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
    swing: params.swing === 'right' ? 'right' : 'left',
    material: params.material?.trim() || defaults.material,
  };
  const fitError = openingFitError(
    wall,
    opening,
    openingsOf(building, wall.id),
    wallExtent(building, wall),
  );
  if (fitError) return noChange(doc, `${name} failed: ${fitError}.`);
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

function openingSchema(kind: OpeningKind): Record<string, ParamSpec> {
  const defaults = DEFAULTS_MM[kind];
  const properties: Record<string, ParamSpec> = {
    wallId: { type: 'string', description: 'Host wall element id, e.g. "wall-1".' },
    offset: {
      type: 'number',
      description:
        'Distance along the wall from its start to the opening CENTER. Default: wall midpoint.',
    },
    at: {
      type: 'array',
      items: { type: 'number' },
      description: 'Alternative to offset: a plan point [x, y] projected onto the wall.',
    },
    width: { type: 'number', description: `Opening width. Default ${defaults.width} mm.` },
    height: { type: 'number', description: `Opening height. Default ${defaults.height} mm.` },
    sillHeight: {
      type: 'number',
      description: `Height of the opening bottom above the wall base. Default ${defaults.sill} mm.`,
    },
    material: { type: 'string', description: `Material. Default ${defaults.material}.` },
    mark: {
      type: 'string',
      description: `Schedule mark. Default next ${kind === 'door' ? 'D' : 'WN'}n.`,
    },
  };
  if (kind === 'door') {
    properties['swing'] = {
      type: 'string',
      enum: ['left', 'right'],
      description:
        'Hinge side looking from wall start to end. The door opens toward the wall’s left side. Default left.',
    };
  }
  return properties;
}

/**
 * @command add_door
 * @pure
 * @affects creates the door (leaf + plan swing) and re-cuts the host wall
 * @failure unknown wall / does not fit / overlaps another opening -> no-op
 */
export const addDoor: CommandDefinition<AddOpeningParams> = {
  name: 'add_door',
  description:
    'Insert a door into a wall: cuts the wall, adds the door leaf (3D) and its swing arc (plan). ' +
    'Refused if it does not fit in the wall or overlaps another opening.',
  paramsSchema: { type: 'object', properties: openingSchema('door'), required: ['wallId'] },
  run: (doc, params): CommandResult => addOpening(doc, 'door', params),
};

/**
 * @command add_window
 * @pure
 * @affects creates the window glazing and re-cuts the host wall
 * @failure unknown wall / does not fit / overlaps another opening -> no-op
 */
export const addWindow: CommandDefinition<AddOpeningParams> = {
  name: 'add_window',
  description:
    'Insert a window into a wall: cuts the wall between sill and head and adds the glazing. ' +
    'Refused if it does not fit in the wall or overlaps another opening.',
  paramsSchema: { type: 'object', properties: openingSchema('window'), required: ['wallId'] },
  run: (doc, params): CommandResult => addOpening(doc, 'window', params),
};

interface UpdateOpeningParams {
  openingId: string;
  offset?: number;
  width?: number;
  height?: number;
  sillHeight?: number;
  swing?: 'left' | 'right';
  material?: string;
  mark?: string;
}

/**
 * @command update_opening
 * @pure
 * @affects regenerates the opening and its host wall
 * @failure unknown opening / invalid values / would not fit -> no-op
 */
export const updateOpening: CommandDefinition<UpdateOpeningParams> = {
  name: 'update_opening',
  description:
    'Edit a door or window: slide it along its wall (offset), resize it, change sill height, swing, ' +
    'material or mark. The host wall is re-cut.',
  paramsSchema: {
    type: 'object',
    properties: {
      openingId: { type: 'string', description: 'Door/window element id, e.g. "door-1".' },
      offset: { type: 'number', description: 'New center distance from the wall start.' },
      width: { type: 'number', description: 'New width (> 0).' },
      height: { type: 'number', description: 'New height (> 0).' },
      sillHeight: { type: 'number', description: 'New sill height (>= 0).' },
      swing: { type: 'string', enum: ['left', 'right'], description: 'Door hinge side.' },
      material: { type: 'string', description: 'New material.' },
      mark: { type: 'string', description: 'New schedule mark.' },
    },
    required: ['openingId'],
  },
  run: (
    doc,
    { openingId, offset, width, height, sillHeight, swing, material, mark },
  ): CommandResult => {
    const building = getBuilding(doc);
    const opening = building.elements[openingId];
    if (!opening || (opening.category !== 'door' && opening.category !== 'window')) {
      return noChange(doc, `update_opening failed: no door or window '${openingId}'.`);
    }
    const wall = building.elements[opening.hostId];
    if (!wall || wall.category !== 'wall') {
      return noChange(doc, `update_opening failed: host wall '${opening.hostId}' is missing.`);
    }
    const updated: OpeningElement = {
      ...opening,
      offset: offset ?? opening.offset,
      width: width ?? opening.width,
      height: height ?? opening.height,
      sillHeight: sillHeight ?? opening.sillHeight,
      swing: swing === 'left' || swing === 'right' ? swing : opening.swing,
      material: material?.trim() || opening.material,
      mark: mark?.trim() || opening.mark,
    };
    if (
      !isFiniteNumber(updated.offset) ||
      !isFiniteNumber(updated.width) ||
      !isFiniteNumber(updated.height) ||
      !isFiniteNumber(updated.sillHeight) ||
      updated.width <= 0 ||
      updated.height <= 0 ||
      updated.sillHeight < 0
    ) {
      return noChange(doc, 'update_opening failed: width/height must be > 0, sillHeight >= 0.');
    }
    const fitError = openingFitError(
      wall,
      updated,
      openingsOf(building, wall.id),
      wallExtent(building, wall),
    );
    if (fitError) return noChange(doc, `update_opening refused: ${fitError}.`);
    const document = regenerateBuilding(doc, withElement(building, updated));
    return {
      document,
      summary: `Updated ${updated.category} ${updated.mark} (${openingId}): ${updated.width}×${updated.height} at ${updated.offset.toFixed(3)}, sill ${updated.sillHeight}.`,
      affected: elementAffected(document, [openingId, wall.id]),
    };
  },
};
