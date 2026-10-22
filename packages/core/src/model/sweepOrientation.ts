import type { HelixDefinition } from '../lib/helix/types';
import type { ScalarLaw } from '../lib/law/types';
import type { Vec3 } from './vectors';

/** Frame carried along a sweep path (section x along `normal`, y along `binormal`). */
export type SweepOrientation =
  | { readonly mode: 'minimal' }
  | { readonly mode: 'frenet' }
  | { readonly mode: 'fixed'; readonly direction?: Vec3 }
  | { readonly mode: 'binormal'; readonly direction: Vec3 }
  | {
      readonly mode: 'axis_plane';
      /** A point of the axis and its direction, local to the sweep (like the path). */
      readonly axisPoint: Vec3;
      readonly direction: Vec3;
      /** `path`: section coordinates are relative to the path point; `axial`: x = radius from the axis, y = axial offset from the path point's height. */
      readonly sectionFrame: 'path' | 'axial';
    };

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
  /** Exact helix the path was built from (local to the sweep): the native kernel builds the spine from it, volumes use its exact length. */
  helix?: HelixDefinition;
}
