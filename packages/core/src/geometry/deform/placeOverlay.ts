/** The deformation overlay moved from the frame of the entity's recipe (kernel-local: `brep` is before position / rotation) to the world, the placement the viewport applies. */

import type { Entity } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { applyEulerXYZ } from '../../lib/eulerRotation';
import { ORIGIN } from '../../lib/vec3';
import { entityLocalToWorld } from '../entityFrame';
import type { DeformOverlayData } from './overlay';

type Placement = Pick<Entity, 'position' | 'rotation'>;

/** `overlay` with every point placed and every axis direction rotated (lengths and counts are placement-free). */
export function placeDeformOverlay(entity: Placement, overlay: DeformOverlayData): DeformOverlayData {
  const point = (p: Vec3): Vec3 => entityLocalToWorld(entity, p);
  const points = (list: Vec3[]): Vec3[] => list.map(point);
  const direction = (d: Vec3): Vec3 => applyEulerXYZ(d, ORIGIN, entity.rotation);
  const { frame, region, lattice, flow, sheet } = overlay;
  return {
    ...overlay,
    frame: { ...frame, origin: point(frame.origin), x: direction(frame.x), y: direction(frame.y), z: direction(frame.z) },
    region: region === null ? null : { ...region, startCentre: point(region.startCentre), endCentre: point(region.endCentre) },
    lattice: lattice === null ? null : { ...lattice, rest: points(lattice.rest), moved: points(lattice.moved), box: points(lattice.box) },
    flow: flow === null ? null : { target: points(flow.target), base: flow.base === null ? null : points(flow.base) },
    sheet: sheet === null ? null : { ...sheet, target: points(sheet.target), base: sheet.base === null ? null : points(sheet.base) },
  };
}

/** Polylines of the reference wire placed like the overlay. */
export const placeWire = (entity: Placement, wire: Vec3[][]): Vec3[][] =>
  wire.map((line) => line.map((p) => entityLocalToWorld(entity, p)));
