import type { HelixDefinition } from '../lib/helix/types';
import type { ScalarLaw } from '../lib/law/types';
import type { NurbsCurveData } from '../lib/nurbs/types';
import type { NurbsSurfaceData } from '../lib/nurbs/surfaceTypes';
import type { CurveSegment } from './curve';
import type { Vec2, Vec3 } from './vectors';

/** Frame carried along a sweep path (section x along `normal`, y along `binormal`). */
export type SweepOrientation =
  | { readonly mode: 'minimal' }
  | { readonly mode: 'frenet' }
  | { readonly mode: 'fixed'; readonly direction?: Vec3 }
  | { readonly mode: 'binormal'; readonly direction: Vec3 }
  | {
      readonly mode: 'surface';
      /** Copy of the reference sheet (local to the sweep, like the path); the section y axis follows its normal at the foot of the path point. */
      readonly surface: NurbsSurfaceData;
      readonly sourceId?: string;
      /** Largest distance (document units) the path may stray from the sheet before the frame is refused (SWG_SURFACE_TOO_FAR). */
      readonly tolerance: number;
      /** Section y follows the OPPOSITE of the sheet normal (the band stands on the other side of the sheet). */
      readonly flip?: boolean;
    }
  | {
      readonly mode: 'axis_plane';
      /** A point of the axis and its direction, local to the sweep (like the path). */
      readonly axisPoint: Vec3;
      readonly direction: Vec3;
      /** `path`: section coordinates are relative to the path point; `axial`: x = radius from the axis, y = axial offset from the path point's height. */
      readonly sectionFrame: 'path' | 'axial';
    };

/** A rail (guide curve) of a sweep: local copy of the curve and the id it came from. */
export interface SweepRail {
  readonly curve: NurbsCurveData;
  readonly sourceId: string;
}

/** The optional design-intent fields a sweep adds to its path and section (SWG): all absent means the plain twist-free sweep. */
export interface SweepDesign {
  /** How station rings blend along the arc length; absent = 'smooth' (smoothstep). Explicit => evaluated at refined samples, not only path frames. */
  stationBlend?: 'smooth' | 'linear';
  /** Section frame along the path; absent = 'minimal'. */
  orientation?: SweepOrientation;
  /** Rotation of the section about the path tangent, radians, by arc-length fraction. */
  twist?: ScalarLaw;
  /** Uniform section scale (> 0) by arc-length fraction; exclusive with `area`. */
  scale?: ScalarLaw;
  /** Section area (> 0, document units squared) by arc-length fraction; exclusive with `scale`. */
  area?: ScalarLaw;
  /** Extra scale (> 0) of the section x / y axes by arc-length fraction. */
  stretch?: { readonly x?: ScalarLaw; readonly y?: ScalarLaw };
  /** `miter`: the legs of a point path meet at sharp corners with the ring in the bisector plane (no bend); absent = bends of the bend radius. */
  corners?: 'miter';
  /** Largest distance (document units) between the exact fitted faces and the evaluator; absent = the named default (1e-7 x model size). */
  fitTolerance?: number;
  /** 1..2 rails the section follows (local to the sweep): the section anchors are pulled onto them at every station. Exclusive with the laws. */
  rails?: ReadonlyArray<SweepRail>;
  /** What a rail drives: orient (rotation), scale (uniform scale + rotation), stretch (scale along the anchor direction); two rails also translate. Absent = scale. */
  guideMode?: 'orient' | 'scale' | 'stretch';
  /** Two rails: keep the section height, stretching only along the line between the anchors. */
  maintainHeight?: boolean;
  /** Section-coordinate anchor point per rail; absent = the section outline point nearest each rail at the start. */
  anchors?: ReadonlyArray<Vec2>;
  /** Exact helix the path was built from (local to the sweep): the native kernel builds the spine from it, volumes use its exact length. */
  helix?: HelixDefinition;
}

/** Cross-section of a sweep, in the path's start normal plane (x: frame normal, y: binormal). */
export type SweepSection =
  | {
      readonly shape: 'circle';
      readonly radius: number;
      /** Bore radius of a hollow tube; 0 < innerRadius < radius. */
      readonly innerRadius?: number;
    }
  | {
      readonly shape: 'profile';
      /** Closed polygon (tessellation of `curves` when present), >= 3 points. */
      readonly profile: ReadonlyArray<Vec2>;
      readonly curves?: ReadonlyArray<CurveSegment<Vec2>>;
    };

/** One cross-section of a variable sweep at path fraction `at` (0 = start, 1 = end). */
export interface SweepStation {
  readonly at: number;
  readonly ring: ReadonlyArray<Vec2>;
}
