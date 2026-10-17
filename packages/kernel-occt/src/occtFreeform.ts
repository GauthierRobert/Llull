/**
 * Face census of an OCC shape: freeform faces, whose surface is not a plane, cylinder, cone, sphere or torus (BSpline, Bézier, swept, extruded
 * curves). A modelled thread (07 FTR FR-FTR-20) is hundreds of them; the display mesh needs a finer deflection to close.
 */

import { withOwned } from '@core/geometry/nativeObject';
import { uniqueSubShapes } from './occtTopology';
import { faceAdaptor, surfaceParams } from './occtFaceSurface';
import type { OccApi, OccHandle, OccShape } from './occtTypes';

/** Freeform faces past which a shape counts as freeform-heavy. */
const FREEFORM_FACE_LIMIT = 40;

/** Whether `shape` has more than `limit` freeform faces. */
export function hasManyFreeformFaces(api: OccApi, shape: OccShape, limit: number = FREEFORM_FACE_LIMIT): boolean {
  return (
    withOwned<OccHandle, boolean>((own) => {
      let count = 0;
      const faces = uniqueSubShapes(api, shape, 'TopAbs_FACE').map(own);
      for (const raw of faces) {
        const face = own(api.TopoDS.Face_1(raw) as OccShape);
        if (surfaceParams(api, faceAdaptor(api, face, own), own).type === 'other' && ++count > limit) return true;
      }
      return false;
    }) ?? false
  );
}
