/**
 * Compact Font Format outlines (OpenType `CFF ` and `CFF2`, 03 WRP M4, TECHNICAL_SPEC §5.4 and §5.5): name-keyed and CID-keyed fonts (FDArray + FDSelect), local and
 * global subroutines, `seac` accented glyphs and, for CFF2, the variation store at one instance. The Type 2 interpreter is `type2.ts`. A glyph is a list of closed
 * loops of lines and cubic Beziers in font units, y up, outer loops clockwise like TrueType.
 * @invariant a hostile font is bounded: every read goes through `ByteView`, INDEX offsets must be ordered and inside the table, the interpreter limits of `type2.ts`
 *   hold, a `seac` component is one glyph that is not itself accented
 * @failure a stack underflow, a subroutine out of range, a seac component that is missing, accented or in a CID-keyed font, a CFF2 variation store of another axis count
 *   than fvar, a table that is not CFF 1 or 2 -> WRP_FONT_PARSE
 */

import { readCharset, STANDARD_ENCODING_SID } from './cffEncoding';
import { readDict, readIndex, type Index } from './cffIndex';
import type { OutlineLoop, OutlineSegment } from './outline';
import { type ByteView, parseError } from './reader';
import { Machine, type Blender, type MachineSetup, type OperatorBudget, type Subrs } from './type2';
import { readItemVariationStore, type ItemVariationStore } from './variation';

const bias = (count: number): number => (count < 1240 ? 107 : count < 33900 ? 1131 : 32768);

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

const shifted = (loop: readonly OutlineSegment[], dx: number, dy: number): OutlineSegment[] => {
  const at = ([x, y]: readonly [number, number]): [number, number] => [x + dx, y + dy];
  return loop.map((segment) =>
    segment.kind === 'line'
      ? { kind: 'line', from: at(segment.from), to: at(segment.to) }
      : segment.kind === 'cubic'
        ? { kind: 'cubic', from: at(segment.from), control1: at(segment.control1), control2: at(segment.control2), to: at(segment.to) }
        : { kind: 'quad', from: at(segment.from), control: at(segment.control), to: at(segment.to) },
  );
};

export interface CffFont {
  readonly glyphCount: number;
  /** Closed loops of glyph `glyph` in font units (outer loops clockwise); throws `FontError` for a hostile charstring. */
  readonly outline: (glyph: number, budget?: OperatorBudget) => readonly OutlineLoop[];
}

const MAX_FONT_DICTS = 256;

interface PrivateData {
  readonly locals: Subrs | null;
  readonly vsindex: number;
}

function readPrivate(table: ByteView, fontDict: Map<number, number[]>, version: 1 | 2, indexAt: (offset: number) => Index): PrivateData {
  const range = fontDict.get(18);
  if (range === undefined || range.length !== 2) return { locals: null, vsindex: 0 };
  const [size, offset] = range as [number, number];
  const data = readDict(table, offset, offset + size, version);
  const subrs = data.get(19)?.[0];
  const vsindex = data.get(22)?.[0] ?? 0;
  if (subrs === undefined) return { locals: null, vsindex };
  const index = indexAt(offset + subrs);
  return { locals: { index, bias: bias(index.count) }, vsindex };
}

/** The font dict number of each glyph from an FDSelect (formats 0 and 3 of CFF, and 4 of CFF2), read once. @failure unordered ranges, a sentinel short of the glyphs -> WRP_FONT_PARSE */
function readFdSelect(table: ByteView, at: number, glyphCount: number): Uint16Array {
  const format = table.u8(at);
  const fonts = new Uint16Array(glyphCount);
  if (format === 0) {
    for (let glyph = 0; glyph < glyphCount; glyph++) fonts[glyph] = table.u8(at + 1 + glyph);
    return fonts;
  }
  if (format !== 3 && format !== 4) throw parseError(`CFF: FDSelect format ${format} is not 0, 3 or 4`);
  const wide = format === 4;
  const ranges = wide ? table.u32(at + 1) : table.u16(at + 1);
  if (ranges > 65_536) throw parseError(`CFF2: FDSelect with ${ranges} ranges exceeds 65536`);
  const first = (r: number): number => (wide ? table.u32(at + 5 + 6 * r) : table.u16(at + 3 + 3 * r));
  const fontOf = (r: number): number => (wide ? table.u16(at + 9 + 6 * r) : table.u8(at + 5 + 3 * r));
  let previous = -1;
  for (let r = 0; r < ranges; r++) {
    const start = first(r);
    const end = first(r + 1);
    if (start <= previous || (r === 0 && start !== 0))
      throw parseError(`${format === 4 ? 'CFF2' : 'CFF'}: FDSelect has no font for glyph ${r === 0 ? 0 : start}`);
    previous = start;
    const stop = Math.min(end, glyphCount);
    for (let glyph = start; glyph < stop; glyph++) fonts[glyph] = fontOf(r);
  }
  if (ranges === 0 || first(ranges) < glyphCount)
    throw parseError(`CFF: FDSelect has no font for glyph ${ranges === 0 ? 0 : first(ranges)}`);
  return fonts;
}

interface Glyphs {
  readonly glyphCount: number;
  readonly setupOf: (glyph: number) => MachineSetup;
  readonly entryOf: (glyph: number) => readonly [number, number];
  /** The glyph of a Standard Encoding character code, for `seac`; null for a font that has no charset to look it up in (CID-keyed, CFF2). */
  readonly accentGlyph: ((code: number) => number) | null;
}

/** An INDEX reader that parses each offset once (font dicts may share one Subrs INDEX). */
const sharedIndexes = (table: ByteView, wide: boolean): ((offset: number) => Index) => {
  const known = new Map<number, Index>();
  return (offset) => {
    let index = known.get(offset);
    if (index === undefined) {
      index = readIndex(table, offset, wide);
      known.set(offset, index);
    }
    return index;
  };
};

/** The Private DICT data of font dict `k`, read on first use. */
function lazyValues<T>(count: number, make: (k: number) => T): (k: number) => T | undefined {
  const made = new Map<number, T>();
  return (k) => {
    if (k >= count) return undefined;
    let value = made.get(k);
    if (value === undefined) {
      value = make(k);
      made.set(k, value);
    }
    return value;
  };
}

function build(table: ByteView, glyphs: Glyphs): CffFont {
  const draw = (glyph: number, budget: OperatorBudget | null): Machine => {
    const [start, end] = glyphs.entryOf(glyph);
    const machine = new Machine(table, glyphs.setupOf(glyph), budget);
    machine.run(start, end, 0);
    machine.finish();
    return machine;
  };
  const component = (code: number, budget: OperatorBudget | null): Machine => {
    if (glyphs.accentGlyph === null) throw parseError('CFF: seac is only defined for name-keyed CFF 1.x fonts');
    const part = draw(glyphs.accentGlyph(code), budget);
    if (part.seac !== null) throw parseError('CFF: a seac component is itself an accented glyph');
    return part;
  };
  return {
    glyphCount: glyphs.glyphCount,
    outline: (glyph, budget = undefined) => {
      const machine = draw(glyph, budget ?? null);
      let loops = machine.pen.loops;
      const { seac } = machine;
      if (seac !== null) {
        const base = component(seac.base, budget ?? null);
        const accent = component(seac.accent, budget ?? null);
        loops = [...loops, ...base.pen.loops, ...accent.pen.loops.map((loop) => shifted(loop, seac.adx, seac.ady))];
      }
      return loops.filter((loop) => loop.length > 0).map(reverseLoop);
    },
  };
}

function readCff1(table: ByteView): CffFont {
  const names = readIndex(table, table.u8(2), false);
  const tops = readIndex(table, names.end, false);
  const strings = readIndex(table, tops.end, false);
  const globalIndex = readIndex(table, strings.end, false);
  const globals: Subrs = { index: globalIndex, bias: bias(globalIndex.count) };
  const topEntry = tops.entries[0];
  if (topEntry === undefined) throw parseError('CFF: no Top DICT');
  const top = readDict(table, topEntry[0], topEntry[1], 1);
  const charStringsAt = top.get(17)?.[0];
  if (charStringsAt === undefined) throw parseError('CFF: the Top DICT has no CharStrings');
  const charStrings = readIndex(table, charStringsAt, false);
  const fdArray = top.get(1236)?.[0];
  const fdSelect = top.get(1237)?.[0];
  const cidKeyed = fdArray !== undefined && fdSelect !== undefined;
  const indexAt = sharedIndexes(table, false);
  let privateOf: (k: number) => PrivateData | undefined = lazyValues(1, () => readPrivate(table, top, 1, indexAt));
  let fdOf: (glyph: number) => number = () => 0;
  if (cidKeyed) {
    const fonts = readIndex(table, fdArray, false);
    if (fonts.count > MAX_FONT_DICTS) throw parseError(`CFF: ${fonts.count} font dicts exceed ${MAX_FONT_DICTS}`);
    privateOf = lazyValues(fonts.count, (k) => {
      const [start, end] = fonts.entries[k] as readonly [number, number];
      return readPrivate(table, readDict(table, start, end, 1), 1, indexAt);
    });
    const selected = readFdSelect(table, fdSelect, charStrings.count);
    fdOf = (glyph) => selected[glyph] ?? 0;
  }
  let charset: ReadonlyMap<number, number> | null = null;
  const accentGlyph = (code: number): number => {
    const sid = STANDARD_ENCODING_SID[code] as number;
    if (sid === 0) throw parseError(`CFF: seac character code ${code} has no Standard Encoding name`);
    charset ??= readCharset(table, top.get(15)?.[0] ?? 0, charStrings.count);
    const glyph = charset.get(sid);
    if (glyph === undefined) throw parseError(`CFF: seac component '${code}' (string id ${sid}) is not in the charset`);
    return glyph;
  };
  return build(table, {
    glyphCount: charStrings.count,
    entryOf: (glyph) => {
      const entry = charStrings.entries[glyph];
      if (entry === undefined) throw parseError(`CFF: glyph ${glyph} is outside 0..${charStrings.count - 1}`);
      return entry;
    },
    setupOf: (glyph) => ({ version: 1, globals, locals: privateOf(fdOf(glyph))?.locals ?? null, blender: null }),
    accentGlyph: cidKeyed ? null : accentGlyph,
  });
}

function blenderOf(
  store: ItemVariationStore | null,
  coords: readonly number[],
  defaultIndex: number,
  memo: Map<number, readonly number[]>,
): Blender | null {
  if (store === null) return null;
  return {
    defaultIndex,
    regionCount: (vsindex) => store.regionCount(vsindex),
    scalars: (vsindex) => {
      let scalars = memo.get(vsindex);
      if (scalars === undefined) {
        scalars = store.scalars(vsindex, coords);
        memo.set(vsindex, scalars);
      }
      return scalars;
    },
  };
}

function readCff2(table: ByteView, coords: readonly number[]): CffFont {
  const headerSize = table.u8(2);
  const topLength = table.u16(3);
  if (headerSize < 5) throw parseError(`CFF2: header size ${headerSize} is shorter than 5`);
  const top = readDict(table, headerSize, headerSize + topLength, 2);
  const globalIndex = readIndex(table, headerSize + topLength, true);
  const globals: Subrs = { index: globalIndex, bias: bias(globalIndex.count) };
  const charStringsAt = top.get(17)?.[0];
  const fdArray = top.get(1236)?.[0];
  if (charStringsAt === undefined) throw parseError('CFF2: the Top DICT has no CharStrings');
  if (fdArray === undefined) throw parseError('CFF2: the Top DICT has no FDArray');
  const charStrings = readIndex(table, charStringsAt, true);
  const vstoreAt = top.get(24)?.[0];
  const store =
    vstoreAt === undefined ? null : readItemVariationStore(table.sub(vstoreAt + 2, table.u16(vstoreAt), 'CFF2 variation store'));
  if (store !== null && store.axisCount !== coords.length)
    throw parseError(`CFF2: the variation store has ${store.axisCount} axes, the font's fvar has ${coords.length}`);
  const fonts = readIndex(table, fdArray, true);
  if (fonts.count === 0) throw parseError('CFF2: the FDArray is empty');
  if (fonts.count > MAX_FONT_DICTS) throw parseError(`CFF2: ${fonts.count} font dicts exceed ${MAX_FONT_DICTS}`);
  const memo = new Map<number, readonly number[]>();
  const indexAt = sharedIndexes(table, true);
  const setupOf = lazyValues<MachineSetup>(fonts.count, (k) => {
    const [start, end] = fonts.entries[k] as readonly [number, number];
    const data = readPrivate(table, readDict(table, start, end, 2), 2, indexAt);
    return { version: 2, globals, locals: data.locals, blender: blenderOf(store, coords, data.vsindex, memo) };
  });
  const fdSelect = top.get(1237)?.[0];
  const selected = fdSelect === undefined ? null : readFdSelect(table, fdSelect, charStrings.count);
  const fdOf = (glyph: number): number => selected?.[glyph] ?? 0;
  return build(table, {
    glyphCount: charStrings.count,
    entryOf: (glyph) => {
      const entry = charStrings.entries[glyph];
      if (entry === undefined) throw parseError(`CFF2: glyph ${glyph} is outside 0..${charStrings.count - 1}`);
      return entry;
    },
    setupOf: (glyph) => {
      const setup = setupOf(fdOf(glyph));
      if (setup === undefined) throw parseError(`CFF2: glyph ${glyph} names font dict ${fdOf(glyph)} of ${fonts.count}`);
      return setup;
    },
    accentGlyph: null,
  });
}

/**
 * The glyph outlines of a `CFF ` or `CFF2` table; `coords` are the normalised variation coordinates (CFF2 only, one per fvar axis).
 * @failure a table that is not CFF 1.x / 2.0, an INDEX or DICT that cannot be read, a CID font without its FDSelect -> WRP_FONT_PARSE
 */
export function readCff(table: ByteView, coords: readonly number[] = []): CffFont {
  const major = table.u8(0);
  if (major === 1) return readCff1(table);
  if (major === 2) return readCff2(table, coords);
  throw parseError(`CFF: major version ${major} is not 1 or 2`);
}
