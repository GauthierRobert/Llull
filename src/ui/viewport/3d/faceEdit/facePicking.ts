// Face picking and drag-value rules of the B-rep handles, composed from the pure mesh and math helpers. No React, no stores.

import type { Vec3 } from '@core/model/types';
import { dot3 } from '@lib/vec3';
import { draftAngle, type FaceOp, type FacePick } from './faceEditModel';
import { snapFaceValue } from './faceDragMath';
import { heightAbove, parallelPlaneOffsets, raycastTriangles, facetStripRegion, viewerFacingNormal, type PickRay } from './faceMesh';
import type { PickableTriangles } from './faceTriangles';

const UP: Vec3 = [0, 0, 1];

export interface FacePicked {
  readonly pick: FacePick;
  /** Triangle indices of the coplanar patch. */
  readonly region: number[];
}

/** The face the kernel named for each display triangle of one entity version (`inspect_face_triangles`): triangle -> face and face -> triangles. */
export interface FaceLabels {
  readonly faceOfTriangle: ArrayLike<number>;
  readonly trianglesOfFace: ReadonlyMap<number, readonly number[]>;
}

/** Group `faceOfTriangle` by face. */
export function faceLabels(faceOfTriangle: ArrayLike<number>): FaceLabels {
  const trianglesOfFace = new Map<number, number[]>();
  for (let t = 0; t < faceOfTriangle.length; t++) {
    const face = faceOfTriangle[t] as number;
    const list = trianglesOfFace.get(face);
    if (list === undefined) trianglesOfFace.set(face, [t]);
    else list.push(t);
  }
  return { faceOfTriangle, trianglesOfFace };
}

/**
 * The face under the ray: hit point, viewer-facing (outward) normal, draft lever and the triangles of its face; null on a miss. With the kernel's `labels` the
 * face is exactly the B-rep face; without them it is the coplanar patch, or the facet strip of a tessellated curved face (`facetStripRegion`).
 */
export function pickFaceAt(source: PickableTriangles, ray: PickRay, labels: FaceLabels | null = null): FacePicked | null {
  const hit = raycastTriangles(source.triangles, ray);
  const triangle = hit === null ? undefined : source.triangles[hit.index];
  if (hit === null || triangle === undefined) return null;
  const normal = viewerFacingNormal(triangle, ray);
  if (normal === null) return null;
  const labelled =
    labels === null || hit.index >= labels.faceOfTriangle.length
      ? undefined
      : labels.trianglesOfFace.get(labels.faceOfTriangle[hit.index] as number);
  return {
    pick: { point: hit.point, normal, lever: Math.max(0, heightAbove(source.triangles, UP, hit.point)) },
    region: labelled === undefined ? facetStripRegion(source.triangles, source.adjacency, hit.index) : [...labelled],
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
