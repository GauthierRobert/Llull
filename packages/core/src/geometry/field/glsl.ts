/**
 * FieldProgram -> GLSL (05 IMP 14.x GPU preview): the SSA tape as one straight-line `float fieldAt(float x, float y, float z)` plus the constants as a
 * uniform array, so a parameter drag that keeps the tape's structure only uploads new uniforms and never recompiles the shader.
 * @invariant the emitted arithmetic is the table of `program.ts` (`OP_ARITY`) in single precision; `sqrt` and `div` follow GLSL (sqrt of a negative is clamped to 0)
 * @invariant unsupported ops (mesh_sdf, strut_set, sample_field), an unbounded support box and an over-long tape are refused by NAME; the caller keeps the mesh preview then
 * @invariant `key` is a hash of the tape structure (ops, operands, constant count): equal keys = same shader, only `constants` differ
 */

import type { Vec3 } from '../../model/types';
import { type FieldOp, type FieldProgram, type FieldQuality, programError } from './program';

/** Longest tape the preview compiles (drivers slow down sharply on very long straight-line functions). */
export const MAX_GLSL_INSTRUCTIONS = 4000;

const UNSUPPORTED_OPS: ReadonlySet<FieldOp> = new Set<FieldOp>(['mesh_sdf', 'strut_set', 'sample_field']);

export interface GlslField {
  readonly ok: true;
  /** GLSL declarations: helper functions, `uniform vec4 uC[...]`, and `float fieldAt(float x, float y, float z)`. */
  readonly source: string;
  /** The constants of the tape padded with zeros to a multiple of 4: the contents of `uC` (4 per vec4). */
  readonly constants: readonly number[];
  readonly key: string;
  readonly instructionCount: number;
  /** Global bound of |grad f|: the ray marcher steps f / lipschitz. */
  readonly lipschitz: number;
  readonly quality: FieldQuality;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
}

export interface GlslUnsupported {
  readonly ok: false;
  /** Names of what blocks the GPU path: op names, `unbounded`, `tape_too_long`, `invalid_program`. */
  readonly unsupported: readonly string[];
}

const HELPERS = `float smin_quad(float a, float b, float k) {
  float m = min(a, b);
  if (!(k > 0.0)) return m;
  float h = max(k - abs(a - b), 0.0) / k;
  return m - h * h * k * 0.25;
}
float smin_exp(float a, float b, float k) {
  float m = min(a, b);
  if (!(k > 0.0)) return m;
  return m - k * log(1.0 + exp(-abs(a - b) / k));
}
float chamfer_min(float a, float b, float k) {
  return min(min(a, b), (a + b - k) * 0.7071067811865476);
}
`;

function hashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** The expression of one instruction over register names `r<i>`; `c` reads constant `index` from the uniform array. */
function expression(op: FieldOp, a: readonly string[], constant: (index: number) => string, args: readonly number[]): string {
  switch (op) {
    case 'const':
      return constant(args[0] as number);
    case 'x':
      return 'x';
    case 'y':
      return 'y';
    case 'z':
      return 'z';
    case 'add':
      return `${a[0]} + ${a[1]}`;
    case 'sub':
      return `${a[0]} - ${a[1]}`;
    case 'mul':
      return `${a[0]} * ${a[1]}`;
    case 'div':
      return `${a[0]} / ${a[1]}`;
    case 'neg':
      return `-${a[0]}`;
    case 'abs':
      return `abs(${a[0]})`;
    case 'min':
      return `min(${a[0]}, ${a[1]})`;
    case 'max':
      return `max(${a[0]}, ${a[1]})`;
    case 'sqrt':
      return `sqrt(max(${a[0]}, 0.0))`;
    case 'square':
      return `${a[0]} * ${a[0]}`;
    case 'sin':
      return `sin(${a[0]})`;
    case 'cos':
      return `cos(${a[0]})`;
    case 'atan2':
      return `atan(${a[0]}, ${a[1]})`;
    case 'floor':
      return `floor(${a[0]})`;
    case 'fract':
      return `${a[0]} - floor(${a[0]})`;
    case 'clamp':
      return `min(max(${a[0]}, ${a[1]}), ${a[2]})`;
    case 'select':
      return `(${a[0]} < 0.0 ? ${a[1]} : ${a[2]})`;
    case 'smin_quad':
      return `smin_quad(${a[0]}, ${a[1]}, ${a[2]})`;
    case 'smin_exp':
      return `smin_exp(${a[0]}, ${a[1]}, ${a[2]})`;
    case 'chamfer_min':
      return `chamfer_min(${a[0]}, ${a[1]}, ${a[2]})`;
    default:
      return '0.0';
  }
}

/** Number of vec4 slots the constants need. */
const slotsFor = (count: number): number => Math.max(1, Math.ceil(count / 4));

/**
 * Compile `program` for the GPU preview, or name what blocks it.
 * @failure an unsupported op, no support box, a tape over MAX_GLSL_INSTRUCTIONS, a malformed tape -> `{ ok: false, unsupported }`
 */
export function compileFieldToGlsl(program: FieldProgram): GlslField | GlslUnsupported {
  if (programError(program) !== null) return { ok: false, unsupported: ['invalid_program'] };
  const blocked: string[] = [...new Set(program.instructions.map((instruction) => instruction.op).filter((op) => UNSUPPORTED_OPS.has(op)))];
  if (program.bounds === null) blocked.push('unbounded');
  if (program.instructions.length > MAX_GLSL_INSTRUCTIONS) blocked.push('tape_too_long');
  if (blocked.length > 0 || program.bounds === null) return { ok: false, unsupported: blocked };
  const slots = slotsFor(program.constants.length);
  const constant = (index: number): string => `uC[${index >> 2}].${'xyzw'[index & 3]}`;
  const lines = program.instructions.map((instruction, index) => {
    const names = instruction.args.map((arg) => `r${arg}`);
    return `  float r${index} = ${expression(instruction.op, names, constant, instruction.args)};`;
  });
  const source = [
    HELPERS,
    `uniform vec4 uC[${slots}];`,
    'float fieldAt(float x, float y, float z) {',
    ...lines,
    `  return r${program.output};`,
    '}',
    '',
  ].join('\n');
  const padded = [...program.constants.map((value) => Math.fround(Math.max(-3.4e38, Math.min(3.4e38, Number.isNaN(value) ? 0 : value))))];
  while (padded.length < slots * 4) padded.push(0);
  const structure = program.instructions.map((instruction) => `${instruction.op}:${instruction.args.join(',')}`).join(';');
  return {
    ok: true,
    source,
    constants: padded,
    key: hashOf(`${structure}|${slots}`),
    instructionCount: program.instructions.length,
    lipschitz: program.lipschitz > 0 ? program.lipschitz : 1,
    quality: program.quality,
    bounds: program.bounds,
  };
}
