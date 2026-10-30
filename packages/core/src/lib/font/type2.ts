/**
 * The Type 2 charstring machine (03 WRP M4, TECHNICAL_SPEC §5.4 / §5.5) of CFF 1.x and CFF2: path, hint, arithmetic, storage, `seac`, `vsindex` and `blend` operators.
 * A glyph is a list of closed loops of lines and cubic Beziers in font units.
 * @invariant bounded: operand stack 96 (CFF) / 513 (CFF2), subroutines 10 deep, 200 000 operators, 20 000 points, 96 / 256 stems, every operand finite and under 2^31 in
 *   magnitude, 32 storage cells; `random` is a fixed sequence per glyph (the same glyph always draws the same outline)
 * @failure stack under- or overflow, a missing subroutine, a hint mask past the charstring, division by zero, a square root of a negative number, a seac code without a
 *   standard name, an operator the format does not have, a `blend` with too few operands -> WRP_FONT_PARSE
 */

import type { Vec2 } from '../../model/vectors';
import type { Index } from './cffIndex';
import type { OutlineSegment } from './outline';
import { type ByteView, parseError } from './reader';

const MAX_CALL_DEPTH = 10;
const MAX_OPERATORS = 200_000;
const MAX_POINTS = 20_000;
const MAX_OPERAND = 2 ** 31;
const STORAGE_CELLS = 32;

export interface Subrs {
  readonly index: Index;
  readonly bias: number;
}

/** The interpolation of a CFF2 font at one instance: regions of each variation data subtable and their scalars. */
export interface Blender {
  /** Variation data subtable of the font dict of the glyph (the Private DICT `vsindex`). */
  readonly defaultIndex: number;
  readonly regionCount: (vsindex: number) => number;
  readonly scalars: (vsindex: number) => readonly number[];
}

export interface MachineSetup {
  readonly version: 1 | 2;
  readonly globals: Subrs;
  readonly locals: Subrs | null;
  readonly blender: Blender | null;
}

interface Pen {
  loops: OutlineSegment[][];
  current: OutlineSegment[];
  start: Vec2;
  at: Vec2;
  open: boolean;
  points: number;
}

/** The accent placement of a `seac` ending: character codes of the base and the accent, and the accent's origin relative to the base's. */
export interface Seac {
  readonly adx: number;
  readonly ady: number;
  readonly base: number;
  readonly accent: number;
}

export class Machine {
  readonly stack: number[] = [];
  readonly pen: Pen = { loops: [], current: [], start: [0, 0], at: [0, 0], open: false, points: 0 };
  seac: Seac | null = null;
  done = false;
  private operators = 0;
  private stems = 0;
  private widthDone: boolean;
  private vsindex: number;
  private random = 0x9e3779b9;
  private readonly storage: number[] = new Array<number>(STORAGE_CELLS).fill(0);
  private readonly maxStack: number;
  private readonly maxStems: number;

  constructor(
    private readonly table: ByteView,
    private readonly setup: MachineSetup,
  ) {
    this.widthDone = setup.version === 2;
    this.vsindex = setup.blender?.defaultIndex ?? 0;
    this.maxStack = setup.version === 2 ? 513 : 96;
    this.maxStems = setup.version === 2 ? 256 : 96;
  }

  private push(value: number): void {
    if (this.stack.length >= this.maxStack) throw parseError('CFF: charstring stack overflow');
    if (!Number.isFinite(value) || Math.abs(value) > MAX_OPERAND) throw parseError(`CFF: an operand beyond ±2^31 (${value})`);
    this.stack.push(value);
  }

  private pop(): number {
    const value = this.stack.pop();
    if (value === undefined) throw parseError('CFF: charstring stack underflow');
    return value;
  }

  private popInteger(name: string): number {
    const value = this.pop();
    if (!Number.isInteger(value)) throw parseError(`CFF: ${name} needs an integer (got ${value})`);
    return value;
  }

  private takeWidth(extra: boolean): void {
    if (!this.widthDone && extra) this.stack.shift();
    this.widthDone = true;
  }

  /** Ends the path: a glyph without endchar still closes its last contour. */
  finish(): void {
    this.closeContour();
    this.done = true;
  }

  private closeContour(): void {
    const { pen } = this;
    if (pen.current.length === 0) {
      pen.open = false;
      return;
    }
    if (Math.hypot(pen.at[0] - pen.start[0], pen.at[1] - pen.start[1]) > 1e-9)
      pen.current.push({ kind: 'line', from: pen.at, to: pen.start });
    pen.loops.push(pen.current);
    pen.current = [];
    pen.open = false;
  }

  private moveBy(dx: number, dy: number): void {
    this.closeContour();
    const at: Vec2 = [this.pen.at[0] + dx, this.pen.at[1] + dy];
    this.pen.at = at;
    this.pen.start = at;
    this.pen.open = true;
  }

  private budget(): void {
    if (++this.pen.points > MAX_POINTS) throw parseError(`CFF: more than ${MAX_POINTS} points in one glyph`);
  }

  private open(): void {
    if (!this.pen.open) {
      this.pen.start = this.pen.at;
      this.pen.open = true;
    }
  }

  private lineBy(dx: number, dy: number): void {
    this.open();
    this.budget();
    const to: Vec2 = [this.pen.at[0] + dx, this.pen.at[1] + dy];
    if (dx !== 0 || dy !== 0) this.pen.current.push({ kind: 'line', from: this.pen.at, to });
    this.pen.at = to;
  }

  private curveBy(d: readonly number[]): void {
    this.open();
    this.budget();
    const p0 = this.pen.at;
    const c1: Vec2 = [p0[0] + (d[0] as number), p0[1] + (d[1] as number)];
    const c2: Vec2 = [c1[0] + (d[2] as number), c1[1] + (d[3] as number)];
    const to: Vec2 = [c2[0] + (d[4] as number), c2[1] + (d[5] as number)];
    this.pen.current.push({ kind: 'cubic', from: p0, control1: c1, control2: c2, to });
    this.pen.at = to;
  }

  private alternating(first: 'h' | 'v'): void {
    const a = this.stack;
    let horizontal = first === 'h';
    for (let k = 0; a.length - k >= 4; k += 4) {
      const last = a.length - k === 5;
      const extra = last ? (a[k + 4] as number) : 0;
      this.curveBy(
        horizontal
          ? [a[k] as number, 0, a[k + 1] as number, a[k + 2] as number, extra, a[k + 3] as number]
          : [0, a[k] as number, a[k + 1] as number, a[k + 2] as number, a[k + 3] as number, extra],
      );
      horizontal = !horizontal;
    }
  }

  private lineAlternating(first: 'h' | 'v'): void {
    let horizontal = first === 'h';
    for (const value of this.stack) {
      this.lineBy(horizontal ? value : 0, horizontal ? 0 : value);
      horizontal = !horizontal;
    }
  }

  /** A charstring operator with fewer operands than it consumes is malformed: refuse it rather than draw from missing numbers. */
  private need(minimum: number, name: string): void {
    if (this.stack.length < minimum) throw parseError(`CFF: ${name} needs at least ${minimum} operands (got ${this.stack.length})`);
  }

  private flex(op: number): void {
    this.need(op === 34 ? 7 : op === 35 ? 12 : op === 36 ? 9 : 11, `flex operator 12 ${op}`);
    const a = this.stack;
    const n = (k: number): number => a[k] as number;
    if (op === 34) {
      this.curveBy([n(0), 0, n(1), n(2), n(3), 0]);
      this.curveBy([n(4), 0, n(5), -n(2), n(6), 0]);
    } else if (op === 35) {
      this.curveBy(a.slice(0, 6));
      this.curveBy(a.slice(6, 12));
    } else if (op === 36) {
      this.curveBy([n(0), n(1), n(2), n(3), n(4), 0]);
      this.curveBy([n(5), 0, n(6), n(7), n(8), -(n(1) + n(3) + n(7))]);
    } else {
      const sumX = n(0) + n(2) + n(4) + n(6) + n(8);
      const sumY = n(1) + n(3) + n(5) + n(7) + n(9);
      this.curveBy(a.slice(0, 6));
      this.curveBy(Math.abs(sumX) > Math.abs(sumY) ? [...a.slice(6, 10), n(10), -sumY] : [...a.slice(6, 10), -sumX, n(10)]);
    }
  }

  /** Operators 12 3..12 30 of Type 2: arithmetic, storage and stack handling. They leave the rest of the stack in place. */
  private arithmetic(op: number): void {
    switch (op) {
      case 3: {
        const y = this.pop();
        this.push(this.pop() !== 0 && y !== 0 ? 1 : 0);
        break;
      }
      case 4: {
        const y = this.pop();
        this.push(this.pop() !== 0 || y !== 0 ? 1 : 0);
        break;
      }
      case 5:
        this.push(this.pop() === 0 ? 1 : 0);
        break;
      case 9:
        this.push(Math.abs(this.pop()));
        break;
      case 10: {
        const y = this.pop();
        this.push(this.pop() + y);
        break;
      }
      case 11: {
        const y = this.pop();
        this.push(this.pop() - y);
        break;
      }
      case 12: {
        const y = this.pop();
        if (y === 0) throw parseError('CFF: div by zero');
        this.push(this.pop() / y);
        break;
      }
      case 14:
        this.push(-this.pop());
        break;
      case 15: {
        const y = this.pop();
        this.push(this.pop() === y ? 1 : 0);
        break;
      }
      case 18:
        this.pop();
        break;
      case 20: {
        const cell = this.popInteger('put');
        const value = this.pop();
        if (cell < 0 || cell >= STORAGE_CELLS) throw parseError(`CFF: put cell ${cell} is outside 0..${STORAGE_CELLS - 1}`);
        this.storage[cell] = value;
        break;
      }
      case 21: {
        const cell = this.popInteger('get');
        if (cell < 0 || cell >= STORAGE_CELLS) throw parseError(`CFF: get cell ${cell} is outside 0..${STORAGE_CELLS - 1}`);
        this.push(this.storage[cell] as number);
        break;
      }
      case 22: {
        const v2 = this.pop();
        const v1 = this.pop();
        const s2 = this.pop();
        const s1 = this.pop();
        this.push(v1 <= v2 ? s1 : s2);
        break;
      }
      case 23:
        this.random = (Math.imul(this.random, 1664525) + 1013904223) >>> 0;
        this.push((this.random + 1) / 4294967296);
        break;
      case 24: {
        const y = this.pop();
        this.push(this.pop() * y);
        break;
      }
      case 26: {
        const x = this.pop();
        if (x < 0) throw parseError('CFF: sqrt of a negative number');
        this.push(Math.sqrt(x));
        break;
      }
      case 27: {
        const x = this.pop();
        this.push(x);
        this.push(x);
        break;
      }
      case 28: {
        const y = this.pop();
        const x = this.pop();
        this.push(y);
        this.push(x);
        break;
      }
      case 29: {
        const k = Math.max(0, this.popInteger('index'));
        const value = this.stack[this.stack.length - 1 - k];
        if (value === undefined) throw parseError(`CFF: index ${k} reaches below the stack`);
        this.push(value);
        break;
      }
      case 30: {
        const shift = this.popInteger('roll');
        const count = this.popInteger('roll');
        if (count < 0 || count > this.stack.length) throw parseError(`CFF: roll of ${count} values on a stack of ${this.stack.length}`);
        if (count > 0) {
          const top = this.stack.splice(this.stack.length - count, count);
          const by = ((shift % count) + count) % count;
          for (let k = 0; k < count; k++) this.stack.push(top[(k - by + count) % count] as number);
        }
        break;
      }
      default:
        throw parseError(`CFF: Type 2 operator 12 ${op} is not supported`);
    }
  }

  /** CFF2 `blend`: n default values followed by n * regions deltas and then n; the stack keeps the n interpolated values. */
  private blend(): void {
    const { blender } = this.setup;
    const n = this.popInteger('blend');
    if (n < 0) throw parseError(`CFF: blend of ${n} values`);
    const regions = blender === null ? (this.vsindex === 0 ? 0 : -1) : blender.regionCount(this.vsindex);
    if (regions < 0) throw parseError(`CFF: vsindex ${this.vsindex} is outside the font's variation data`);
    const base = this.stack.length - n * (regions + 1);
    if (base < 0)
      throw parseError(`CFF: blend of ${n} values with ${regions} regions needs ${n * (regions + 1)} operands (got ${this.stack.length})`);
    const scalars = blender === null ? [] : blender.scalars(this.vsindex);
    for (let k = 0; k < n; k++) {
      let value = this.stack[base + k] as number;
      for (let r = 0; r < regions; r++) value += (scalars[r] as number) * (this.stack[base + n + k * regions + r] as number);
      this.stack[base + k] = value;
    }
    this.stack.length = base + n;
  }

  private subroutine(subrs: Subrs | null, depth: number): void {
    const number = this.pop();
    if (subrs === null) throw parseError('CFF: subroutine call without subroutines');
    const entry = subrs.index.entries[number + subrs.bias];
    if (entry === undefined) throw parseError('CFF: subroutine number is out of range');
    this.run(entry[0], entry[1], depth + 1);
  }

  private countStems(): void {
    this.stems += this.stack.length >> 1;
    if (this.stems > this.maxStems) throw parseError(`CFF: more than ${this.maxStems} stem hints`);
  }

  private operator(op: number, at: number, end: number): number {
    const a = this.stack;
    switch (op) {
      case 1:
      case 3:
      case 18:
      case 23:
        this.takeWidth(a.length % 2 === 1);
        this.countStems();
        break;
      case 19:
      case 20: {
        this.takeWidth(a.length % 2 === 1);
        this.countStems();
        a.length = 0;
        const next = at + Math.ceil(this.stems / 8);
        if (next > end) throw parseError(`CFF: a hint mask of ${Math.ceil(this.stems / 8)} bytes runs past the end of its charstring`);
        return next;
      }
      case 21:
        this.takeWidth(a.length > 2);
        this.need(2, 'rmoveto');
        this.moveBy(a[0] as number, a[1] as number);
        break;
      case 22:
        this.takeWidth(a.length > 1);
        this.need(1, 'hmoveto');
        this.moveBy(a[0] as number, 0);
        break;
      case 4:
        this.takeWidth(a.length > 1);
        this.need(1, 'vmoveto');
        this.moveBy(0, a[0] as number);
        break;
      case 5:
        this.need(2, 'rlineto');
        for (let k = 0; k + 1 < a.length; k += 2) this.lineBy(a[k] as number, a[k + 1] as number);
        break;
      case 6:
        this.need(1, 'hlineto');
        this.lineAlternating('h');
        break;
      case 7:
        this.need(1, 'vlineto');
        this.lineAlternating('v');
        break;
      case 8:
        this.need(6, 'rrcurveto');
        for (let k = 0; k + 5 < a.length; k += 6) this.curveBy(a.slice(k, k + 6));
        break;
      case 24: {
        this.need(8, 'rcurveline');
        const curves = Math.floor((a.length - 2) / 6) * 6;
        for (let k = 0; k < curves; k += 6) this.curveBy(a.slice(k, k + 6));
        this.lineBy(a[curves] as number, a[curves + 1] as number);
        break;
      }
      case 25: {
        this.need(8, 'rlinecurve');
        const lines = a.length - 6;
        for (let k = 0; k + 1 < lines; k += 2) this.lineBy(a[k] as number, a[k + 1] as number);
        this.curveBy(a.slice(lines, lines + 6));
        break;
      }
      case 26: {
        this.need(4, 'vvcurveto');
        let k = a.length % 4 === 1 ? 1 : 0;
        let dx1 = k === 1 ? (a[0] as number) : 0;
        for (; k + 3 < a.length; k += 4) {
          this.curveBy([dx1, a[k] as number, a[k + 1] as number, a[k + 2] as number, 0, a[k + 3] as number]);
          dx1 = 0;
        }
        break;
      }
      case 27: {
        this.need(4, 'hhcurveto');
        let k = a.length % 4 === 1 ? 1 : 0;
        let dy1 = k === 1 ? (a[0] as number) : 0;
        for (; k + 3 < a.length; k += 4) {
          this.curveBy([a[k] as number, dy1, a[k + 1] as number, a[k + 2] as number, a[k + 3] as number, 0]);
          dy1 = 0;
        }
        break;
      }
      case 30:
        this.need(4, 'vhcurveto');
        this.alternating('v');
        break;
      case 31:
        this.need(4, 'hvcurveto');
        this.alternating('h');
        break;
      case 14:
        if (this.setup.version === 2) throw parseError('CFF: endchar is not a CFF2 operator');
        if (a.length === 4 || a.length === 5) this.accent(a.length === 5);
        else this.takeWidth(a.length === 1);
        this.closeContour();
        this.done = true;
        break;
      default:
        throw parseError(`CFF: Type 2 operator ${op} is not supported`);
    }
    a.length = 0;
    return at;
  }

  /** The deprecated four-operand `endchar` (`adx ady bchar achar`, optionally led by the width): a base glyph and an accent glyph by Standard Encoding code. */
  private accent(withWidth: boolean): void {
    this.takeWidth(withWidth);
    const [adx, ady, base, accent] = this.stack as [number, number, number, number];
    for (const code of [base, accent])
      if (!Number.isInteger(code) || code < 0 || code > 255) throw parseError(`CFF: seac character code ${code} is not 0..255`);
    this.seac = { adx, ady, base, accent };
  }

  run(start: number, end: number, depth: number): void {
    if (depth > MAX_CALL_DEPTH) throw parseError(`CFF: subroutines nest deeper than ${MAX_CALL_DEPTH}`);
    const version = this.setup.version;
    let i = start;
    while (i < end && !this.done) {
      if (++this.operators > MAX_OPERATORS) throw parseError(`CFF: more than ${MAX_OPERATORS} operators in one glyph`);
      const b0 = this.table.u8(i++);
      if (b0 >= 32 || b0 === 28) {
        let value: number;
        if (b0 === 28) {
          value = this.table.i16(i);
          i += 2;
        } else if (b0 <= 246) value = b0 - 139;
        else if (b0 <= 250) value = (b0 - 247) * 256 + this.table.u8(i++) + 108;
        else if (b0 <= 254) value = -(b0 - 251) * 256 - this.table.u8(i++) - 108;
        else {
          value = this.table.i16(i) + this.table.u16(i + 2) / 65536;
          i += 4;
        }
        this.push(value);
      } else if (b0 === 10) this.subroutine(this.setup.locals, depth);
      else if (b0 === 29) this.subroutine(this.setup.globals, depth);
      else if (b0 === 11) return;
      else if (b0 === 15 && version === 2) this.vsindex = this.popInteger('vsindex');
      else if (b0 === 16 && version === 2) this.blend();
      else if (b0 === 12) {
        const op = this.table.u8(i++);
        if (op >= 34 && op <= 37) {
          this.flex(op);
          this.stack.length = 0;
        } else if (version === 2) throw parseError(`CFF: Type 2 operator 12 ${op} is not a CFF2 operator`);
        else if (op === 0) this.stack.length = 0;
        else this.arithmetic(op);
      } else i = this.operator(b0, i, end);
    }
  }
}
