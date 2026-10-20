/**
 * Composite laminate definitions (aerospace 06 CMP §3), owned by the `composites` plugin of `@aero` (`CadDocument.composites`, validated by its
 * `DocumentExtension`). Lengths are document units, angles degrees, stresses MPa (mm documents). Stacking runs bottom (tool side) to top.
 * A part's 2D frame is the DEVELOPED frame of its tool face (plane: face frame; cylinder: (arc length, axial); cone: polar development about the apex),
 * so zone and ply polygons are flat-pattern coordinates and a flat pattern is the polygon itself.
 */

import type { NurbsSurfaceData } from '../lib/nurbs/surfaceTypes';
import type { Vec2, Vec3 } from './vectors';

type LaminaForm = 'ud_tape' | 'woven' | 'core_honeycomb' | 'core_foam';
type AllowableBasis = 'mean' | 'b_basis' | 'a_basis' | 'unknown';

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
  /** Coefficients of thermal expansion along / across the fibre, 1/K. */
  readonly alpha1?: number;
  readonly alpha2?: number;
  /** Moisture swelling strains along / across the fibre per unit moisture content (mass fraction). */
  readonly beta1?: number;
  readonly beta2?: number;
  /** Mode I / II fracture toughness, N/mm (LaRC03 matrix tension: g = GIc / GIIc). */
  readonly GIc?: number;
  readonly GIIc?: number;
  readonly basis: AllowableBasis;
  readonly source: string;
}

type RosetteMethod = 'translational' | 'cylindrical' | 'radial' | 'edge';

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

interface FaceRef {
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
    }
  /**
   * Hemispherical cap about the pole direction `axis`. Chart = azimuthal equidistant projection about the pole (flat radius = radius * polar
   * angle, flat angle = azimuth from `xDir` about `axis`): exact distances along meridians. Doubly curved, so plies need drape.
   */
  | { readonly type: 'sphere'; readonly center: Vec3; readonly axis: Vec3; readonly xDir: Vec3; readonly radius: number }
  /**
   * A nurbs_surface sheet in world coordinates (copied at part creation). Chart = ((u - u0) * scale[0], (v - v0) * scale[1]) where scale is the
   * arc length of the mid iso-curve per unit parameter (metric at the patch centre). Positive normal = Su x Sv. Doubly curved: plies need drape.
   */
  | {
      readonly type: 'nurbs';
      readonly surface: NurbsSurfaceData;
      readonly domain: readonly [readonly [number, number], readonly [number, number]];
      readonly scale: readonly [number, number];
    };

export type PlyBoundary =
  | { readonly kind: 'whole_face' }
  /** Pieces in the part's 2D frame (union implied); every piece is a simple counter-clockwise polygon. */
  | { readonly kind: 'polygons'; readonly polygons: readonly (readonly Vec2[])[] };

export interface PlyDrape {
  readonly method: 'developable' | 'projection' | 'kinematic';
  /** Fishnet cell size, document length units (default: automatic). */
  readonly stepLength?: number;
  /** Chart point where the drape starts. */
  readonly seed?: Vec2;
  /** Allow flat patterns over the locking angle. */
  readonly allowOverLock?: boolean;
}

export interface PlyCut {
  readonly kind: 'dart' | 'splice';
  /** Chart polyline; ends beyond the ply boundary are clipped to it. */
  readonly path: readonly Vec2[];
  /** Splice overlap (document length units): the piece on the left of the path direction grows by this over the other piece. */
  readonly overlap?: number;
}

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
  /** Drape settings: 'kinematic' (fishnet) is the default on doubly curved faces; `seed` is a chart point (default: the face centre / pole). */
  readonly drape?: PlyDrape;
  /** Cuts that divide the boundary into pieces (darts to an interior point, splices across the ply), chart polylines. */
  readonly cuts?: readonly PlyCut[];
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

/** One ply of a shell section: material name in `CompositesModel.materials`, cured thickness (document units) and angle (degrees from the section x axis). */
interface SectionPly {
  readonly material: string;
  readonly thickness: number;
  readonly angleDeg: number;
}

/**
 * A laminate shell section for analysis hand-off (05 FEA reads it; plies run from the tool side, +z along the laminate normal).
 * @invariant `thickness` = sum of ply thicknesses; angles are relative to the part rosette 0-degree direction
 */
export interface LaminateSection {
  readonly id: string;
  readonly partId: string;
  readonly name: string;
  /** Zone the section was sampled for (absent: the whole part). */
  readonly zoneId?: string;
  readonly plies: readonly SectionPly[];
  readonly thickness: number;
  /** Side of the tool face the laminate lies on. */
  readonly laminateSide: 'positive_normal' | 'negative_normal';
}

/** A sandwich core region of a part: lies on top of the plies with stacking order below `afterOrder`; thickness ramps linearly at the edge. */
export interface CoreRegion {
  readonly id: string;
  readonly partId: string;
  readonly name: string;
  /** Chart polygon, counter-clockwise. */
  readonly boundary: readonly Vec2[];
  /** Name of a core_honeycomb / core_foam lamina record (its density gives the mass). */
  readonly materialName: string;
  /** Full thickness, document length units. */
  readonly thickness: number;
  /** Chamfer angle between the tool face and the sloped edge, degrees in (0, 90]. */
  readonly chamferAngle: number;
  /** Plies with stacking order below this sit under the core. */
  readonly afterOrder: number;
}

export interface CompositesModel {
  /** Core regions (`add_core`); absent until the first one. */
  readonly cores?: Record<string, CoreRegion>;
  /** Analysis hand-off sections (`create_laminate_sections`); absent until the first one. */
  readonly sections?: Record<string, LaminateSection>;
  readonly materials: Record<string, LaminaMaterial>;
  readonly rosettes: Record<string, Rosette>;
  readonly parts: Record<string, CompositePart>;
  readonly zones: Record<string, Zone>;
  readonly plies: Record<string, Ply>;
  readonly plyOrder: readonly string[];
  readonly waivers: Record<string, LayupWaiver>;
}
