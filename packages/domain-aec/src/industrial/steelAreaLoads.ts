/**
 * Area-load path of floor slabs and equipment onto the beams under them.
 * Every load is rastered into small cells; a cell bears on the NEAREST supporting beam in plan,
 * which for a rectangular bay is the 45° tributary rule (two triangles on the short sides, two
 * trapezoids on the long sides). Cells equidistant from two beams split between them.
 * @layer domain-aec
 * @pure
 */

import { pointInPolygon, polygonArea, projectOntoSegment, type Point2 } from '@lib/polygon';
import { GRAVITY, type ModelUnits } from './steelMemberBars';
import { depositArea, type BeamLoads } from './steelBeamLoads';

export interface AreaLoadParams {
  /** kN/m² on every floor slab (permanent). */
  readonly floorDeadLoad: number;
  /** kN/m² on the floor area not occupied by equipment (imposed). */
  readonly imposedLoad: number;
}

export interface FloorLoadReport {
  readonly slabId: string;
  readonly mark: string;
  readonly levelId: string;
  /** Net floor area (openings removed), m². */
  readonly areaM2: number;
  readonly deadKn: number;
  readonly imposedKn: number;
  readonly supportingBeams: number;
}

export interface EquipmentLoadReport {
  readonly id: string;
  readonly mark: string;
  readonly name: string;
  readonly levelId: string;
  readonly weightKg: number;
  /** Weight delivered to steel beams, kN. */
  readonly carriedKn: number;
  readonly support: 'floor' | 'beams' | 'mixed' | 'grade';
}

export interface AreaLoadResult {
  readonly floors: FloorLoadReport[];
  readonly equipment: EquipmentLoadReport[];
  readonly warnings: string[];
}

interface Surface {
  readonly slabId: string;
  readonly mark: string;
  readonly levelId: string;
  readonly polygon: Point2[];
  readonly openings: Point2[][];
  readonly top: number;
  readonly beams: BeamLoads[];
}

interface Footprint {
  readonly center: Point2;
  readonly size: readonly [number, number];
  readonly angle: number;
  readonly base: number;
}

const TIE = 1e-6;
const BEAM_BAND_BELOW = 60;
const BEAM_BAND_ABOVE = 20;
const STAND_ON_TOLERANCE = 100;

const toPoint2 = (point: readonly number[], toMm: (value: number) => number): Point2 => [
  toMm(point[0] ?? 0),
  toMm(point[1] ?? 0),
];

const insidePlan = (point: Point2, surface: Pick<Surface, 'polygon' | 'openings'>): boolean =>
  pointInPolygon(point, surface.polygon) &&
  !surface.openings.some((opening) => pointInPolygon(point, opening));

/** True when `point` lies in the (rotated) rectangle of the footprint. */
function insideFootprint(point: Point2, footprint: Footprint): boolean {
  const dx = point[0] - footprint.center[0];
  const dy = point[1] - footprint.center[1];
  const cos = Math.cos(footprint.angle);
  const sin = Math.sin(footprint.angle);
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  return Math.abs(u) <= footprint.size[0] / 2 && Math.abs(v) <= footprint.size[1] / 2;
}

/** Beams whose top of steel lies within the band under a surface at `top` (thickness folded in). */
function beamsUnder(beams: ReadonlyArray<BeamLoads>, bottom: number, top: number): BeamLoads[] {
  return beams.filter(
    (beam) => beam.top >= bottom - BEAM_BAND_BELOW && beam.top <= top + BEAM_BAND_ABOVE,
  );
}

/** Deposit `permanent` / `imposed` kN of the cell at `point` on its nearest beam(s). */
function bear(
  point: Point2,
  beams: ReadonlyArray<BeamLoads>,
  permanent: number,
  imposed: number,
  floor: boolean,
): void {
  const found = beams.map((beam) => ({ beam, ...projectOntoSegment(point, beam.a, beam.b) }));
  const nearest = Math.min(...found.map((entry) => entry.distance));
  const tied = found.filter((entry) => entry.distance <= nearest + TIE);
  for (const { beam, t } of tied) {
    depositArea(beam, t * beam.lengthM * 1000, permanent / tied.length, imposed / tied.length);
    if (floor) beam.floorSupport = true;
  }
}

/** Cell centres of a polygon raster of side `cell` inside the surface. */
function rasterCells(surface: Surface): { centres: Point2[]; area: number } {
  const xs = surface.polygon.map((point) => point[0]);
  const ys = surface.polygon.map((point) => point[1]);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const cell = Math.min(200, Math.max(25, Math.sqrt(((maxX - minX) * (maxY - minY)) / 40000)));
  const centres: Point2[] = [];
  for (let x = minX + cell / 2; x < maxX; x += cell) {
    for (let y = minY + cell / 2; y < maxY; y += cell) {
      if (insidePlan([x, y], surface)) centres.push([x, y]);
    }
  }
  const gross = polygonArea(surface.polygon);
  const net = gross - surface.openings.reduce((sum, opening) => sum + polygonArea(opening), 0);
  return { centres, area: Math.max(0, net) / 1e6 };
}

function surfacesOf(units: ModelUnits, beams: ReadonlyArray<BeamLoads>): Surface[] {
  const { building, toMm, elevationMm } = units;
  const surfaces: Surface[] = [];
  for (const id of building.elementOrder) {
    const slab = building.elements[id];
    if (slab?.category !== 'slab' || slab.role !== 'floor') continue;
    const top = elevationMm(slab.levelId) + toMm(slab.offset);
    surfaces.push({
      slabId: slab.id,
      mark: slab.mark,
      levelId: slab.levelId,
      polygon: slab.boundary.map((point) => toPoint2(point, toMm)),
      openings: (slab.openings ?? []).map((opening) =>
        opening.map((point) => toPoint2(point, toMm)),
      ),
      top,
      beams: beamsUnder(beams, top - toMm(slab.thickness), top),
    });
  }
  return surfaces;
}

function footprintsOf(units: ModelUnits): Array<{ id: string; footprint: Footprint }> {
  const { building, toMm, elevationMm } = units;
  const footprints: Array<{ id: string; footprint: Footprint }> = [];
  for (const id of building.elementOrder) {
    const equipment = building.elements[id];
    if (equipment?.category !== 'equipment') continue;
    footprints.push({
      id,
      footprint: {
        center: toPoint2(equipment.location, toMm),
        size: [toMm(equipment.size[0]), toMm(equipment.size[1])],
        angle: equipment.angle,
        base: elevationMm(equipment.levelId),
      },
    });
  }
  return footprints;
}

function applyFloors(
  surfaces: ReadonlyArray<Surface>,
  footprints: ReadonlyArray<Footprint>,
  params: AreaLoadParams,
  warnings: string[],
): FloorLoadReport[] {
  return surfaces.map((surface): FloorLoadReport => {
    const { centres, area } = rasterCells(surface);
    const report = { slabId: surface.slabId, mark: surface.mark, levelId: surface.levelId };
    if (surface.beams.length === 0 || centres.length === 0) {
      warnings.push(
        `floor slab ${surface.mark} (${surface.levelId}) has no steel beam at its level: its load is not carried by any member`,
      );
      return { ...report, areaM2: area, deadKn: 0, imposedKn: 0, supportingBeams: 0 };
    }
    const standing = footprints.filter(
      (footprint) => Math.abs(footprint.base - surface.top) <= STAND_ON_TOLERANCE,
    );
    const cellArea = area / centres.length;
    let deadKn = 0;
    let imposedKn = 0;
    for (const centre of centres) {
      const occupied = standing.some((footprint) => insideFootprint(centre, footprint));
      const dead = params.floorDeadLoad * cellArea;
      const imposed = occupied ? 0 : params.imposedLoad * cellArea;
      bear(centre, surface.beams, dead, imposed, true);
      deadKn += dead;
      imposedKn += imposed;
    }
    const supporting = new Set(
      surface.beams.filter((beam) => beam.floorSupport).map((beam) => beam.bar.id),
    );
    return { ...report, areaM2: area, deadKn, imposedKn, supportingBeams: supporting.size };
  });
}

function applyEquipment(
  units: ModelUnits,
  surfaces: ReadonlyArray<Surface>,
  beams: ReadonlyArray<BeamLoads>,
  warnings: string[],
): EquipmentLoadReport[] {
  const reports: EquipmentLoadReport[] = [];
  const located = footprintsOf(units);
  for (const { id, footprint } of located) {
    const equipment = units.building.elements[id];
    if (equipment?.category !== 'equipment') continue;
    const weightKn = (Math.max(0, equipment.weight) * GRAVITY) / 1000;
    const [length, width] = footprint.size;
    const cell = Math.max(5, Math.min(100, length / 4, width / 4));
    const nu = Math.min(300, Math.max(1, Math.ceil(length / cell)));
    const nv = Math.min(300, Math.max(1, Math.ceil(width / cell)));
    const onBeams = beamsUnder(beams, footprint.base - 1, footprint.base);
    const share = weightKn / (nu * nv);
    const cos = Math.cos(footprint.angle);
    const sin = Math.sin(footprint.angle);
    let carried = 0;
    let viaFloor = 0;
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const u = -length / 2 + ((i + 0.5) * length) / nu;
        const v = -width / 2 + ((j + 0.5) * width) / nv;
        const point: Point2 = [
          footprint.center[0] + u * cos - v * sin,
          footprint.center[1] + u * sin + v * cos,
        ];
        const surface = surfaces.find(
          (candidate) =>
            Math.abs(candidate.top - footprint.base) <= STAND_ON_TOLERANCE &&
            candidate.beams.length > 0 &&
            insidePlan(point, candidate),
        );
        const target = surface?.beams ?? onBeams;
        if (target.length === 0) continue;
        bear(point, target, share, 0, false);
        carried += share;
        if (surface) viaFloor += share;
      }
    }
    const support =
      carried === 0 ? 'grade' : viaFloor === carried ? 'floor' : viaFloor === 0 ? 'beams' : 'mixed';
    if (weightKn > 0 && carried < weightKn * 0.999) {
      warnings.push(
        carried === 0
          ? `equipment ${equipment.mark} (${equipment.name}) stands on grade: no steel beam or floor at its base, its ${round1(weightKn)} kN is not carried by the structure`
          : `equipment ${equipment.mark} (${equipment.name}): ${round1(weightKn - carried)} kN of ${round1(weightKn)} kN stand outside the floor / beams and are not carried`,
      );
    }
    reports.push({
      id,
      mark: equipment.mark,
      name: equipment.name,
      levelId: equipment.levelId,
      weightKg: equipment.weight,
      carriedKn: carried,
      support,
    });
  }
  return reports;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Deposit floor dead / imposed load and equipment weight on the beams.
 * @invariant carried equipment weight = weight × share of its footprint cells over a floor or beams
 */
export function applyAreaLoads(
  units: ModelUnits,
  beams: ReadonlyArray<BeamLoads>,
  params: AreaLoadParams,
): AreaLoadResult {
  const warnings: string[] = [];
  const surfaces = surfacesOf(units, beams);
  const floors = applyFloors(
    surfaces,
    footprintsOf(units).map((entry) => entry.footprint),
    params,
    warnings,
  );
  const equipment = applyEquipment(units, surfaces, beams, warnings);
  return { floors, equipment, warnings };
}
