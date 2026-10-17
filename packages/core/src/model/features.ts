/**
 * Manufacturing-feature data of the `feature` shape-recipe node (aerospace 07 FTR §3.1, step AERO-3): holes and pockets cut into a face.
 * All lengths are document units, all angles degrees; positions are local to the face `frame`.
 * @invariant `frame.normal` is the OUTWARD unit normal of the face (pointing out of the material), `xDir` a unit vector perpendicular to it,
 *   local y = normal x xDir
 */

import type { Vec2, Vec3 } from './vectors';

export const HOLE_KINDS = ['simple', 'counterbore', 'countersink'] as const;
export type HoleKind = (typeof HOLE_KINDS)[number];

export const THREAD_FAMILIES = ['UNJ', 'MJ', 'UN', 'M', 'other'] as const;

/** Cosmetic thread attribute: never changes geometry or the recipe key (FR-FTR-19). */
export interface ThreadSpec {
  readonly designation: string;
  readonly family: (typeof THREAD_FAMILIES)[number];
  /** Absent = full hole depth. */
  readonly depth?: number;
  readonly handedness?: 'right' | 'left';
}

/** Standard-part reference resolved against `doc.fasteners.catalogs` (family id + part number). */
export interface FastenerRef {
  readonly catalogId: string;
  readonly partNumber: string;
  readonly fit?: string;
}

export interface HoleSpec {
  readonly kind: HoleKind;
  readonly diameter: number;
  readonly cboreDiameter?: number;
  readonly cboreDepth?: number;
  readonly cskDiameter?: number;
  /** Included angle, degrees. */
  readonly cskAngle?: number;
  readonly thread?: ThreadSpec;
  readonly fastener?: FastenerRef;
}

/**
 * `depth`: cylindrical depth from the face (the drill point comes on top); `drillPointAngle` degrees, absent = flat bottom;
 * `drillPointDefaulted`: the angle is the 118 degree default, not an input (reported as such, AF-31).
 */
export type HoleExtent =
  | { readonly kind: 'blind'; readonly depth: number; readonly drillPointAngle?: number; readonly drillPointDefaulted?: boolean }
  | { readonly kind: 'through_all' };

/** Pocket outline = closed polygon (implicitly closed, local 2D); vertices are rounded by `cornerRadius` with exact arcs. */
export interface PocketSpec {
  readonly outline: readonly Vec2[];
  readonly depth: number | 'through';
  readonly cornerRadius: number;
  /** 0 = sharp floor; <= cornerRadius. */
  readonly floorFillet: number;
  readonly toolDiameter?: number;
}

export interface FeatureFrame {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly xDir: Vec3;
}

interface HoleFeature {
  readonly feature: 'hole';
  readonly frame: FeatureFrame;
  readonly points: readonly Vec2[];
  readonly hole: HoleSpec;
  readonly extent: HoleExtent;
}

interface PocketFeature {
  readonly feature: 'pocket';
  readonly frame: FeatureFrame;
  readonly pocket: PocketSpec;
}

/** The parameters of a `{ op: 'feature' }` recipe node (its `source` is the shape being cut). */
export type FeatureParams = HoleFeature | PocketFeature;
