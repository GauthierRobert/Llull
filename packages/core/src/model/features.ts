/**
 * Manufacturing-feature data of the `feature` shape-recipe node (aerospace 07 FTR §3.1, step AERO-3): holes and pockets cut into a face, ribs grown from it.
 * All lengths are document units, all angles degrees; positions are local to the face `frame`.
 * @invariant `frame.normal` is the OUTWARD unit normal of the face (pointing out of the material), `xDir` a unit vector perpendicular to it,
 *   local y = normal x xDir
 */

import type { Vec2, Vec3 } from './vectors';

export const HOLE_KINDS = ['simple', 'counterbore', 'countersink', 'counterdrill'] as const;
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

/**
 * `counterdrill` = a countersink cone from `cskDiameter` at the face (included angle `cskAngle`) down to `cboreDiameter`, a cylindrical
 * counterbore of that diameter down to `cboreDepth` below the face, then the bore.
 */
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
 * `exits` (up_to_face): the target face is where the material ends (its outward normal opposes the feature face normal): the tool overshoots it.
 * `depth`: cylindrical depth from the face (the drill point comes on top); `drillPointAngle` degrees, absent = flat bottom;
 * `drillPointDefaulted`: the angle is the 118 degree default, not an input (reported as such, AF-31).
 */
export type HoleExtent =
  | { readonly kind: 'blind'; readonly depth: number; readonly drillPointAngle?: number; readonly drillPointDefaulted?: boolean }
  | { readonly kind: 'through_all' }
  | { readonly kind: 'up_to_next'; readonly depth: number }
  | { readonly kind: 'up_to_face'; readonly depth: number; readonly exits?: true };

/**
 * Pocket outline = closed polygon (implicitly closed, local 2D); vertices are rounded by `cornerRadius` with exact arcs.
 * `islands`: closed polygons inside the outline that stay as material posts (rounded by the same `cornerRadius`).
 */
export interface PocketSpec {
  readonly outline: readonly Vec2[];
  readonly islands?: ReadonlyArray<readonly Vec2[]>;
  readonly depth: number | 'through';
  readonly cornerRadius: number;
  /** 0 = sharp floor; <= cornerRadius. */
  readonly floorFillet: number;
  readonly toolDiameter?: number;
}

/**
 * Rib: the open polyline `path` (local 2D on the frame plane) thickened by `thickness` (centred when `symmetric`, else to the left of the path
 * direction) and raised `height` along the frame normal, fused to the source.
 */
export interface RibSpec {
  readonly path: readonly Vec2[];
  readonly thickness: number;
  readonly height: number;
  readonly symmetric: boolean;
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

interface RibFeature {
  readonly feature: 'rib';
  readonly frame: FeatureFrame;
  readonly rib: RibSpec;
}

/** The parameters of a `{ op: 'feature' }` recipe node (its `source` is the shape being cut, or grown for a rib). */
export type FeatureParams = HoleFeature | PocketFeature | RibFeature;
