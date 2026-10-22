import type { Vec3 } from './vectors';

/**
 * Text decal projected onto its solid along `-normal` (paint: shown and exported to glTF, not a solid). All vectors are in the owning
 * entity's local frame (before its rotation / position).
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
}
