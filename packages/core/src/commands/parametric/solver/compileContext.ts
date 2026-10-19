import type { CadDocument, Constraint, EntityRef } from '../../../model/types';
import { circleOf, lineOf, pointOf, subKindOf, type Layout, type Pt } from './layout';

/** A constraint turned into scalar residual rows over the variable vector. */
export interface Compiled {
  readonly id: string;
  readonly entities: readonly string[];
  readonly rows: number;
  readonly evaluate: (x: Float64Array, out: Float64Array, at: number) => void;
}

/** A constraint the solver cannot use; `soft` errors (value not resolvable yet) are tolerated by the guards. */
export interface CompileFailure {
  readonly error: string;
  readonly soft: boolean;
}

export type CompileOutcome = Compiled | CompileFailure;

/** Everything a kind compiler needs. `x0` is the sketch before solving: it decides branches and fixed anchors. */
export interface CompileContext {
  readonly doc: CadDocument;
  readonly layout: Layout;
  readonly constraint: Constraint;
}

export const fail = (error: string, soft = false): CompileFailure => ({ error, soft });

export const isFailure = (outcome: CompileOutcome): outcome is CompileFailure => 'error' in outcome;

export type PointFn = (x: Float64Array) => Pt;
export type LineFn = (x: Float64Array) => { start: Pt; end: Pt };
export type CircleFn = (x: Float64Array) => { center: Pt; radius: number };

export function pointFn(ctx: CompileContext, ref: EntityRef): PointFn | null {
  return ctx.layout.blocks.has(ref.entityId) ? (x) => pointOf(ctx.layout, x, ref) ?? [0, 0] : null;
}

export function lineFn(ctx: CompileContext, ref: EntityRef): LineFn | null {
  return lineOf(ctx.layout, ctx.layout.x0, ref.entityId)
    ? (x) => lineOf(ctx.layout, x, ref.entityId) ?? { start: [0, 0], end: [1, 0] }
    : null;
}

export function circleFn(ctx: CompileContext, ref: EntityRef): CircleFn | null {
  return circleOf(ctx.layout, ctx.layout.x0, ref.entityId)
    ? (x) => circleOf(ctx.layout, x, ref.entityId) ?? { center: [0, 0], radius: 1 }
    : null;
}

/** True when `a` and `b` both name the same line with no sub-point: the unary "this line" form. */
export function isLineForm(ctx: CompileContext): boolean {
  const { a, b } = ctx.constraint;
  return (
    a.entityId === b.entityId &&
    subKindOf(a) === undefined &&
    subKindOf(b) === undefined &&
    ctx.layout.blocks.get(a.entityId)?.kind === 'line'
  );
}

export function entitiesOf(constraint: Constraint): string[] {
  const ids = [constraint.a.entityId, constraint.b.entityId, ...('axis' in constraint ? [constraint.axis.entityId] : [])];
  return [...new Set(ids)];
}

export function build(ctx: CompileContext, rows: number, evaluate: Compiled['evaluate']): Compiled {
  return { id: ctx.constraint.id, entities: entitiesOf(ctx.constraint), rows, evaluate };
}

export const signOf = (value: number): 1 | -1 => (value < 0 ? -1 : 1);

export const cross = (u: Pt, v: Pt): number => u[0] * v[1] - u[1] * v[0];
export const dot = (u: Pt, v: Pt): number => u[0] * v[0] + u[1] * v[1];

/** Signed distance of `p` from the infinite line through `start` along unit `dir` (left of travel positive). */
export const lineOffset = (start: Pt, dir: Pt, p: Pt): number => cross(dir, [p[0] - start[0], p[1] - start[1]]);
