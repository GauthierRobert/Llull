/**
 * Feature program — the language-neutral intermediate form a document is lowered to (featureProgram.ts)
 * before it is emitted as CadQuery, build123d, OpenSCAD or FreeCAD source.
 *
 * @layer core/codegen
 * @invariant every Term's `value` equals the evaluated document geometry; `expression` (identifiers
 *   already mapped through `program.parameters`) is attached only when it evaluates to that value.
 * @invariant features follow featureHistory order; one variable per live solid.
 */

import type { DocumentUnit } from '../model/types';

export interface Term {
  readonly value: number;
  readonly expression?: string;
}

export type Term3 = readonly [Term, Term, Term];
export type Term2 = readonly [Term, Term];
export type Axis = 'x' | 'y' | 'z';

export type ShapeSpec =
  | { readonly kind: 'box'; readonly size: Term3 }
  | { readonly kind: 'cylinder'; readonly radius: Term; readonly height: Term }
  | { readonly kind: 'sphere'; readonly radius: Term }
  | { readonly kind: 'cone'; readonly radius: Term; readonly height: Term }
  | { readonly kind: 'torus'; readonly ringRadius: Term; readonly tubeRadius: Term }
  | { readonly kind: 'wedge'; readonly size: Term3 }
  | {
      readonly kind: 'pyramid';
      readonly baseWidth: Term;
      readonly baseDepth: Term;
      readonly height: Term;
    }
  | { readonly kind: 'extrusion'; readonly profile: readonly Term2[]; readonly depth: Term }
  | {
      readonly kind: 'revolution';
      readonly profile: readonly Term2[];
      readonly axis: Axis;
      readonly angle: Term;
      readonly segments: number;
    }
  /** Fallback for geometry without an analytic form: world-space triangle soup (9 numbers each). */
  | { readonly kind: 'mesh'; readonly positions: readonly number[] };

export interface FeatureBase {
  /** 1-based featureHistory index that produced the feature; null in snapshot mode. */
  readonly step: number | null;
  /** Registry command name that produced the feature (or the entity kind in snapshot mode). */
  readonly command: string;
  readonly variable: string;
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
  | (FeatureBase & {
      readonly op: 'boolean';
      readonly kind: 'union' | 'cut' | 'intersect';
      readonly left: string;
      readonly right: string;
    })
  | (FeatureBase & { readonly op: 'translate'; readonly delta: Term3 })
  | (FeatureBase & { readonly op: 'remove' })
  | (FeatureBase & { readonly op: 'label'; readonly name: string });

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
