// Face picking and drag-value rules of the B-rep handles, composed from the pure mesh and math helpers. No React, no stores.

import type { Vec3 } from '@core/model/types';
import { dot3 } from '@lib/vec3';
import { draftAngle, type FaceOp, type FacePick } from './faceEditModel';
import { snapFaceValue } from './faceDragMath';
import {
  heightAbove,
  parallelPlaneOffsets,
  planarRegion,
  raycastTriangles,
  smoothRegion,
  viewerFacingNormal,
  type PickRay,
} from './faceMesh';
import type { PickableTriangles } from './faceTriangles';

const UP: Vec3 = [0, 0, 1];

export interface FacePicked {
  readonly pick: FacePick;
  /** Triangle indices of the coplanar patch. */
  readonly region: number[];
}

/** The face under the ray: hit point, viewer-facing (outward) normal, draft lever and its coplanar patch; null on a miss. */
export function pickFaceAt(source: PickableTriangles, ray: PickRay): FacePicked | null {
  const hit = raycastTriangles(source.triangles, ray);
  const triangle = hit === null ? undefined : source.triangles[hit.index];
  if (hit === null || triangle === undefined) return null;
  const normal = viewerFacingNormal(triangle, ray);
  if (normal === null) return null;
  // a coplanar patch of at most two triangles (one facet of a tessellated bore, boss or sphere) that is smoothly joined to its neighbours is a curved face
  const planar = planarRegion(source.triangles, source.adjacency, hit.index);
  const smooth = planar.length > 2 ? planar : smoothRegion(source.triangles, source.adjacency, hit.index);
  return {
    pick: { point: hit.point, normal, lever: Math.max(0, heightAbove(source.triangles, UP, hit.point)) },
    region: smooth.length > planar.length ? smooth : planar,
  };
}

/** Offsets (relative to the picked plane) of the other parallel planes of the solid: the snap targets of "flush to plane". */
export function snapPlanes(source: PickableTriangles, pick: FacePick): number[] {
  const here = dot3(pick.normal, pick.point);
  return parallelPlaneOffsets(source.triangles, pick.normal)
    .map((offset) => offset - here)
    .filter((relative) => Math.abs(relative) > 1e-6);
}

export interface DragRules {
  readonly op: FaceOp;
  readonly pick: FacePick;
  /** Snap step in length units (0 = free). */
  readonly step: number;
  readonly planes: readonly number[];
  /** Snap reach to a plane, in length units. */
  readonly planeTolerance: number;
}

/** The drag value (length, or degrees for a draft) for `travel` along the normal. */
export function dragValue(rules: DragRules, travel: number): number {
  if (rules.op === 'draft') {
    const angle = draftAngle(travel, rules.pick.lever);
    return rules.step === 0 ? angle : Math.round(angle * 2) / 2;
  }
  return snapFaceValue(travel, rules.step, rules.op === 'flush' ? rules.planes : [], rules.planeTolerance);
}
