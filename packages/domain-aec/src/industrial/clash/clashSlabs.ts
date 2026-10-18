/** Equipment or a stair passing through a floor without an opening (a grating / slab not cut around it). */

import type { Vec2 } from '@core/model/types';
import type { BuildingModel, EquipmentElement, SlabElement, StairElement } from '@core/model/building';
import { blockPoint, stairBlocks, stairPoint } from '../../building/geometry/stairGeometry';
import { pointInPolygon, rotatePoint2 } from '@lib/polygon';

/** Footprint samples per side (corners, edges and interior of the equipment's plan rectangle). */
const SAMPLES_PER_SIDE = 7;

export interface SlabPenetration {
  /** Equipment or stair element id. */
  readonly elementId: string;
  readonly slabId: string;
  /** Slab thickness crossed, document units. */
  readonly depth: number;
}

function footprintSamples(equipment: EquipmentElement): Vec2[] {
  const [length, width] = equipment.size;
  const samples: Vec2[] = [];
  for (let i = 0; i < SAMPLES_PER_SIDE; i++) {
    for (let j = 0; j < SAMPLES_PER_SIDE; j++) {
      const local: Vec2 = [(i / (SAMPLES_PER_SIDE - 1) - 0.5) * length * 0.999, (j / (SAMPLES_PER_SIDE - 1) - 0.5) * width * 0.999];
      const [x, y] = rotatePoint2(local, equipment.angle);
      samples.push([x + equipment.location[0], y + equipment.location[1]]);
    }
  }
  return samples;
}

function solidAt(slab: SlabElement, point: Vec2): boolean {
  return pointInPolygon(point, slab.boundary) && !(slab.openings ?? []).some((opening) => pointInPolygon(point, opening));
}

/** Slabs whose top lies strictly inside the equipment's height with solid slab under its footprint. */
export function slabsCrossedBy(building: BuildingModel, equipment: EquipmentElement, tolerance: number): SlabElement[] {
  const level = building.levels[equipment.levelId];
  if (!level) return [];
  const base = level.elevation;
  const top = base + equipment.size[2];
  const samples = footprintSamples(equipment);
  return Object.values(building.elements).filter((element): element is SlabElement => {
    if (element.category !== 'slab') return false;
    const slabLevel = building.levels[element.levelId];
    if (!slabLevel) return false;
    const slabTop = slabLevel.elevation + element.offset;
    if (slabTop <= base + tolerance || slabTop >= top - tolerance) return false;
    return samples.some((point) => solidAt(element, point));
  });
}

/**
 * Every (equipment, slab) pair where the slab's top lies strictly inside the equipment's height (more than `tolerance` from its base and
 * top) and solid slab is under part of its footprint.
 * @invariant the footprint is the equipment's plan bounding rectangle (vessels included: conservative)
 */
export function slabPenetrations(building: BuildingModel, inScope: (levelId: string) => boolean, tolerance: number): SlabPenetration[] {
  const found: SlabPenetration[] = [];
  for (const equipment of Object.values(building.elements)) {
    if (equipment.category !== 'equipment') continue;
    for (const slab of slabsCrossedBy(building, equipment, tolerance)) {
      if (!inScope(equipment.levelId) && !inScope(slab.levelId)) continue;
      found.push({ elementId: equipment.id, slabId: slab.id, depth: slab.thickness });
    }
  }
  return found;
}

/** Clear height required above every stair tread (mm). */
export const STAIR_HEADROOM_MM = 2000;

/** Plan samples per tread (along x across) tested for solid slab above the stair. */
const TREAD_SAMPLES = 3;

/**
 * Slabs above a stair's treads with solid material inside the stair's headroom (a tread's top up to `headroom` above it): the stair
 * runs into a floor that has no well. Depth = how far the slab reaches into that headroom zone (never more than its thickness).
 * @invariant the slab the stair stands on (bottom at or below the stair base) is never reported
 */
export function stairSlabCrossings(
  building: BuildingModel,
  stair: StairElement,
  headroom: number,
  tolerance: number,
): Array<{ slab: SlabElement; depth: number }> {
  const level = building.levels[stair.levelId];
  if (!level) return [];
  const base = level.elevation;
  const treads = stairBlocks(stair).map((block) => ({
    top: base + block.zTop,
    points: Array.from({ length: TREAD_SAMPLES * TREAD_SAMPLES }, (_, index): Vec2 => {
      const [i, j] = [index % TREAD_SAMPLES, Math.floor(index / TREAD_SAMPLES)];
      const [along, across] = [
        block.length * (0.1 + (0.8 * i) / (TREAD_SAMPLES - 1) - 0.5),
        block.breadth * 0.999 * (j / (TREAD_SAMPLES - 1) - 0.5),
      ];
      const [x, y] = blockPoint(block, along, across);
      return stairPoint(stair, x, y);
    }),
  }));
  const crossings: Array<{ slab: SlabElement; depth: number }> = [];
  for (const slab of Object.values(building.elements)) {
    const slabLevel = slab.category === 'slab' ? building.levels[slab.levelId] : undefined;
    if (slab.category !== 'slab' || !slabLevel) continue;
    const slabTop = slabLevel.elevation + slab.offset;
    const slabBottom = slabTop - slab.thickness;
    if (slabBottom <= base + tolerance) continue;
    let depth = 0;
    for (const tread of treads) {
      const overlap = Math.min(slabTop, tread.top + headroom) - Math.max(slabBottom, tread.top);
      if (overlap > Math.max(depth, tolerance) && tread.points.some((point) => solidAt(slab, point))) depth = overlap;
    }
    if (depth > 0) crossings.push({ slab, depth });
  }
  return crossings;
}

/** Every (stair, slab) pair where the stair has no well through a slab within its headroom. */
export function stairPenetrations(
  building: BuildingModel,
  inScope: (levelId: string) => boolean,
  headroom: number,
  tolerance: number,
): SlabPenetration[] {
  const found: SlabPenetration[] = [];
  for (const stair of Object.values(building.elements)) {
    if (stair.category !== 'stair') continue;
    for (const { slab, depth } of stairSlabCrossings(building, stair, headroom, tolerance)) {
      if (inScope(stair.levelId) || inScope(slab.levelId)) found.push({ elementId: stair.id, slabId: slab.id, depth });
    }
  }
  return found;
}
