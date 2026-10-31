/**
 * Feature program — the language-neutral intermediate form a document is lowered to (featureProgram.ts) before it is emitted as CadQuery,
 * build123d, OpenSCAD or FreeCAD source.
 * @invariant every Term's `value` equals the evaluated document geometry; `expression` (identifiers already mapped through
 *   `program.parameters`) is attached only when it evaluates to that value.
 * @invariant features follow featureHistory order; one variable per live solid.
 */

import type { DocumentUnit, Vec3 } from '../model/types';
import type { NurbsCurveData } from '../lib/nurbs/types';
import type { NurbsSurfaceData } from '../lib/nurbs/surfaceTypes';

export interface Term {
  readonly value: number;
  readonly expression?: string;
}

export type Term3 = readonly [Term, Term, Term];
export type Term2 = readonly [Term, Term];
export type Axis = 'x' | 'y' | 'z';

/** One loft section: a wire of straight lines and cubic Béziers (each segment is its 2 or 4 points), or one B-spline curve (+ a straight closing edge). */
export type LoftSection =
  | { readonly kind: 'chain'; readonly segments: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> }
  | { readonly kind: 'bspline'; readonly curve: NurbsCurveData; readonly closing: boolean };

/** Section of a swept solid at the spine start: a circle (centre, normal, radius) or a closed polygon. */
export type PipeSection =
  | { readonly kind: 'circle'; readonly center: Vec3; readonly normal: Vec3; readonly radius: number }
  | { readonly kind: 'polygon'; readonly points: readonly Vec3[] };

/** Value tree of a traced command's params: every number is a Term, so `=expr` parameter bindings survive into the generated code. */
export type ParamTree =
  | { readonly kind: 'term'; readonly term: Term }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'flag'; readonly value: boolean | null }
  | { readonly kind: 'list'; readonly items: readonly ParamTree[] }
  | { readonly kind: 'map'; readonly entries: ReadonlyArray<readonly [string, ParamTree]> };

/** The command a swept solid records in LLULL_TRACE (its params, so `import_code` rebuilds an editable step). */
export interface TracedCall {
  readonly command: 'sweep_profile' | 'loft_sections';
  readonly params: ReadonlyArray<readonly [string, ParamTree]>;
}

/** How generated code builds a sweep / loft (02 SWG): the library's own construction where it maps faithfully, fitted faces otherwise. */
export type SweptBuild =
  /** Sewn B-spline faces (entity-local), closed by planar caps when `cap`; `bore`: faces of a hollow tube's inner solid, cut out. */
  | {
      readonly kind: 'faces';
      readonly faces: readonly NurbsSurfaceData[];
      readonly bore?: readonly NurbsSurfaceData[];
      readonly cap: boolean;
      readonly tolerance: number;
    }
  /** Pipe shell of the section along the spine (segments of 2 / 3 / 4 points: line, arc through, cubic); `mitre`: right-corner transition. `bore`: inner radius. */
  | {
      readonly kind: 'pipe';
      readonly spine: ReadonlyArray<ReadonlyArray<Vec3>>;
      readonly section: PipeSection;
      readonly mitre: boolean;
      readonly bore?: number;
      /** The radius at which sweep_profile refuses (a bend not wider than the section, or the mitre reach exceeding a leg); absent = no limit. */
      readonly limit?: number;
    }
  /** Round section along an exact constant-pitch cylindrical helix (the library's `makeHelix` construction). */
  | {
      readonly kind: 'helix';
      readonly origin: Vec3;
      readonly axis: Vec3;
      readonly xAxis: Vec3;
      readonly radius: number;
      readonly pitch: number;
      readonly turns: number;
      readonly left: boolean;
      readonly startAngle: number;
      readonly section: PipeSection;
      readonly bore?: number;
    }
  /** Thru-sections loft of exact sections (ruled = straight between neighbours). */
  | { readonly kind: 'loft'; readonly sections: readonly LoftSection[]; readonly ruled: boolean };

export type ShapeSpec =
  | { readonly kind: 'box'; readonly size: Term3 }
  | { readonly kind: 'cylinder'; readonly radius: Term; readonly height: Term }
  | { readonly kind: 'sphere'; readonly radius: Term }
  | { readonly kind: 'cone'; readonly radius: Term; readonly height: Term }
  | { readonly kind: 'torus'; readonly ringRadius: Term; readonly tubeRadius: Term }
  | { readonly kind: 'wedge'; readonly size: Term3 }
  | { readonly kind: 'pyramid'; readonly baseWidth: Term; readonly baseDepth: Term; readonly height: Term }
  | { readonly kind: 'extrusion'; readonly profile: readonly Term2[]; readonly depth: Term }
  | {
      readonly kind: 'revolution';
      readonly profile: readonly Term2[];
      readonly axis: Axis;
      readonly angle: Term;
      readonly segments: number;
    }
  /** Catmull-Clark solid over a closed cage (local frame), emitted as exact B-spline patches. */
  | {
      readonly kind: 'subdivision';
      readonly vertices: ReadonlyArray<readonly [number, number, number]>;
      readonly faces: ReadonlyArray<ReadonlyArray<number>>;
      readonly creases: ReadonlyArray<readonly [number, number]>;
      readonly levels: number;
    }
  /**
   * A sweep or loft (02 SWG, entity-local; the solid feature carries the placement). `trace` is the command it records for `import_code`;
   * `fallback` is the world-space triangle soup targets without freeform geometry (OpenSCAD) use instead.
   */
  | {
      readonly kind: 'swept';
      readonly subject: string;
      readonly build: SweptBuild;
      readonly trace?: TracedCall;
      readonly fallback: readonly number[];
    }
  /** Fallback for geometry without an analytic form: world-space triangle soup (9 numbers each); `reason` names why a generator refused an exact form. */
  | { readonly kind: 'mesh'; readonly positions: readonly number[]; readonly reason?: string };

/** Shapes whose fallback triangles (`positions` / `fallback`) are already in world space: the placement must not be applied to them again. */
export const isWorldSpaceShape = (shape: ShapeSpec): shape is Extract<ShapeSpec, { kind: 'mesh' | 'swept' }> =>
  shape.kind === 'mesh' || shape.kind === 'swept';

export interface FeatureBase {
  /** 1-based featureHistory index that produced the feature; null in snapshot mode. */
  readonly step: number | null;
  /** Registry command name that produced the feature (or the entity kind in snapshot mode). */
  readonly command: string;
  readonly variable: string;
}

/** A radius law of one filleted edge as the generated code replays it: the document's law plus the nodes a kernel interpolates (null = plain radii). */
export interface FilletLaw {
  readonly size: number;
  readonly sizeEnd?: number;
  readonly sizes?: ReadonlyArray<{ readonly t: number; readonly size: number }>;
  readonly linear: boolean;
  /** `interpolation: "monotone"`: the nodes are dense samples of the exact monotone curve (OCP interpolates them with its own cubic), and the recorded trace says "monotone". */
  readonly monotone?: boolean;
  readonly nodes: ReadonlyArray<readonly [number, number]> | null;
}

/** The legs of a variable / two-leg chamfer: the first leg runs `size` -> `end`, the second `second` -> `secondEnd`; `lead` = outward normal of the face carrying the first leg (the single listed edge), absent = equal legs; `starts` = kernel start point per edge. */
export interface ChamferLegs {
  readonly end: number;
  readonly second: number;
  readonly secondEnd: number;
  readonly lead?: readonly [number, number, number];
  /** The kernel's start point of each listed edge (the legs run from it); the target's own edge may run the other way. */
  readonly starts: ReadonlyArray<readonly [number, number, number]>;
}

export type Feature =
  | (FeatureBase & {
      readonly op: 'solid';
      readonly shape: ShapeSpec;
      readonly position: Term3;
      /** Euler XYZ in radians (llull convention: Rz applied first, then Ry, then Rx). */
      readonly rotation: Term3;
      readonly color: string;
      readonly name?: string;
    })
  | (FeatureBase & { readonly op: 'boolean'; readonly kind: 'union' | 'cut' | 'intersect'; readonly left: string; readonly right: string })
  /**
   * Round (fillet) or bevel (chamfer) edges of `variable` in place. `edges`: unique-edge indices (OCC map order; [] = all); `near`: each
   * selected edge's mid point, preferred over indices when present (robust to edge-order differences between OCC builds).
   */
  | (FeatureBase & {
      readonly op: 'fillet' | 'chamfer';
      readonly edges: readonly number[];
      readonly near?: ReadonlyArray<readonly [number, number, number]>;
      readonly size: Term;
      /** Fillets only (BLD M1): one radius law per entry of `edges` (start -> end, control points, interpolation); `size` is then the first law's start. */
      readonly laws?: ReadonlyArray<FilletLaw>;
      /** Chamfers only (BLD M5): legs that vary start -> end and / or differ per face (`size` is the first leg at the edge start); absent = a constant symmetric chamfer. */
      readonly legs?: ChamferLegs;
      /** Result triangles (world soup) for targets without fillets (OpenSCAD). */
      readonly mesh?: readonly number[];
    })
  /** Hollow `variable` in place: the solid minus its inward offset by `thickness`. */
  | (FeatureBase & { readonly op: 'shell'; readonly thickness: Term; readonly mesh?: readonly number[] })
  | (FeatureBase & { readonly op: 'translate'; readonly delta: Term3 })
  | (FeatureBase & { readonly op: 'remove' })
  | (FeatureBase & { readonly op: 'label'; readonly name: string })
  /** Comment line (no geometry): the idiomatic library call or attribute a lowered feature stands for (07 FTR holes, threads). */
  | (FeatureBase & { readonly op: 'note'; readonly text: string });

export interface ProgramParameter {
  /** llull parameter name (document key). */
  readonly name: string;
  /** Safe source-code identifier for the parameter. */
  readonly identifier: string;
  readonly value: number;
  /** Defining expression over other parameter identifiers; absent for literals and errors. */
  readonly expression?: string;
}

export interface ProgramOutput {
  readonly variable: string;
  readonly color: string;
  readonly name?: string;
}

export interface FeatureProgram {
  readonly units: DocumentUnit;
  /** `history` = lowered from featureHistory (parametric); `snapshot` = current geometry only. */
  readonly source: 'history' | 'snapshot';
  readonly parameters: readonly ProgramParameter[];
  readonly features: readonly Feature[];
  readonly outputs: readonly ProgramOutput[];
  /** Human/AI-readable notes about steps that could not be expressed analytically. */
  readonly notes: readonly string[];
}
