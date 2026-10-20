/** Result of resolving a tool face reference: the part surface + chart outline, or a coded refusal. */

import type { PartSurface } from '@core/model/composites';
import type { Vec2 } from '@core/model/types';

export type FaceResolution =
  | { readonly ok: true; readonly surface: PartSurface; readonly outline: Vec2[]; readonly faceIndex?: number }
  | {
      readonly ok: false;
      readonly code: 'CMP_FACE_NOT_FOUND' | 'CMP_FACE_AMBIGUOUS' | 'CMP_FACE_UNSUPPORTED' | 'CMP_ROSETTE_DEGENERATE';
      readonly message: string;
    };
