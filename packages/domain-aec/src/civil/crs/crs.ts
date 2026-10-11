/**
 * Coordinate reference system helpers: the 2D similarity (Helmert) between local site coordinates
 * and the projected grid, and a grid-coordinate copy of the civil model for exchange files.
 * @layer domain-aec/civil
 * @pure
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type { CivilModel, CivilObject, SiteCalibration } from '@core/model/civil';

export type CoordinateFrame = 'local' | 'grid';

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** grid = gridOrigin + k * R(theta) * (local - localOrigin). */
export function localToGrid(calibration: SiteCalibration, point: Vec2): Vec2 {
  const theta = radians(calibration.rotationDeg);
  const cos = Math.cos(theta) * calibration.scaleFactor;
  const sin = Math.sin(theta) * calibration.scaleFactor;
  const dx = point[0] - calibration.localOrigin[0];
  const dy = point[1] - calibration.localOrigin[1];
  return [
    calibration.gridOrigin[0] + cos * dx - sin * dy,
    calibration.gridOrigin[1] + sin * dx + cos * dy,
  ];
}

/** Inverse of `localToGrid`. */
export function gridToLocal(calibration: SiteCalibration, point: Vec2): Vec2 {
  const theta = radians(calibration.rotationDeg);
  const cos = Math.cos(theta) / calibration.scaleFactor;
  const sin = Math.sin(theta) / calibration.scaleFactor;
  const dx = point[0] - calibration.gridOrigin[0];
  const dy = point[1] - calibration.gridOrigin[1];
  return [
    calibration.localOrigin[0] + cos * dx + sin * dy,
    calibration.localOrigin[1] - sin * dx + cos * dy,
  ];
}

/** The calibration of `doc`, when one is set. */
export function calibrationOf(doc: Pick<CadDocument, 'civil'>): SiteCalibration | undefined {
  return doc.civil?.crs?.calibration;
}

/** Frame an export uses: the requested one, else grid when calibrated, else local. */
export function resolveFrame(
  doc: Pick<CadDocument, 'civil'>,
  requested: CoordinateFrame | undefined,
): CoordinateFrame {
  if (calibrationOf(doc) === undefined) return 'local';
  return requested ?? 'grid';
}

function gridObject(calibration: SiteCalibration, object: CivilObject): CivilObject {
  const move = (point: Vec2): Vec2 => localToGrid(calibration, point);
  const k = calibration.scaleFactor;
  switch (object.category) {
    case 'pointGroup':
      return {
        ...object,
        points: object.points.map((point) => {
          const [x, y] = move([point.position[0], point.position[1]]);
          return { ...point, position: [x, y, point.position[2]] };
        }),
      };
    case 'surface':
      return {
        ...object,
        extraPoints: object.extraPoints.map((point) => {
          const [x, y] = move([point[0], point[1]]);
          return [x, y, point[2]];
        }),
        ...(object.boundary !== undefined ? { boundary: object.boundary.map(move) } : {}),
        ...(object.maxEdgeLength !== undefined ? { maxEdgeLength: object.maxEdgeLength * k } : {}),
      };
    case 'platform':
      return { ...object, boundary: object.boundary.map(move) };
    case 'alignment':
      return {
        ...object,
        points: object.points.map(move),
        radii: object.radii.map((radius) => radius * k),
      };
    case 'manhole':
      return { ...object, position: move(object.position) };
    case 'pipe':
      return object;
  }
}

/** `civil` with every plan coordinate expressed in the grid (elevations and stations unchanged). */
export function gridCivil(civil: CivilModel, calibration: SiteCalibration): CivilModel {
  const objects: Record<string, CivilObject> = {};
  for (const [id, object] of Object.entries(civil.objects)) {
    objects[id] = gridObject(calibration, object);
  }
  return { ...civil, objects };
}
