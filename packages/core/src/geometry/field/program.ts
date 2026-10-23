/**
 * FieldProgram: the SSA instruction tape that is the ABI between a field model (the implicit plugin), the TS interpreter and the native
 * `llull-field` crate (05 IMP D2, TR-IMP-01). Domain-free: no plugin concept appears here.
 * @invariant instruction i writes register i; an instruction reads registers with a smaller index only (acyclic by construction)
 * @invariant the output register holds a signed distance-like value: negative inside, positive outside, zero on the surface (document length units)
 */

import type { MeshData, Vec3 } from '../../model/types';

export type FieldOp =
  | 'const'
  | 'x'
  | 'y'
  | 'z'
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'neg'
  | 'abs'
  | 'min'
  | 'max'
  | 'sqrt'
  | 'square'
  | 'sin'
  | 'cos'
  | 'atan2'
  | 'floor'
  | 'fract'
  | 'clamp'
  | 'select'
  | 'smin_quad'
  | 'smin_exp'
  | 'chamfer_min'
  | 'mesh_sdf'
  | 'strut_set';

/** One tape entry. `args` are register indices, except where the op table (`OP_ARITY`) names an operand index or a constant index. */
export interface FieldInstruction {
  readonly op: FieldOp;
  readonly args: readonly number[];
}

/** A beam of a strut set: nodes `a` and `b` (indices into `StrutSet.nodes`), end radii, end cap. */
export interface StrutBeam {
  readonly a: number;
  readonly b: number;
  readonly ra: number;
  readonly rb: number;
  readonly cap: 'sphere' | 'butt';
}

/** Periodic (`cell` + `origin`, nodes cell-local) or explicit (world nodes) beams. */
export interface StrutSet {
  readonly periodic: { readonly cell: Vec3; readonly origin: Vec3 } | null;
  readonly nodes: readonly Vec3[];
  readonly beams: readonly StrutBeam[];
}

export type FieldQuality = 'exact' | 'bound' | 'approximate';

export interface FieldProgram {
  readonly version: 1;
  readonly instructions: readonly FieldInstruction[];
  /** Register holding the field value. */
  readonly output: number;
  readonly constants: readonly number[];
  /** Closed triangle meshes, operands of `mesh_sdf`. */
  readonly meshes: readonly { readonly key: string; readonly mesh: MeshData }[];
  /** Operands of `strut_set`. */
  readonly strutSets: readonly StrutSet[];
  /** Conservative box containing {f <= 0}, or null when unbounded. */
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 } | null;
  /** Global bound of |grad f| (1 for distance-like programs). */
  readonly lipschitz: number;
  readonly quality: FieldQuality;
  /** Document length unit the field is expressed in. */
  readonly unit: string;
}

/**
 * Operand table. `r` = register, `c` = index into `constants`, `m` = index into `meshes`, `s` = index into `strutSets`, `r?` = register or -1.
 * Semantics (f64): add/sub/mul/div IEEE; fract(a) = a - floor(a); atan2(y, x); clamp(v, lo, hi) = min(max(v, lo), hi);
 * select(c, a, b) = a if c < 0 else b; smin_quad(a, b, k) = min(a, b) - h^2 k / 4 with h = max(k - |a - b|, 0) / k (k <= 0: min);
 * smin_exp(a, b, k) = m - k ln(1 + exp(-|a - b| / k)) with m = min(a, b) (k <= 0: min);
 * chamfer_min(a, b, k) = min(min(a, b), (a + b - k) / sqrt 2); mesh_sdf(x, y, z, m) = signed distance to mesh m (generalised winding number
 * sign, negative inside); strut_set(x, y, z, s, radius) = distance to the nearest beam of set s minus its radius at the closest point (beam
 * radius interpolated along the axis; with `radius` >= 0 the register replaces it).
 */
export const OP_ARITY: Readonly<Record<FieldOp, readonly string[]>> = {
  const: ['c'],
  x: [],
  y: [],
  z: [],
  add: ['r', 'r'],
  sub: ['r', 'r'],
  mul: ['r', 'r'],
  div: ['r', 'r'],
  neg: ['r'],
  abs: ['r'],
  min: ['r', 'r'],
  max: ['r', 'r'],
  sqrt: ['r'],
  square: ['r'],
  sin: ['r'],
  cos: ['r'],
  atan2: ['r', 'r'],
  floor: ['r'],
  fract: ['r'],
  clamp: ['r', 'r', 'r'],
  select: ['r', 'r', 'r'],
  smin_quad: ['r', 'r', 'r'],
  smin_exp: ['r', 'r', 'r'],
  chamfer_min: ['r', 'r', 'r'],
  mesh_sdf: ['r', 'r', 'r', 'm'],
  strut_set: ['r', 'r', 'r', 's', 'r?'],
};

/** Why `program` is not a well-formed tape, or null. */
export function programError(program: FieldProgram): string | null {
  const count = program.instructions.length;
  if (program.version !== 1) return `unsupported program version ${String(program.version)}`;
  if (!Number.isInteger(program.output) || program.output < 0 || program.output >= count) return 'output register out of range';
  for (const [index, { op, args }] of program.instructions.entries()) {
    const shape = OP_ARITY[op] as readonly string[] | undefined;
    if (shape === undefined) return `instruction ${index}: unknown op ${String(op)}`;
    if (args.length !== shape.length) return `instruction ${index} (${op}): expected ${shape.length} operands, got ${args.length}`;
    for (const [slot, kind] of shape.entries()) {
      const value = args[slot] ?? -1;
      const limit =
        { r: index, 'r?': index, c: program.constants.length, m: program.meshes.length, s: program.strutSets.length }[kind] ?? 0;
      const lowest = kind === 'r?' ? -1 : 0;
      if (!Number.isInteger(value) || value < lowest || value >= limit)
        return `instruction ${index} (${op}): operand ${slot} = ${value} out of range`;
    }
  }
  return null;
}
