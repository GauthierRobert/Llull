/** Output types of exact feature recognition (07 FTR §5.6): plain data over document units and degrees. */

import type { Vec3 } from '../../model/types';
import type { HoleKind } from '../../model/features';

export const RECOGNIZE_KINDS = ['hole', 'pocket', 'fillet', 'chamfer', 'bend'] as const;
type RecognizeKind = (typeof RECOGNIZE_KINDS)[number];

export interface RecognizeOptions {
  readonly kinds: readonly RecognizeKind[];
  /** Union faces on the same analytic surface (periodic surfaces arrive as several faces). */
  readonly mergeSplitFaces: boolean;
  /** Radians. */
  readonly angularTolerance: number;
  /** Document length units. */
  readonly lengthTolerance: number;
}

export interface RecognizedHole {
  readonly subtype: HoleKind;
  /** Hole centre on the entrance plane. */
  readonly axisPoint: Vec3;
  /** Unit axis pointing INTO the material. */
  readonly axis: Vec3;
  readonly diameter: number;
  readonly cskDiameter?: number;
  readonly cskAngleDeg?: number;
  readonly cskDepth?: number;
  readonly cboreDiameter?: number;
  readonly cboreDepth?: number;
  /** Cylindrical depth from the entrance plane of a blind hole (drill point excluded). */
  readonly depth?: number;
  readonly through: boolean;
  readonly drillPointAngleDeg?: number;
  readonly faceIndices: readonly number[];
  readonly confidence: 'exact' | 'ambiguous';
}

export interface RecognizedPocket {
  /** Signed distance of the floor plane from the world origin along its outward normal. */
  readonly floorZ: number;
  readonly normal: Vec3;
  readonly depth: number;
  readonly cornerRadius: number;
  readonly floorFillet: number;
  readonly open: boolean;
  readonly faceIndices: readonly number[];
}

export interface RecognizedFillet {
  readonly radius: number;
  readonly convex: boolean;
  readonly faceIndices: readonly number[];
}

export interface RecognizedChamfer {
  /** Leg length on each of the two perpendicular faces. */
  readonly distance: number;
  readonly faceIndices: readonly number[];
}

export interface RecognizedBend {
  readonly innerRadius: number;
  readonly thickness: number;
  readonly angleDeg: number;
  readonly axisPoint: Vec3;
  readonly axis: Vec3;
  readonly faceIndices: readonly number[];
}

export interface Recognition {
  readonly holes: readonly RecognizedHole[];
  readonly pockets: readonly RecognizedPocket[];
  readonly fillets: readonly RecognizedFillet[];
  readonly chamfers: readonly RecognizedChamfer[];
  readonly bends: readonly RecognizedBend[];
  /** Faces of non-planar surfaces that no recognised feature explains. */
  readonly unclassified: readonly number[];
}
