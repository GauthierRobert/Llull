/**
 * Exact mass properties of an OCC shape (`GeometryKernel.massProperties`, aerospace 01 KRN TR-KRN-40/41), at unit density.
 * Part-frame evaluation: the shape is copied (geometry, not only location) translated by -c, c = bounding-box centre rounded to 1 mm, and
 * integrated there; the centroid is shifted back and the inertia at the centroid is translation-invariant. Measured on OCCT 7.9.3 for a
 * 100x50x20 box, integrating in place costs 1.2e-9 relative error at 70 m; in the part frame 5e-16 (validation/occt_behaviour_probe.json).
 * Bindings used (checked against opencascade.js 1.1.1 = OCCT 7.4): BRepGProp.VolumeProperties_2 (adaptive Gauss, returns the error
 * estimate), BRepGProp.SurfaceProperties_1, GProp_GProps.CentreOfMass / MatrixOfInertia (gp_Mat.Value, 1-based; about the centre of
 * mass, Ixy = -integral xy dV), gp_Trsf.SetTranslation_1, BRepBuilderAPI_Transform_2 (copy = true).
 * @failure an OCC exception, an open shell (zero volume) or a non-finite result -> null
 */

import type { ExactMassProperties } from '@core/geometry/kernelPorts';
import type { Vec3 } from '@core/model/types';
import { release } from '@core/geometry/nativeObject';
import { boundsOf } from './occtAnalysis';
import { transformedCopy } from './occtShapes';
import type { OccApi, OccHandle, OccPoint, OccShape } from './occtTypes';

/** Relative tolerance asked of the adaptive volume integration (llull policy TR-KRN-40). */
const VOLUME_EPS = 1e-12;

interface Properties extends OccHandle {
  Mass(): number;
  CentreOfMass(): OccPoint;
  MatrixOfInertia(): OccHandle & { Value(row: number, column: number): number };
}

/** Bounding-box centre of `bounds`, each component rounded to 1 mm. */
const partFrameOrigin = ({ min, max }: { min: Vec3; max: Vec3 }): Vec3 => [
  Math.round((min[0] + max[0]) / 2) + 0,
  Math.round((min[1] + max[1]) / 2) + 0,
  Math.round((min[2] + max[2]) / 2) + 0,
];

function inPartFrame(api: OccApi, shape: OccShape, origin: Vec3): OccShape {
  if (origin.every((component) => component === 0)) return shape;
  const offset: OccHandle = new api.gp_Vec_4(-origin[0], -origin[1], -origin[2]);
  const transform = new api.gp_Trsf_1();
  transform.SetTranslation_1(offset);
  release(offset);
  const moved = transformedCopy(api, shape, transform as OccHandle);
  release(transform);
  return moved;
}

/** Volume, area, centroid and centroidal inertia of `shape` at unit density; null when the shape has no closed volume. */
export function exactMassProperties(api: OccApi, shape: OccShape): ExactMassProperties | null {
  const bounds = boundsOf(api, shape);
  const origin = partFrameOrigin(bounds);
  const local = inPartFrame(api, shape, origin);
  const volume = new api.GProp_GProps_1() as Properties;
  const surface = new api.GProp_GProps_1() as Properties;
  try {
    const error = api.BRepGProp.VolumeProperties_2(local, volume, VOLUME_EPS, true, false) as number;
    api.BRepGProp.SurfaceProperties_1(local, surface, false, false);
    const signed = volume.Mass();
    if (!Number.isFinite(signed) || Math.abs(signed) <= 0) return null;
    const sign = Math.sign(signed);
    const centre = volume.CentreOfMass();
    const matrix = volume.MatrixOfInertia();
    const value = (row: number, column: number): number => sign * matrix.Value(row, column);
    const result: ExactMassProperties = {
      volume: Math.abs(signed),
      area: surface.Mass(),
      centroid: [centre.X() + origin[0], centre.Y() + origin[1], centre.Z() + origin[2]],
      inertiaAtCentroid: [value(1, 1), value(2, 2), value(3, 3), value(1, 2), value(1, 3), value(2, 3)],
      bounds,
      ...(Number.isFinite(error) && error >= 0 ? { relError: error } : {}),
    };
    release(centre);
    release(matrix);
    const finite = [result.volume, result.area, ...result.centroid, ...result.inertiaAtCentroid].every(Number.isFinite);
    return finite ? result : null;
  } finally {
    release(volume);
    release(surface);
    if (local !== shape) release(local);
  }
}
