/**
 * Face area and centroid, computed once per solid: `topology`, `faceGraph` and `faceDetails` all read them, and BRepGProp.SurfaceProperties is
 * the slowest call of the B-rep extraction (1.2 s per pass on the 635 faces of NIST CTC-02).
 * @invariant keyed by the native solid object and the unique-face index (`uniqueSubShapes` order), so a rebuilt shape recomputes
 */

import type { Vec3 } from '@core/model/types';
import { release } from '@core/geometry/nativeObject';
import type { OccApi, OccHandle, OccPoint, OccShape } from './occtTypes';

export interface FaceMetric {
  readonly area: number;
  readonly centroid: Vec3;
}

interface Props extends OccHandle {
  Mass(): number;
  CentreOfMass(): OccPoint;
}

const metrics = new WeakMap<object, Map<number, FaceMetric>>();

/** Area and centroid of `face`, the `index`-th unique face of `solid`. */
export function faceMetric(api: OccApi, solid: OccShape, index: number, face: OccShape): FaceMetric {
  const known = metrics.get(solid) ?? new Map<number, FaceMetric>();
  metrics.set(solid, known);
  const cached = known.get(index);
  if (cached !== undefined) return cached;
  const props = new api.GProp_GProps_1() as Props;
  api.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const centre = props.CentreOfMass();
  const metric: FaceMetric = { area: props.Mass(), centroid: [centre.X(), centre.Y(), centre.Z()] };
  [centre, props].forEach(release);
  known.set(index, metric);
  return metric;
}
