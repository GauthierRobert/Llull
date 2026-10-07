/**
 * Equipment passing through a floor without an opening (a grating / slab not cut around it).
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import type { BuildingModel, EquipmentElement, SlabElement } from '@core/model/building';
import { pointInPolygon, rotatePoint2 } from '@lib/polygon';

/** Footprint samples per side (corners, edges and interior of the equipment's plan rectangle). */
const SAMPLES_PER_SIDE = 7;

export interface SlabPenetration {
  readonly equipmentId: string;
  readonly slabId: string;
  /** Slab thickness crossed, document units. */
  readonly depth: number;
}

function footprintSamples(equipment: EquipmentElement): Vec2[] {
  const [length, width] = equipment.size;
  const samples: Vec2[] = [];
  for (let i = 0; i < SAMPLES_PER_SIDE; i++) {
    for (let j = 0; j < SAMPLES_PER_SIDE; j++) {
      const local: Vec2 = [
        (i / (SAMPLES_PER_SIDE - 1) - 0.5) * length * 0.999,
        (j / (SAMPLES_PER_SIDE - 1) - 0.5) * width * 0.999,
      ];
      const [x, y] = rotatePoint2(local, equipment.angle);
      samples.push([x + equipment.location[0], y + equipment.location[1]]);
    }
  }
  return samples;
}

function solidAt(slab: SlabElement, point: Vec2): boolean {
  return (
    pointInPolygon(point, slab.boundary) &&
    !(slab.openings ?? []).some((opening) => pointInPolygon(point, opening))
  );
}

/** Slabs whose top lies strictly inside the equipment's height with solid slab under its footprint. */
export function slabsCrossedBy(
  building: BuildingModel,
  equipment: EquipmentElement,
  tolerance: number,
): SlabElement[] {
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
 * Every (equipment, slab) pair where the slab's top lies strictly inside the equipment's height
 * (more than `tolerance` from its base and top) and solid slab is under part of its footprint.
 * @pure
 * @invariant the footprint is the equipment's plan bounding rectangle (vessels included: conservative)
 */
export function slabPenetrations(
  building: BuildingModel,
  inScope: (levelId: string) => boolean,
  tolerance: number,
): SlabPenetration[] {
  const found: SlabPenetration[] = [];
  for (const equipment of Object.values(building.elements)) {
    if (equipment.category !== 'equipment') continue;
    for (const slab of slabsCrossedBy(building, equipment, tolerance)) {
      if (!inScope(equipment.levelId) && !inScope(slab.levelId)) continue;
      found.push({ equipmentId: equipment.id, slabId: slab.id, depth: slab.thickness });
    }
  }
  return found;
}
