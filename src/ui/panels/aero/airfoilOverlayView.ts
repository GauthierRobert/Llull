// Bridges an analyze_airfoil result and the selected polyline into what the overlay draws (Cp-coloured outline, lift arrow) and where the
// quarter chord sits in the world (for focus beacons). Pure.

import * as THREE from 'three';
import type { Entity, Vec3 } from '@core/model/types';
import type { AeroAirfoilView } from '@ui/store/aeroViewStore';
import { vertexPressures } from '@ui/viewport/3d/aero/aeroGeometry';
import type { AirfoilView } from './aeroData';

type Polyline = Extract<Entity, { kind: 'polyline' }>;

export function selectedPolyline(entity: Entity | undefined): Polyline | null {
  return entity?.kind === 'polyline' ? entity : null;
}

/** Quarter-chord point of the polyline airfoil in world coordinates (document units). */
export function quarterChordWorld(entity: Polyline): Vec3 {
  const xs = entity.points.map(([x]) => x);
  const leading = entity.points.reduce((best, point) => (point[0] < best[0] ? point : best), entity.points[0] ?? [0, 0]);
  const chord = Math.max(...xs) - leading[0];
  const world = new THREE.Vector3(leading[0] + chord * 0.25, leading[1], 0)
    .applyEuler(new THREE.Euler(...entity.rotation))
    .add(new THREE.Vector3(...entity.position));
  return [world.x, world.y, world.z];
}

/** The overlay payload for angle `alphaDeg`, or null when the result has no surface data or lift row for it. */
export function airfoilOverlayView(entityId: string, entity: Polyline, view: AirfoilView, alphaDeg: number): AeroAirfoilView | null {
  const surface = view.surface.find((entry) => entry.alphaDeg === alphaDeg);
  const row = view.polar.find((entry) => entry.alphaDeg === alphaDeg);
  if (surface === undefined || row === undefined) return null;
  const pressures = vertexPressures(entity.points, surface.points);
  const chord = Math.max(...entity.points.map(([x]) => x)) - Math.min(...entity.points.map(([x]) => x));
  return {
    entityId,
    position: entity.position,
    rotation: entity.rotation,
    points: entity.points,
    pressures,
    cpMin: Math.min(0, ...pressures),
    cpMax: Math.max(0, ...pressures),
    chord,
    cl: row.cl,
    alphaDeg,
  };
}
