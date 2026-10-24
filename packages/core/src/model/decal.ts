import type { Vec3 } from './vectors';

/**
 * Text decal projected onto its solid along `-normal` (paint: shown and exported to glTF, not a solid). All vectors are in the owning
 * entity's local frame (before its rotation / position).
 * With `wrap` the decal is carried along the developable surface it lies on (width = arc length) instead of projected; with `mask` its letters are the outline of a font,
 * rasterised once (03 WRP M4).
 * @invariant width, height, depth > 0; normal non-zero; text non-empty
 */
export interface Decal {
  readonly id: string;
  readonly text: string;
  readonly center: Vec3;
  /** Outward surface direction the decal faces (it projects along -normal). */
  readonly normal: Vec3;
  /** Rotation of the text about `normal`, radians (0 = text +x along the projected world X/Y). */
  readonly angle: number;
  readonly width: number;
  readonly height: number;
  /** Projection depth through the surface. */
  readonly depth: number;
  readonly color: string;
  /** Optional opaque background behind the text. */
  readonly background?: string;
  /** project (default): along -normal onto the faces; wrap: along the surface of `wrap`, width and height are lengths on it. */
  readonly mapping?: 'project' | 'wrap';
  /** The developable surface of a wrap decal, in the entity-local frame (the decal `center` lies on it). */
  readonly wrap?: DecalSurface;
  /** Font text: a 1-bit coverage mask of the outline, row-major from the top row, bits MSB first, base64. */
  readonly mask?: DecalMask;
}

/** A cylinder (axis, radius) or cone (apex, axis, semi-angle) in the entity-local frame; `xDir` is the azimuth reference. */
export type DecalSurface =
  | { readonly type: 'cylinder'; readonly origin: Vec3; readonly axis: Vec3; readonly xDir: Vec3; readonly radius: number }
  | { readonly type: 'cone'; readonly apex: Vec3; readonly axis: Vec3; readonly xDir: Vec3; readonly semiAngle: number };

export interface DecalMask {
  readonly width: number;
  readonly height: number;
  readonly bits: string;
}
