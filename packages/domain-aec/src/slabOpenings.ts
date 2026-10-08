/**
 * Voids through slabs: stair wells, shafts, risers.
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import type { BuildingModel, SlabElement, StairElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import {
  isValidPolygon,
  pointInPolygon,
  projectOntoSegment,
  polygonArea,
  segmentsIntersect,
} from '@lib/polygon';
import {
  fromMm,
  getBuilding,
  isVec2List,
  toMetres,
  toVec2,
  withElement,
  elementAffected,
} from './model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from './evaluateElements';
import { stairPoint } from './stairGeometry';
import { triangulatePolygon } from '@lib/triangulate';

/** Plan footprint of a stair run, grown by `margin` on every side. */
function stairFootprint(stair: StairElement, margin: number): Vec2[] {
  const half = stair.width / 2 + margin;
  const run = stair.riserCount * stair.treadDepth + margin;
  return [
    stairPoint(stair, -margin, -half),
    stairPoint(stair, run, -half),
    stairPoint(stair, run, half),
    stairPoint(stair, -margin, half),
  ];
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
  const xs = slab.boundary.map((point) => point[0]);
  const ys = slab.boundary.map((point) => point[1]);
  const gap =
    Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1e-3;
  const loops = [slab.boundary, ...(slab.openings ?? [])];
  const tooClose = loops.some((loop) =>
    edges(loop).some(
      ([a, b]) =>
        opening.some((point) => projectOntoSegment(point, a, b).distance < gap) ||
        edges(opening).some(([c, d]) =>
          [a, b].some((point) => projectOntoSegment(point, c, d).distance < gap),
        ),
    ),
  );
  if (tooClose) {
    return `the opening comes within ${gap.toFixed(1)} of the slab edge or another opening (keep a gap)`;
  }
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

/**
 * @command add_slab_opening
 * @pure
 * @affects re-evaluates the slab as a mesh with the void
 * @failure unknown slab / stair, opening outside the slab or overlapping another -> no-op
 */
export const addSlabOpening = defineCommand({
  name: 'add_slab_opening',
  description:
    'Cut a void through a slab (stair well, lift or service shaft). Give a plan boundary polygon, or a ' +
    'stairId to cut its well (footprint + margin) in the floor slab of the level above — slabId is then ' +
    'found automatically. Openings are deducted from quantities and exported as IFC openings.',
  params: z.object({
    slabId: z
      .string()
      .optional()
      .describe('Slab element id, e.g. "slab-2". Optional with stairId.'),
    boundary: z
      .array(z.array(z.number()))
      .optional()
      .describe('Opening polygon [[x, y], …], strictly inside the slab.'),
    stairId: z.string().optional().describe('Alternative to boundary: cut the well of this stair.'),
    margin: z
      .number()
      .optional()
      .describe(
        'With stairId: clearance around the stair footprint, in document units. Default 100 mm.',
      ),
  }),
  run: (doc, { slabId, boundary, stairId, margin }): CommandResult => {
    const building = getBuilding(doc);
    let outline: Vec2[] | null = null;
    let slab: SlabElement | undefined;
    if (stairId !== undefined) {
      const stair = building.elements[stairId];
      if (stair?.category !== 'stair')
        return noop(doc, `add_slab_opening failed: no stair '${stairId}'.`);
      const clearance = margin ?? fromMm(doc, 100);
      if (clearance < 0) {
        return noop(doc, 'add_slab_opening failed: margin must be >= 0.');
      }
      outline = stairFootprint(stair, clearance);
      slab = slabId === undefined ? slabAboveStair(building, stair, outline) : undefined;
    } else if (isVec2List(boundary, 3)) {
      outline = boundary.map(toVec2);
    }
    if (!outline) {
      return noop(
        doc,
        'add_slab_opening failed: give a boundary of ≥ 3 [x, y] points or a stairId.',
      );
    }
    if (slabId !== undefined) {
      const candidate = building.elements[slabId];
      slab = candidate?.category === 'slab' ? candidate : undefined;
    }
    if (!slab) {
      return noop(
        doc,
        slabId !== undefined
          ? `add_slab_opening failed: no slab '${slabId}'.`
          : 'add_slab_opening failed: no floor slab on the level above contains the stair (pass slabId).',
      );
    }
    const error = slabOpeningError(slab, outline);
    if (error) return noop(doc, `add_slab_opening refused: ${error}.`);
    const updated: SlabElement = { ...slab, openings: [...(slab.openings ?? []), outline] };
    const document = regenerateBuilding(doc, withElement(building, updated));
    const area = polygonArea(outline) * toMetres(doc, 1) ** 2;
    const openingIndex = (updated.openings?.length ?? 1) - 1;
    return {
      document,
      summary: `Cut opening index ${openingIndex} (${area.toFixed(2)} m²) in slab ${slab.mark} (${slab.id}).`,
      affected: elementAffected(document, [slab.id]),
      data: { slabId: slab.id, openingIndex },
    };
  },
});

/**
 * @command delete_slab_opening
 * @pure
 * @failure unknown slab / index out of range -> no-op
 */
export const deleteSlabOpening = defineCommand({
  name: 'delete_slab_opening',
  annotations: { destructive: true },
  description: 'Fill (remove) opening number `index` (0-based) of a slab.',
  params: z.object({
    slabId: z.string().describe('Slab element id.'),
    index: z.number().describe('0-based opening index (see describe_building).'),
  }),
  run: (doc, { slabId, index }): CommandResult => {
    const building = getBuilding(doc);
    const slab = building.elements[slabId];
    if (slab?.category !== 'slab')
      return noop(doc, `delete_slab_opening failed: no slab '${slabId}'.`);
    const openings = slab.openings ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= openings.length) {
      return noop(
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
});
