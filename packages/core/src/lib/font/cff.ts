/**
 * Compact Font Format outlines (OpenType `CFF `, 03 WRP M4, TECHNICAL_SPEC §5.4): INDEX / DICT structure, name-keyed and CID-keyed fonts (FDArray + FDSelect), local and global
 * subroutines and the Type 2 charstring interpreter. A glyph is a list of closed loops of lines and cubic Beziers in font units, y up, outer loops clockwise like TrueType.
 * @invariant a hostile font is bounded: every read goes through `ByteView`, INDEX offsets must be ordered and inside the table, the operand stack is capped at 96, subroutine
 *   calls nest at most 10 deep, a glyph runs at most 200 000 operators and 20 000 points
 * @failure seac (accented-character endchar), arithmetic / storage operators, a stack underflow, a subroutine out of range -> WRP_FONT_PARSE
 */

import type { Vec2 } from '../../model/vectors';
import type { OutlineLoop, OutlineSegment } from './outline';
import { type ByteView, parseError } from './reader';

const MAX_STACK = 96;
const MAX_CALL_DEPTH = 10;
const MAX_OPERATORS = 200_000;
const MAX_POINTS = 20_000;

interface Index {
  readonly count: number;
  /** Absolute [start, end) of each entry in the CFF table. */
  readonly entries: ReadonlyArray<readonly [number, number]>;
  /** Offset just past the INDEX. */
  readonly end: number;
}

function readIndex(table: ByteView, offset: number): Index {
  const count = table.u16(offset);
  if (count === 0) return { count: 0, entries: [], end: offset + 2 };
  const offSize = table.u8(offset + 2);
  if (offSize < 1 || offSize > 4) throw parseError(`CFF: INDEX offset size ${offSize} is not 1..4`);
  const offsetAt = (k: number): number => {
    let value = 0;
    for (let b = 0; b < offSize; b++) value = value * 256 + table.u8(offset + 3 + k * offSize + b);
    return value;
  };
  const base = offset + 3 + (count + 1) * offSize - 1;
  const entries: Array<readonly [number, number]> = [];
  let previous = offsetAt(0);
  if (previous !== 1) throw parseError('CFF: the first INDEX offset must be 1');
  for (let k = 1; k <= count; k++) {
    const next = offsetAt(k);
    if (next < previous || base + next > table.length) throw parseError('CFF: INDEX offsets are not ordered inside the table');
    entries.push([base + previous, base + next]);
    previous = next;
  }
  return { count, entries, end: base + previous };
}

/** Operands of each operator of a DICT; a two-byte operator 12 n is keyed 1200 + n. */
function readDict(table: ByteView, start: number, end: number): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  let operands: number[] = [];
  let i = start;
  while (i < end) {
    const b0 = table.u8(i++);
    if (b0 <= 21) {
      const key = b0 === 12 ? 1200 + table.u8(i++) : b0;
      dict.set(key, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(table.i16(i));
      i += 2;
    } else if (b0 === 29) {
      operands.push(table.u32(i) | 0);
      i += 4;
    } else if (b0 === 30) {
      let text = '';
      for (let done = false; !done && i < end; ) {
        const byte = table.u8(i++);
        for (const nibble of [byte >> 4, byte & 15]) {
          if (nibble === 15) {
            done = true;
            break;
          }
          text +=
            nibble < 10 ? String(nibble) : nibble === 10 ? '.' : nibble === 11 ? 'E' : nibble === 12 ? 'E-' : nibble === 14 ? '-' : '';
        }
      }
      operands.push(Number.parseFloat(text) || 0);
    } else if (b0 >= 32 && b0 <= 246) operands.push(b0 - 139);
    else if (b0 >= 247 && b0 <= 250) operands.push((b0 - 247) * 256 + table.u8(i++) + 108);
    else if (b0 >= 251 && b0 <= 254) operands.push(-(b0 - 251) * 256 - table.u8(i++) - 108);
    else throw parseError(`CFF: DICT byte ${b0} is not an operator or operand`);
  }
  return dict;
}

const bias = (count: number): number => (count < 1240 ? 107 : count < 33900 ? 1131 : 32768);

interface Subrs {
  readonly index: Index;
  readonly bias: number;
}

interface Pen {
  loops: OutlineSegment[][];
  current: OutlineSegment[];
  start: Vec2;
  at: Vec2;
  open: boolean;
  points: number;
}

/** The Type 2 charstring machine of one glyph. */
class Machine {
  readonly stack: number[] = [];
  readonly pen: Pen = { loops: [], current: [], start: [0, 0], at: [0, 0], open: false, points: 0 };
  private operators = 0;
  private stems = 0;
  private widthDone = false;
  done = false;

  constructor(
    private readonly table: ByteView,
    private readonly globals: Subrs,
    private readonly locals: Subrs | null,
  ) {}

  private pop(): number {
    const value = this.stack.pop();
    if (value === undefined) throw parseError('CFF: charstring stack underflow');
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

  private subroutine(subrs: Subrs | null, depth: number): void {
    const number = this.pop();
    if (subrs === null) throw parseError('CFF: subroutine call without subroutines');
    const entry = subrs.index.entries[number + subrs.bias];
    if (entry === undefined) throw parseError('CFF: subroutine number is out of range');
    this.run(entry[0], entry[1], depth + 1);
  }

  private operator(op: number, at: number): number {
    const a = this.stack;
    switch (op) {
      case 1:
      case 3:
      case 18:
      case 23:
        this.takeWidth(a.length % 2 === 1);
        this.stems += a.length >> 1;
        break;
      case 19:
      case 20:
        this.takeWidth(a.length % 2 === 1);
        this.stems += a.length >> 1;
        a.length = 0;
        return at + Math.ceil(this.stems / 8);
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
        if (a.length === 4 || a.length === 5) throw parseError('CFF: seac (accented-character endchar) is not supported');
        this.takeWidth(a.length === 1);
        this.closeContour();
        this.done = true;
        break;
      default:
        throw parseError(`CFF: Type 2 operator ${op} is not supported`);
    }
    a.length = 0;
    return at;
  }

  run(start: number, end: number, depth: number): void {
    if (depth > MAX_CALL_DEPTH) throw parseError('CFF: subroutines nest deeper than 10');
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
        if (this.stack.length >= MAX_STACK) throw parseError('CFF: charstring stack overflow');
        this.stack.push(value);
      } else if (b0 === 10) this.subroutine(this.locals, depth);
      else if (b0 === 29) this.subroutine(this.globals, depth);
      else if (b0 === 11) return;
      else if (b0 === 12) {
        const op = this.table.u8(i++);
        if (op < 34 || op > 37) throw parseError(`CFF: Type 2 operator 12 ${op} is not supported`);
        this.flex(op);
        this.stack.length = 0;
      } else i = this.operator(b0, i);
    }
  }
}

const reverseLoop = (loop: readonly OutlineSegment[]): OutlineSegment[] =>
  [...loop]
    .reverse()
    .map((segment) =>
      segment.kind === 'line'
        ? { kind: 'line', from: segment.to, to: segment.from }
        : segment.kind === 'cubic'
          ? { kind: 'cubic', from: segment.to, control1: segment.control2, control2: segment.control1, to: segment.from }
          : { kind: 'quad', from: segment.to, control: segment.control, to: segment.from },
    );

export interface CffFont {
  readonly glyphCount: number;
  /** Closed loops of glyph `glyph` in font units (outer loops clockwise); throws `FontError` for a hostile charstring. */
  readonly outline: (glyph: number) => readonly OutlineLoop[];
}

function localSubrs(table: ByteView, dict: Map<number, number[]>): Subrs | null {
  const privateRange = dict.get(18);
  if (privateRange === undefined || privateRange.length !== 2) return null;
  const [size, offset] = privateRange as [number, number];
  const privateDict = readDict(table, offset, offset + size);
  const subrs = privateDict.get(19)?.[0];
  if (subrs === undefined) return null;
  const index = readIndex(table, offset + subrs);
  return { index, bias: bias(index.count) };
}

/**
 * The glyph outlines of a `CFF ` table.
 * @failure a table that is not CFF 1.x, an INDEX or DICT that cannot be read, a CID font without its FDSelect -> WRP_FONT_PARSE
 */
export function readCff(table: ByteView): CffFont {
  if (table.u8(0) !== 1) throw parseError(`CFF: major version ${table.u8(0)} is not 1 (CFF2 is not supported)`);
  const names = readIndex(table, table.u8(2));
  const tops = readIndex(table, names.end);
  const strings = readIndex(table, tops.end);
  const globalIndex = readIndex(table, strings.end);
  const globals: Subrs = { index: globalIndex, bias: bias(globalIndex.count) };
  const topEntry = tops.entries[0];
  if (topEntry === undefined) throw parseError('CFF: no Top DICT');
  const top = readDict(table, topEntry[0], topEntry[1]);
  const charStringsAt = top.get(17)?.[0];
  if (charStringsAt === undefined) throw parseError('CFF: the Top DICT has no CharStrings');
  const charStrings = readIndex(table, charStringsAt);
  const fdArray = top.get(1236)?.[0];
  const fdSelect = top.get(1237)?.[0];
  let fontLocals: Array<Subrs | null>;
  let fdOf: (glyph: number) => number = () => 0;
  if (fdArray !== undefined && fdSelect !== undefined) {
    const fonts = readIndex(table, fdArray);
    fontLocals = fonts.entries.map(([start, end]) => localSubrs(table, readDict(table, start, end)));
    const format = table.u8(fdSelect);
    if (format === 0) fdOf = (glyph) => table.u8(fdSelect + 1 + glyph);
    else if (format === 3) {
      const ranges = table.u16(fdSelect + 1);
      fdOf = (glyph) => {
        for (let r = 0; r < ranges; r++) {
          const first = table.u16(fdSelect + 3 + 3 * r);
          const next = table.u16(fdSelect + 3 + 3 * (r + 1));
          if (glyph >= first && glyph < next) return table.u8(fdSelect + 5 + 3 * r);
        }
        throw parseError(`CFF: FDSelect has no font for glyph ${glyph}`);
      };
    } else throw parseError(`CFF: FDSelect format ${format} is not 0 or 3`);
  } else fontLocals = [localSubrs(table, top)];
  return {
    glyphCount: charStrings.count,
    outline: (glyph) => {
      const entry = charStrings.entries[glyph];
      if (entry === undefined) throw parseError(`CFF: glyph ${glyph} is outside 0..${charStrings.count - 1}`);
      const machine = new Machine(table, globals, fontLocals[fdOf(glyph)] ?? null);
      machine.run(entry[0], entry[1], 0);
      machine.finish();
      return machine.pen.loops.filter((loop) => loop.length > 0).map(reverseLoop);
    },
  };
}
