/**
 * Nozzle placement and connection ports (plant 03 EQP §5.4, README D3). `equipmentPorts` is the one entry point 02 RTE (and the piping
 * plugin) imports: pure, world-space, ports are computed from the stored template and nozzles and never stored.
 * Angle convention of stored nozzles is `north_cw`: vertical equipment 0 = plant north (+Y), increasing clockwise seen from above; horizontal
 * equipment 0 = top (+Z), 90 = +Y side, around the vessel axis.
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { BuildingLevel, BuildingModel, EquipmentElement } from '@aec/building/types';
import type { EquipmentTemplate, NozzleFacing, NozzleRecord } from '../plantData';
import { headSurfaceHeight, resolveVessel, type VesselGeometry } from './vesselFrame';

/** A world-space connection point of an equipment nozzle (shared with 02 RTE / 07 PST). */
export interface ConnectionPort {
  /** `<tag>:<mark>`, stable across revisions. */
  readonly id: string;
  /** Element id of the equipment. */
  readonly ownerId: string;
  readonly tag: string;
  readonly mark: string;
  readonly service?: string;
  /** Flange face centre, world, document units. */
  readonly position: Vec3;
  /** Unit vector pointing away from the equipment (toward the pipe). */
  readonly direction: Vec3;
  readonly dn: number;
  readonly rating: string;
  readonly facing: NozzleFacing;
}

/** Nozzle geometry in the equipment frame: `base` (inside the wall), flange-face centre `face`, unit outward `direction`. */
export interface NozzlePlacement {
  readonly base: Vec3;
  readonly face: Vec3;
  readonly direction: Vec3;
}

const ROUND = 1e9;
const round = (value: number): number => Math.round(value * ROUND) / ROUND + 0;
const roundDirection = (value: number): number => Math.round(value * 1e12) / 1e12 + 0;
const rad = (degrees: number): number => (degrees * Math.PI) / 180;
const point = (x: number, y: number, z: number): Vec3 => [x, y, z];
const offsetAlong = (from: Vec3, direction: Vec3, distance: number): Vec3 =>
  point(from[0] + direction[0] * distance, from[1] + direction[1] * distance, from[2] + direction[2] * distance);

function unit(vector: Vec3): Vec3 | null {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > 1e-12 ? point(vector[0] / length, vector[1] / length, vector[2] / length) : null;
}

function verticalPlacement(geometry: VesselGeometry, nozzle: NozzleRecord): NozzlePlacement | null {
  const { location, projection } = nozzle;
  const bottom = geometry.datum;
  const top = bottom + geometry.length;
  if (location.on === 'shell' && 'elevation' in location) {
    const angle = rad(location.orientationDeg);
    const direction = point(Math.sin(angle), Math.cos(angle), 0);
    const start = geometry.radius + geometry.shellThickness / 2;
    const z = bottom + location.elevation;
    return { base: offsetAlong(point(0, 0, z), direction, start), face: offsetAlong(point(0, 0, z), direction, projection), direction };
  }
  if (location.on === 'head' && (location.head === 'top' || location.head === 'bottom')) {
    const angle = rad(location.orientationDeg);
    const x = location.radialOffset * Math.sin(angle);
    const y = location.radialOffset * Math.cos(angle);
    const sign = location.head === 'top' ? 1 : -1;
    const shape = location.head === 'top' ? geometry.second : geometry.first;
    const surface = headSurfaceHeight(shape, geometry.radius, location.radialOffset) + geometry.headThickness / 2;
    const tangent = location.head === 'top' ? top : bottom;
    return { base: point(x, y, tangent + sign * surface), face: point(x, y, tangent + sign * projection), direction: point(0, 0, sign) };
  }
  return null;
}

function horizontalPlacement(geometry: VesselGeometry, nozzle: NozzleRecord): NozzlePlacement | null {
  const { location, projection } = nozzle;
  const axis = geometry.datum;
  const half = geometry.length / 2;
  if (location.on === 'shell' && 'station' in location) {
    const angle = rad(location.orientationDeg);
    const direction = point(0, Math.sin(angle), Math.cos(angle));
    const centre = point(-half + location.station, 0, axis);
    const start = geometry.radius + geometry.shellThickness / 2;
    return { base: offsetAlong(centre, direction, start), face: offsetAlong(centre, direction, projection), direction };
  }
  if (location.on === 'head' && (location.head === 'left' || location.head === 'right')) {
    const angle = rad(location.orientationDeg);
    const y = location.radialOffset * Math.sin(angle);
    const z = axis + location.radialOffset * Math.cos(angle);
    const sign = location.head === 'right' ? 1 : -1;
    const shape = location.head === 'right' ? geometry.second : geometry.first;
    const surface = headSurfaceHeight(shape, geometry.radius, location.radialOffset) + geometry.headThickness / 2;
    return { base: point(sign * (half + surface), y, z), face: point(sign * (half + projection), y, z), direction: point(sign, 0, 0) };
  }
  return null;
}

/**
 * Placement of `nozzle` on `template` in the equipment frame (origin = plan location at the level elevation), or null when the location
 * does not suit the template (shell elevation on a horizontal vessel, a left head on a vertical one, a head that cannot be resolved ...).
 * @invariant free locations work on every template, including legacy blocks (`kind: 'block'`)
 */
export function placeNozzle(template: EquipmentTemplate, nozzle: NozzleRecord): NozzlePlacement | null {
  const { location } = nozzle;
  if (location.on === 'free') {
    const direction = unit(location.direction);
    if (direction === null) return null;
    return { base: offsetAlong(location.position, direction, -nozzle.projection), face: location.position, direction };
  }
  if (template.kind !== 'vessel') return null;
  const geometry = resolveVessel(template);
  if ('error' in geometry) return null;
  return template.orientation === 'vertical' ? verticalPlacement(geometry, nozzle) : horizontalPlacement(geometry, nozzle);
}

/** Local equipment-frame point -> world: rotate by the plan angle about +Z, translate by the plan location, add the level elevation. */
export function toWorld(element: EquipmentElement, level: Pick<BuildingLevel, 'elevation'>, local: Vec3): Vec3 {
  const [cos, sin] = [Math.cos(element.angle), Math.sin(element.angle)];
  return point(
    round(element.location[0] + cos * local[0] - sin * local[1]),
    round(element.location[1] + sin * local[0] + cos * local[1]),
    round(level.elevation + local[2]),
  );
}

/** Local equipment-frame direction -> world (rotation only). */
export function directionToWorld(element: EquipmentElement, local: Vec3): Vec3 {
  const [cos, sin] = [Math.cos(element.angle), Math.sin(element.angle)];
  return point(roundDirection(cos * local[0] - sin * local[1]), roundDirection(sin * local[0] + cos * local[1]), roundDirection(local[2]));
}

const isBuilding = (source: BuildingModel | Pick<CadDocument, 'building'>): source is BuildingModel => 'elements' in source;

/**
 * World-space ports of one equipment element, in nozzle order.
 * @param source the building model, or a document that carries one
 * @invariant ports are computed, never stored; id = `<tag>:<mark>` where tag = the element mark
 * @failure legacy equipment without nozzles -> []; a nozzle whose location does not suit the template is skipped
 */
export function equipmentPorts(source: BuildingModel | Pick<CadDocument, 'building'>, element: EquipmentElement): ConnectionPort[] {
  const building = isBuilding(source) ? source : source.building;
  const level = building?.levels[element.levelId];
  const plant = element.plant;
  if (plant === undefined || level === undefined) return [];
  return plant.nozzles.flatMap((nozzle): ConnectionPort[] => {
    const placement = placeNozzle(plant.template, nozzle);
    if (placement === null) return [];
    return [
      {
        id: `${element.mark}:${nozzle.mark}`,
        ownerId: element.id,
        tag: element.mark,
        mark: nozzle.mark,
        ...(nozzle.service === undefined ? {} : { service: nozzle.service }),
        position: toWorld(element, level, placement.face),
        direction: directionToWorld(element, placement.direction),
        dn: nozzle.dn,
        rating: nozzle.rating,
        facing: nozzle.facing,
      },
    ];
  });
}
