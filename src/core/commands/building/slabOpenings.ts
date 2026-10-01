/**
 * Voids through slabs: stair wells, shafts, risers.
 * @layer core/commands/building
 */

import type { Vec2 } from '../../model/types';
import type { BuildingModel, SlabElement, StairElement } from '../../model/building';
import type { CommandDefinition, CommandResult } from '../types';
import {
  isValidPolygon,
  pointInPolygon,
  polygonArea,
  segmentsIntersect,
} from '../../../lib/polygon';
import {
  fromMm,
  getBuilding,
  isFiniteNumber,
  isVec2List,
  noChange,
  toMetres,
  toVec2,
  withElement,
  elementAffected,
} from './model';
import { regenerateBuilding } from './evaluate';
import { triangulatePolygon } from '../../../lib/triangulate';

/** Plan footprint of a stair run, grown by `margin` on every side. */
export function stairFootprint(stair: StairElement, margin: number): Vec2[] {
  const direction: Vec2 = [Math.cos(stair.angle), Math.sin(stair.angle)];
  const normal: Vec2 = [-direction[1], direction[0]];
  const half = stair.width / 2 + margin;
  const run = stair.riserCount * stair.treadDepth;
  const at = (along: number, across: number): Vec2 => [
    stair.start[0] + direction[0] * along + normal[0] * across,
    stair.start[1] + direction[1] * along + normal[1] * across,
  ];
  return [at(-margin, -half), at(run + margin, -half), at(run + margin, half), at(-margin, half)];
}

function edges(polygon: ReadonlyArray<Vec2>): Array<[Vec2, Vec2]> {
  return polygon.map((point, index): [Vec2, Vec2] => [
    point,
    polygon[(index + 1) % polygon.length] as Vec2,
  ]);
}

function polygonsTouch(a: ReadonlyArray<Vec2>, b: ReadonlyArray<Vec2>): boolean {
  if (a.some((point) => pointInPolygon(point, b)) || b.some((point) => pointInPolygon(point, a)))
    return true;
  return edges(a).some(([p, q]) => edges(b).some(([r, s]) => segmentsIntersect(p, q, r, s)));
}

/**
 * Why `opening` cannot be cut in `slab`, or null.
 * @invariant strictly inside the boundary, not touching another opening
 */
export function slabOpeningError(slab: SlabElement, opening: ReadonlyArray<Vec2>): string | null {
  if (!isValidPolygon(opening)) return 'the opening needs ≥ 3 non-collinear points';
  const inside =
    opening.every((point) => pointInPolygon(point, slab.boundary)) &&
    !edges(opening).some(([p, q]) =>
      edges(slab.boundary).some(([r, s]) => segmentsIntersect(p, q, r, s)),
    );
  if (!inside) return `the opening is not strictly inside slab ${slab.mark}`;
  const clash = (slab.openings ?? []).findIndex((existing) => polygonsTouch(existing, opening));
  if (clash >= 0) return `the opening overlaps opening #${clash} of slab ${slab.mark}`;
  return triangulatePolygon(slab.boundary, [...(slab.openings ?? []), opening]).complete
    ? null
    : `the slab outline with this opening cannot be meshed (simplify the opening shape)`;
}

/** A slab on a level whose elevation is the top of the stair, containing the stair footprint. */
function slabAboveStair(
  building: BuildingModel,
  stair: StairElement,
  footprint: Vec2[],
): SlabElement | undefined {
  const level = building.levels[stair.levelId];
  if (!level) return undefined;
  const top = level.elevation + stair.riserCount * stair.riserHeight;
  const tolerance = Math.max(stair.riserHeight * 0.5, 1e-9);
  return Object.values(building.elements).find(
    (element): element is SlabElement =>
      element.category === 'slab' &&
      Math.abs((building.levels[element.levelId]?.elevation ?? Number.NaN) - top) <= tolerance &&
      footprint.every((point) => pointInPolygon(point, element.boundary)),
  );
}

interface AddSlabOpeningParams {
  slabId?: string;
  boundary?: Vec2[];
  stairId?: string;
  margin?: number;
}

/**
 * @command add_slab_opening
 * @pure
 * @affects re-evaluates the slab as a mesh with the void
 * @failure unknown slab / stair, opening outside the slab or overlapping another -> no-op
 */
export const addSlabOpening: CommandDefinition<AddSlabOpeningParams> = {
  name: 'add_slab_opening',
  description:
    'Cut a void through a slab (stair well, lift or service shaft). Give a plan boundary polygon, or a ' +
    'stairId to cut its well (footprint + margin) in the floor slab of the level above — slabId is then ' +
    'found automatically. Openings are deducted from quantities and exported as IFC openings.',
  paramsSchema: {
    type: 'object',
    properties: {
      slabId: {
        type: 'string',
        description: 'Slab element id, e.g. "slab-2". Optional with stairId.',
      },
      boundary: {
        type: 'array',
        items: { type: 'array', items: { type: 'number' } },
        description: 'Opening polygon [[x, y], …], strictly inside the slab.',
      },
      stairId: {
        type: 'string',
        description: 'Alternative to boundary: cut the well of this stair.',
      },
      margin: {
        type: 'number',
        description: 'With stairId: clearance around the stair footprint. Default 100 mm.',
      },
    },
    required: [],
  },
  run: (doc, { slabId, boundary, stairId, margin }): CommandResult => {
    const building = getBuilding(doc);
    let outline: Vec2[] | null = null;
    let slab: SlabElement | undefined;
    if (stairId !== undefined) {
      const stair = building.elements[stairId];
      if (stair?.category !== 'stair')
        return noChange(doc, `add_slab_opening failed: no stair '${stairId}'.`);
      const clearance = margin ?? fromMm(doc, 100);
      if (!isFiniteNumber(clearance) || clearance < 0) {
        return noChange(doc, 'add_slab_opening failed: margin must be >= 0.');
      }
      outline = stairFootprint(stair, clearance);
      slab = slabId === undefined ? slabAboveStair(building, stair, outline) : undefined;
    } else if (isVec2List(boundary, 3)) {
      outline = boundary.map(toVec2);
    }
    if (!outline) {
      return noChange(
        doc,
        'add_slab_opening failed: give a boundary of ≥ 3 [x, y] points or a stairId.',
      );
    }
    if (slabId !== undefined) {
      const candidate = building.elements[slabId];
      slab = candidate?.category === 'slab' ? candidate : undefined;
    }
    if (!slab) {
      return noChange(
        doc,
        slabId !== undefined
          ? `add_slab_opening failed: no slab '${slabId}'.`
          : 'add_slab_opening failed: no floor slab on the level above contains the stair (pass slabId).',
      );
    }
    const error = slabOpeningError(slab, outline);
    if (error) return noChange(doc, `add_slab_opening refused: ${error}.`);
    const updated: SlabElement = { ...slab, openings: [...(slab.openings ?? []), outline] };
    const document = regenerateBuilding(doc, withElement(building, updated));
    const area = polygonArea(outline) * toMetres(doc, 1) ** 2;
    return {
      document,
      summary: `Cut opening #${updated.openings?.length ?? 0} (${area.toFixed(2)} m²) in slab ${slab.mark} (${slab.id}).`,
      affected: elementAffected(document, [slab.id]),
      data: { slabId: slab.id, openingIndex: (updated.openings?.length ?? 1) - 1 },
    };
  },
};

interface DeleteSlabOpeningParams {
  slabId: string;
  index: number;
}

/**
 * @command delete_slab_opening
 * @pure
 * @failure unknown slab / index out of range -> no-op
 */
export const deleteSlabOpening: CommandDefinition<DeleteSlabOpeningParams> = {
  name: 'delete_slab_opening',
  annotations: { destructive: true },
  description: 'Fill (remove) opening number `index` (0-based) of a slab.',
  paramsSchema: {
    type: 'object',
    properties: {
      slabId: { type: 'string', description: 'Slab element id.' },
      index: { type: 'number', description: '0-based opening index (see describe_building).' },
    },
    required: ['slabId', 'index'],
  },
  run: (doc, { slabId, index }): CommandResult => {
    const building = getBuilding(doc);
    const slab = building.elements[slabId];
    if (slab?.category !== 'slab')
      return noChange(doc, `delete_slab_opening failed: no slab '${slabId}'.`);
    const openings = slab.openings ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= openings.length) {
      return noChange(
        doc,
        `delete_slab_opening failed: slab ${slab.mark} has ${openings.length} opening(s).`,
      );
    }
    const remaining = openings.filter((_, position) => position !== index);
    const updated: SlabElement = { ...slab, openings: remaining };
    const document = regenerateBuilding(doc, withElement(building, updated));
    return {
      document,
      summary: `Removed opening #${index} from slab ${slab.mark}; ${remaining.length} left.`,
      affected: elementAffected(document, [slabId]),
    };
  },
};
