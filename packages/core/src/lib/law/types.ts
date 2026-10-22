/** Scalar laws over the arc-length fraction t in [0, 1] of a path (twist, scale, area, stretch, pitch): pure data, no model types. */

export type ScalarLaw =
  | { readonly type: 'constant'; readonly value: number }
  | { readonly type: 'linear'; readonly start: number; readonly end: number }
  | { readonly type: 's_curve'; readonly start: number; readonly end: number }
  | {
      readonly type: 'table';
      readonly points: ReadonlyArray<readonly [number, number]>;
      readonly startSlope?: number;
      readonly endSlope?: number;
    }
  | { readonly type: 'expression'; readonly expression: string };

/** Variables an `expression` law may use: t (0..1), s (arc length from the start) and L (total length). */
export const LAW_VARIABLES: readonly string[] = ['t', 's', 'L'];

/** A refused law: stable code, the failing sample (when it is one) and a message. */
export interface LawIssue {
  readonly code: 'SWG_LAW_INVALID' | 'SWG_LAW_NONPOSITIVE';
  readonly message: string;
  readonly t?: number;
}
