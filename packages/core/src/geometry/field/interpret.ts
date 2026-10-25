/**
 * TS interpreter of a FieldProgram: point values and forward-mode gradients (05 IMP TR-IMP-01). f64 throughout, one pass over the tape per point.
 * @invariant NaN results are returned as is; callers (engine) count them and treat the sample as outside
 * @invariant the semantics of every op are the table in `program.ts` (`OP_ARITY`); the native crate implements the same table
 */

import type { FieldOp, FieldProgram } from './program';
import { programError } from './program';
import { type MeshSdf, prepareMeshSdf } from './meshSdf';
import { type StrutEvaluator, prepareStrutSet } from './strutSet';

export interface PreparedProgram {
  readonly program: FieldProgram;
  readonly opcodes: Uint8Array;
  /** Five operand slots per instruction (unused slots are -1). */
  readonly operands: Int32Array;
  readonly struts: readonly StrutEvaluator[];
  readonly meshes: readonly MeshSdf[];
}

export const OPS: readonly FieldOp[] = [
  'const',
  'x',
  'y',
  'z',
  'add',
  'sub',
  'mul',
  'div',
  'neg',
  'abs',
  'min',
  'max',
  'sqrt',
  'square',
  'sin',
  'cos',
  'atan2',
  'floor',
  'fract',
  'clamp',
  'select',
  'smin_quad',
  'smin_exp',
  'chamfer_min',
  'mesh_sdf',
  'strut_set',
];
const CODE: Readonly<Record<FieldOp, number>> = Object.fromEntries(OPS.map((op, index) => [op, index])) as Record<FieldOp, number>;
export const SLOTS = 5;
const SQRT_HALF = Math.SQRT1_2;

const cache = new WeakMap<FieldProgram, PreparedProgram>();

/** Decode `program` once (operand tables, strut evaluators, mesh BVHs); throws on a malformed tape (callers validate with `programError` first). */
export function prepareProgram(program: FieldProgram): PreparedProgram {
  const known = cache.get(program);
  if (known !== undefined) return known;
  const reason = programError(program);
  if (reason !== null) throw new Error(`invalid field program: ${reason}`);
  const opcodes = new Uint8Array(program.instructions.length);
  const operands = new Int32Array(program.instructions.length * SLOTS).fill(-1);
  program.instructions.forEach((instruction, index) => {
    opcodes[index] = CODE[instruction.op];
    instruction.args.forEach((arg, slot) => {
      operands[index * SLOTS + slot] = arg;
    });
  });
  const prepared: PreparedProgram = {
    program,
    opcodes,
    operands,
    struts: program.strutSets.map(prepareStrutSet),
    meshes: program.meshes.map((entry) => prepareMeshSdf(entry.mesh)),
  };
  cache.set(program, prepared);
  return prepared;
}

export function smoothMinQuad(a: number, b: number, k: number): number {
  const m = Math.min(a, b);
  if (!(k > 0)) return m;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return m - (h * h * k) / 4;
}

export function smoothMinExp(a: number, b: number, k: number): number {
  const m = Math.min(a, b);
  if (!(k > 0)) return m;
  return m - k * Math.log(1 + Math.exp(-Math.abs(a - b) / k));
}

export const chamferMin = (a: number, b: number, k: number): number => Math.min(Math.min(a, b), (a + b - k) * SQRT_HALF);

/** Arithmetic ops on scalars (the semantics table of program.ts); the single definition shared by the interpreter and the builder's constant folding. */
export function scalarOp(op: FieldOp, a: number, b: number, c: number): number {
  switch (op) {
    case 'add':
      return a + b;
    case 'sub':
      return a - b;
    case 'mul':
      return a * b;
    case 'div':
      return a / b;
    case 'neg':
      return -a;
    case 'abs':
      return Math.abs(a);
    case 'min':
      return Math.min(a, b);
    case 'max':
      return Math.max(a, b);
    case 'sqrt':
      return Math.sqrt(a);
    case 'square':
      return a * a;
    case 'sin':
      return Math.sin(a);
    case 'cos':
      return Math.cos(a);
    case 'atan2':
      return Math.atan2(a, b);
    case 'floor':
      return Math.floor(a);
    case 'fract':
      return a - Math.floor(a);
    case 'clamp':
      return Math.min(Math.max(a, b), c);
    case 'select':
      return a < 0 ? b : c;
    case 'smin_quad':
      return smoothMinQuad(a, b, c);
    case 'smin_exp':
      return smoothMinExp(a, b, c);
    case 'chamfer_min':
      return chamferMin(a, b, c);
    default:
      return NaN;
  }
}

const OP_CONST = CODE.const;
const OP_X = CODE.x;
const OP_Y = CODE.y;
const OP_Z = CODE.z;
const OP_ADD = CODE.add;
const OP_SUB = CODE.sub;
const OP_MUL = CODE.mul;
const OP_DIV = CODE.div;
const OP_NEG = CODE.neg;
const OP_ABS = CODE.abs;
const OP_MIN = CODE.min;
const OP_MAX = CODE.max;
const OP_SQRT = CODE.sqrt;
const OP_SQUARE = CODE.square;
const OP_SIN = CODE.sin;
const OP_COS = CODE.cos;
const OP_MESH_SDF = CODE.mesh_sdf;
const OP_STRUT_SET = CODE.strut_set;

/**
 * Value of the output register at (x, y, z); registers is scratch of at least one double per instruction.
 * @invariant dispatches on the integer opcode (the hot loop of every field sample); the common ops are inlined, the rest go through `scalarOp`
 */
export function evaluateAt(prepared: PreparedProgram, registers: Float64Array, x: number, y: number, z: number): number {
  const { opcodes, operands, program } = prepared;
  const constants = program.constants;
  const count = opcodes.length;
  for (let i = 0; i < count; i += 1) {
    const base = i * SLOTS;
    const a = registers[operands[base] as number] as number;
    const b = registers[operands[base + 1] as number] as number;
    const c = registers[operands[base + 2] as number] as number;
    const code = opcodes[i] as number;
    switch (code) {
      case OP_CONST:
        registers[i] = constants[operands[base] as number] as number;
        break;
      case OP_X:
        registers[i] = x;
        break;
      case OP_Y:
        registers[i] = y;
        break;
      case OP_Z:
        registers[i] = z;
        break;
      case OP_ADD:
        registers[i] = a + b;
        break;
      case OP_SUB:
        registers[i] = a - b;
        break;
      case OP_MUL:
        registers[i] = a * b;
        break;
      case OP_DIV:
        registers[i] = a / b;
        break;
      case OP_NEG:
        registers[i] = -a;
        break;
      case OP_ABS:
        registers[i] = Math.abs(a);
        break;
      case OP_MIN:
        registers[i] = Math.min(a, b);
        break;
      case OP_MAX:
        registers[i] = Math.max(a, b);
        break;
      case OP_SQRT:
        registers[i] = Math.sqrt(a);
        break;
      case OP_SQUARE:
        registers[i] = a * a;
        break;
      case OP_SIN:
        registers[i] = Math.sin(a);
        break;
      case OP_COS:
        registers[i] = Math.cos(a);
        break;
      case OP_MESH_SDF:
        registers[i] = prepared.meshes[operands[base + 3] as number]?.distance(a, b, c) ?? Infinity;
        break;
      case OP_STRUT_SET: {
        const radiusRegister = operands[base + 4] as number;
        registers[i] =
          prepared.struts[operands[base + 3] as number]?.distance(
            a,
            b,
            c,
            radiusRegister >= 0 ? (registers[radiusRegister] as number) : -1,
          ) ?? Infinity;
        break;
      }
      default:
        registers[i] = scalarOp(OPS[code] ?? 'const', a, b, c);
    }
  }
  return registers[program.output] as number;
}

/** Values at points (flat xyz). */
export function evaluatePoints(prepared: PreparedProgram, points: Float64Array): Float64Array {
  const registers = new Float64Array(prepared.opcodes.length);
  const out = new Float64Array(points.length / 3);
  for (let p = 0; p < out.length; p += 1)
    out[p] = evaluateAt(prepared, registers, points[3 * p] as number, points[3 * p + 1] as number, points[3 * p + 2] as number);
  return out;
}
