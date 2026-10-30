/**
 * Adversarial fonts BUILT to attack the font-wide bounds of the CFF / CFF2 reader (03 WRP M4): each is small on disk and would cost billions of steps or gigabytes
 * without a font-wide limit. A single-byte fuzz cannot reach them (they need a coordinated structure), so they are constructed here and used by the hostile-input
 * harness (`extra` cases, time budget) and by `fontLimits.test.ts` (refusal code and message).
 */

import { buildCffFont, dictInt, u16, u32, type Token } from './cffBuilder';
import { buildCff2, buildCff2Font } from './cff2Builder';

const AXIS = [{ tag: 'wght', min: 100, default: 400, max: 900 }] as const;

/** An INDEX of `count` empty entries with 1-byte offsets (all 1): about `count` bytes for any count. */
const emptyIndex = (count: number): number[] => [...u32(count), 1, ...new Array<number>(count + 1).fill(1)];

const wrap = (table: readonly number[], glyphs: number, withAxis = false): Uint8Array =>
  buildCff2Font({
    cff2: { glyphs: Array.from({ length: glyphs }, () => ({ tokens: [] })) },
    cff2Bytes: table,
    ...(withAxis ? { axes: AXIS } : {}),
  });

/**
 * CFF2 with `fdCount` font dicts, each with its own Private DICT whose Subrs offset points at ONE shared INDEX of `subrs` empty entries (about `subrs` bytes), and
 * `glyphs` empty glyphs, glyph k in font dict k mod 256 (FDSelect format 0). Read eagerly per font dict that is fdCount x subrs tuples.
 */
export function sharedSubrsFont(fdCount: number, subrs: number, glyphs: number): Uint8Array {
  const charStrings = emptyIndex(glyphs);
  const charAt = 5 + 20 + 4;
  const arrayAt = charAt + charStrings.length;
  const privateBase = arrayAt + (4 + 1 + 4 * (fdCount + 1) + 11 * fdCount);
  const privateAt = (k: number): number => privateBase + 6 * k;
  const subrsAt = privateBase + 6 * fdCount;
  const subrsIndex = emptyIndex(subrs);
  const selectAt = subrsAt + subrsIndex.length;
  const top = [...dictInt(charAt), 17, ...dictInt(arrayAt), 12, 36, ...dictInt(selectAt), 12, 37];
  const fontDicts = Array.from({ length: fdCount }, (_, k) => [...dictInt(6), ...dictInt(privateAt(k)), 18]);
  const fdIndex = [...u32(fdCount), 4, ...Array.from({ length: fdCount + 1 }, (_, k) => u32(1 + 11 * k)).flat(), ...fontDicts.flat()];
  const privates = Array.from({ length: fdCount }, (_, k) => [...dictInt(subrsAt - privateAt(k)), 19]).flat();
  const select = [0, ...Array.from({ length: glyphs }, (_, k) => k % 256)];
  return wrap([2, 0, 5, ...u16(top.length), ...top, ...u32(0), ...charStrings, ...fdIndex, ...privates, ...subrsIndex, ...select], glyphs);
}

/** CFF2 whose variation store has `regions` regions and `tables` data subtables that all point at ONE subtable listing `listed` region indexes (tables x listed reads). */
export function aliasedStoreFont(regions: number, tables: number, listed = regions): Uint8Array {
  const listAt = 8 + 4 * tables;
  const list = [...u16(1), ...u16(regions), ...new Array<number>(6 * regions).fill(0)];
  const subtableAt = listAt + list.length;
  const subtable = [...u16(0), ...u16(0), ...u16(listed), ...Array.from({ length: listed }, (_, k) => u16(k % regions)).flat()];
  const store = [
    ...u16(1),
    ...u32(listAt),
    ...u16(tables),
    ...Array.from({ length: tables }, () => u32(subtableAt)).flat(),
    ...list,
    ...subtable,
  ];
  return wrap(buildCff2({ glyphs: [{ tokens: [] }], storeBytes: store }), 1, true);
}

/** CFF with `glyphs` glyphs that each call a subroutine tree of about 70 000 operators (under the 200 000 per-glyph cap): the font-wide operator budget is the only bound. */
export function operatorFanFont(glyphs: number): Uint8Array {
  const fan = (next: number): Token[] => [next, 'callsubr', next, 'callsubr', next, 'callsubr', next, 'callsubr', 'return'];
  const subrs: Token[][] = Array.from({ length: 7 }, (_, k) => fan(k + 1 - 107));
  subrs.push(['return']);
  return buildCffFont({
    glyphs: [{ tokens: ['endchar'] }, ...Array.from({ length: glyphs }, () => ({ tokens: [-107, 'callsubr', 'endchar'] as Token[] }))],
    localSubrs: subrs,
  });
}

/** CFF2 with `glyphs` empty glyphs and an FDSelect format 3 of one range per glyph (with `unordered`, the last range starts at 0 again). */
export function manyRangesFont(glyphs: number, unordered = false): Uint8Array {
  const ranges = Array.from({ length: glyphs }, (_, k) => [...u16(unordered && k === glyphs - 1 ? 0 : k), 0]).flat();
  const select = [3, ...u16(glyphs), ...ranges, ...u16(glyphs)];
  return wrap(buildCff2({ glyphs: Array.from({ length: glyphs }, () => ({ tokens: [] })), selectBytes: select }), glyphs);
}
