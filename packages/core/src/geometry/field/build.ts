/**
 * FieldBuilder: emits a FieldProgram tape with constant folding, common-subexpression sharing and dead-register elimination (05 IMP TR-IMP-01).
 * @invariant equal (op, operands) share one register; an op whose register operands are all constants is folded to a constant (same arithmetic as the interpreter)
 * @invariant `finish` keeps only the registers the output depends on, in their original order
 */

import type { MeshData } from '../../model/types';
import { type FieldInstruction, type FieldOp, type FieldProgram, type FieldQuality, OP_ARITY, type StrutSet } from './program';
import { scalarOp } from './interpret';

export interface ProgramMeta {
  readonly bounds: FieldProgram['bounds'];
  readonly lipschitz: number;
  readonly quality: FieldQuality;
}

const FOLDABLE: ReadonlySet<FieldOp> = new Set<FieldOp>([
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
]);

export class FieldBuilder {
  private readonly instructions: FieldInstruction[] = [];
  private readonly constants: number[] = [];
  private readonly meshes: { key: string; mesh: MeshData }[] = [];
  private readonly strutSets: StrutSet[] = [];
  private readonly shared = new Map<string, number>();

  constructor(private readonly unit: string) {}

  private emit(op: FieldOp, args: readonly number[]): number {
    const key = `${op}:${args.join(',')}`;
    const known = this.shared.get(key);
    if (known !== undefined) return known;
    this.instructions.push({ op, args });
    const index = this.instructions.length - 1;
    this.shared.set(key, index);
    return index;
  }

  /** Register holding the literal `value` (shared). */
  constant(value: number): number {
    let at = this.constants.findIndex((existing) => Object.is(existing, value));
    if (at < 0) {
      this.constants.push(value);
      at = this.constants.length - 1;
    }
    return this.emit('const', [at]);
  }

  x(): number {
    return this.emit('x', []);
  }

  y(): number {
    return this.emit('y', []);
  }

  z(): number {
    return this.emit('z', []);
  }

  private constantValue(register: number): number | null {
    const instruction = this.instructions[register];
    return instruction?.op === 'const' ? (this.constants[instruction.args[0] as number] ?? null) : null;
  }

  /** Emit an arithmetic op on registers (folded when all operands are constants). */
  op(op: FieldOp, ...args: number[]): number {
    if (FOLDABLE.has(op)) {
      const values = args.map((register) => this.constantValue(register));
      if (values.every((value): value is number => value !== null))
        return this.constant(scalarOp(op, values[0] as number, values[1] as number, values[2] as number));
      if (op === 'add' && values[1] === 0) return args[0] as number;
      if (op === 'add' && values[0] === 0) return args[1] as number;
      if (op === 'mul' && values[1] === 1) return args[0] as number;
      if (op === 'mul' && values[0] === 1) return args[1] as number;
    }
    return this.emit(op, args);
  }

  add = (a: number, b: number): number => this.op('add', a, b);
  sub = (a: number, b: number): number => this.op('sub', a, b);
  mul = (a: number, b: number): number => this.op('mul', a, b);
  div = (a: number, b: number): number => this.op('div', a, b);
  neg = (a: number): number => this.op('neg', a);
  abs = (a: number): number => this.op('abs', a);
  min = (a: number, b: number): number => this.op('min', a, b);
  max = (a: number, b: number): number => this.op('max', a, b);
  sqrt = (a: number): number => this.op('sqrt', a);
  square = (a: number): number => this.op('square', a);
  sin = (a: number): number => this.op('sin', a);
  cos = (a: number): number => this.op('cos', a);
  scale = (a: number, factor: number): number => this.mul(a, this.constant(factor));
  shift = (a: number, offset: number): number => this.add(a, this.constant(offset));

  /** Euclidean length of three registers. */
  length3(a: number, b: number, c: number): number {
    return this.sqrt(this.add(this.add(this.square(a), this.square(b)), this.square(c)));
  }

  /** Register of `mesh_sdf(x, y, z)` over a closed mesh (shared by `key`). */
  meshSdf(key: string, mesh: MeshData, x: number, y: number, z: number): number {
    let at = this.meshes.findIndex((entry) => entry.key === key);
    if (at < 0) {
      this.meshes.push({ key, mesh });
      at = this.meshes.length - 1;
    }
    return this.emit('mesh_sdf', [x, y, z, at]);
  }

  /** Register of `strut_set(x, y, z)`; `radius` is a register that replaces the beam radii, or null. */
  strutSet(set: StrutSet, x: number, y: number, z: number, radius: number | null): number {
    this.strutSets.push(set);
    return this.emit('strut_set', [x, y, z, this.strutSets.length - 1, radius ?? -1]);
  }

  /** The program whose output is register `output`; unreachable registers, constants, meshes and strut sets are dropped. */
  finish(output: number, meta: ProgramMeta): FieldProgram {
    const needed = new Set<number>([output]);
    for (let i = output; i >= 0; i -= 1) {
      const instruction = this.instructions[i];
      if (instruction === undefined || !needed.has(i)) continue;
      OP_ARITY[instruction.op].forEach((kind, slot) => {
        const arg = instruction.args[slot] as number;
        if ((kind === 'r' || kind === 'r?') && arg >= 0) needed.add(arg);
      });
    }
    const renumber = new Map<number, number>();
    const constants: number[] = [];
    const meshes: { key: string; mesh: MeshData }[] = [];
    const strutSets: StrutSet[] = [];
    const instructions: FieldInstruction[] = [];
    const remap = <T>(list: T[], source: readonly T[], index: number, cache: Map<number, number>): number => {
      const known = cache.get(index);
      if (known !== undefined) return known;
      list.push(source[index] as T);
      cache.set(index, list.length - 1);
      return list.length - 1;
    };
    const [constantMap, meshMap, strutMap] = [new Map<number, number>(), new Map<number, number>(), new Map<number, number>()];
    this.instructions.forEach((instruction, index) => {
      if (!needed.has(index)) return;
      const args = instruction.args.map((arg, slot) => {
        const kind = OP_ARITY[instruction.op][slot];
        if (kind === 'r' || kind === 'r?') return arg < 0 ? arg : (renumber.get(arg) ?? arg);
        if (kind === 'c') return remap(constants, this.constants, arg, constantMap);
        if (kind === 'm') return remap(meshes, this.meshes, arg, meshMap);
        return remap(strutSets, this.strutSets, arg, strutMap);
      });
      instructions.push({ op: instruction.op, args });
      renumber.set(index, instructions.length - 1);
    });
    return {
      version: 1,
      instructions,
      output: renumber.get(output) ?? 0,
      constants,
      meshes,
      strutSets,
      bounds: meta.bounds,
      lipschitz: meta.lipschitz,
      quality: meta.quality,
      unit: this.unit,
    };
  }
}
