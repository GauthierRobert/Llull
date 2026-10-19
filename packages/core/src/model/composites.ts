/**
 * Composite laminate definitions (aerospace 06 CMP §3), owned by the `composites` plugin of `@aero` (`CadDocument.composites`, validated by its
 * `DocumentExtension`). Lengths are document units, angles degrees, stresses MPa (mm documents). Stacking runs bottom (tool side) to top.
 * A part's 2D frame is the DEVELOPED frame of its tool face (plane: face frame; cylinder: (arc length, axial); cone: polar development about the apex),
 * so zone and ply polygons are flat-pattern coordinates and a flat pattern is the polygon itself.
 */

import type { Vec2, Vec3 } from './vectors';

export type LaminaForm = 'ud_tape' | 'woven' | 'core_honeycomb' | 'core_foam';
export type AllowableBasis = 'mean' | 'b_basis' | 'a_basis' | 'unknown';

export interface LaminaMaterial {
  readonly name: string;
  readonly form: LaminaForm;
  /** MPa. */
  readonly E1: number;
  readonly E2: number;
  readonly G12: number;
  readonly nu12: number;
  readonly G13?: number;
  readonly G23?: number;
  /** MPa; absent strengths refuse the failure criteria that need them (no default exists). */
  readonly Xt?: number;
  readonly Xc?: number;
  readonly Yt?: number;
  readonly Yc?: number;
  readonly S?: number;
  /** Cured ply thickness, document length units. */
  readonly plyThickness: number;
  /** Mass per unit^3; absent -> laminate_mass is refused. */
  readonly density?: number;
  /** Degrees (fabrics). */
  readonly lockingAngle?: number;
  readonly warningShear?: number;
  readonly tsaiWuF12Star?: number;
  readonly basis: AllowableBasis;
  readonly source: string;
}

export type RosetteMethod = 'translational' | 'cylindrical' | 'radial' | 'edge';

export interface Rosette {
  readonly id: string;
  readonly name: string;
  readonly origin: Vec3;
  /** Unit 0-degree axis, orthogonal to `normal`. */
  readonly axis0: Vec3;
  /** Unit normal. */
  readonly normal: Vec3;
  readonly method: RosetteMethod;
  readonly axis?: Vec3;
}

export interface FaceRef {
  readonly entityId: string;
  readonly faceNear: Vec3;
  readonly faceIndex?: number;
}

/** Developed-frame description of the tool face: the part's 2D frame is the flat pattern of the face. */
export type PartSurface =
  | { readonly type: 'plane'; readonly origin: Vec3; readonly xDir: Vec3; readonly yDir: Vec3; readonly normal: Vec3 }
  | {
      readonly type: 'cylinder';
      /** Point on the axis at flat y = 0. */
      readonly origin: Vec3;
      readonly axis: Vec3;
      /** Direction of azimuth 0 (flat x = 0). */
      readonly xDir: Vec3;
      readonly radius: number;
    }
  | {
      readonly type: 'cone';
      readonly apex: Vec3;
      /** Unit, from the apex into the solid. */
      readonly axis: Vec3;
      readonly xDir: Vec3;
      /** Radians between the axis and the surface. */
      readonly semiAngle: number;
    };

export type PlyBoundary =
  | { readonly kind: 'whole_face' }
  /** Pieces in the part's 2D frame (union implied); every piece is a simple counter-clockwise polygon. */
  | { readonly kind: 'polygons'; readonly polygons: readonly (readonly Vec2[])[] };

export interface Ply {
  readonly id: string;
  readonly name: string;
  readonly partId: string;
  /** Stacking order, 0 = tool side. */
  readonly order: number;
  readonly sequence: string;
  readonly materialName: string;
  /** Degrees from the rosette 0-degree direction, counter-clockwise about the face normal. */
  readonly orientation: number;
  readonly rosetteId: string;
  readonly boundary: PlyBoundary;
  readonly drape?: { readonly method: 'developable' | 'projection' };
  readonly zoneOrigin?: { readonly zoneIds: readonly string[]; readonly dropRank: number };
}

export interface Zone {
  readonly id: string;
  readonly partId: string;
  readonly name: string;
  readonly boundary: readonly Vec2[];
  readonly notation: string;
  /** Expanded, bottom to top, normalised to (-90, 90]. */
  readonly angles: readonly number[];
  readonly priority: number;
}

export interface PlyDropRules {
  readonly rampRatio: number;
  readonly minStagger: number;
  readonly staggerUnit: 'dropped_thickness' | 'length';
  readonly dropOrder: 'inner_first' | 'outer_first';
  readonly coverPlies: number;
}

export interface RuleConfig {
  readonly symmetric: boolean;
  readonly balanced: boolean;
  readonly minFraction: number;
  readonly maxConsecutive: number;
  readonly outerPlusMinus45: boolean;
  readonly maxAngleChange?: number;
  readonly disabled?: readonly { readonly rule: string; readonly justification: string }[];
}

export interface CompositePart {
  readonly id: string;
  readonly name: string;
  readonly toolFaces: readonly FaceRef[];
  readonly laminateSide: 'positive_normal' | 'negative_normal';
  readonly rosetteId: string;
  readonly surface: PartSurface;
  /** Face boundary in the part's 2D frame (counter-clockwise). */
  readonly outline: readonly Vec2[];
  readonly plyDropRules?: PlyDropRules;
  readonly rules?: RuleConfig;
}

export interface LayupWaiver {
  readonly id: string;
  readonly partId: string;
  readonly code: string;
  readonly ids: readonly string[];
  readonly reason: string;
  readonly requestedBy: 'agent' | 'human';
  /** Set only by an approval recorded by a human caller; never by a command parameter. */
  readonly approvalRef?: string;
}

export interface CompositesModel {
  readonly materials: Record<string, LaminaMaterial>;
  readonly rosettes: Record<string, Rosette>;
  readonly parts: Record<string, CompositePart>;
  readonly zones: Record<string, Zone>;
  readonly plies: Record<string, Ply>;
  readonly plyOrder: readonly string[];
  readonly waivers: Record<string, LayupWaiver>;
}
