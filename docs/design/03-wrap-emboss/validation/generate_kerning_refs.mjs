#!/usr/bin/env node
// WRP kerning reference data (VC-WRP-40, grade B) from the pinned font, by an implementation independent of packages/core/src/lib/font/gpos.ts: a linear scan of every
// PairPos subtable of every lookup the `kern` feature names (no binary search, no cache), formats 1 and 2, extension lookups unwrapped, x advance of the first value record.
// No npm dependencies. The shaper HarfBuzz is not available offline, so the grade stays B: two independent readings of the same table agree.
//
//   node generate_kerning_refs.mjs [path/to/FiraSans-Regular.ttf]     (default: ../../../../server/fonts/FiraSans-Regular.ttf, the bundled copy)
//   writes data/kerning_firasans.json
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fontPath = process.argv[2] ?? join(here, '..', '..', '..', '..', 'server', 'fonts', 'FiraSans-Regular.ttf');
const bytes = readFileSync(fontPath);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u16 = (o) => view.getUint16(o);
const i16 = (o) => view.getInt16(o);
const u32 = (o) => view.getUint32(o);
const tables = {};
for (let k = 0, n = u16(4); k < n; k++) {
  const rec = 12 + 16 * k;
  tables[String.fromCharCode(...bytes.subarray(rec, rec + 4))] = u32(rec + 8);
}
const gpos = tables.GPOS;
const unitsPerEm = u16(tables.head + 18);
const numberOfHMetrics = u16(tables.hhea + 34);
const advance = (g) => u16(tables.hmtx + 4 * Math.min(g, numberOfHMetrics - 1));

// cmap format 4 by linear scan
const cmapBase = tables.cmap;
let format4 = null;
for (let k = 0, n = u16(cmapBase + 2); k < n; k++) {
  const platform = u16(cmapBase + 4 + 8 * k);
  const offset = cmapBase + u32(cmapBase + 8 + 8 * k);
  if (platform === 3 && u16(offset) === 4) format4 = offset;
}
if (format4 === null) throw new Error('no cmap format 4 subtable');
function glyphOf(code) {
  const segments = u16(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const ranges = deltas + 2 * segments;
  for (let s = 0; s < segments; s++) {
    if (code > u16(ends + 2 * s) || code < u16(starts + 2 * s)) continue;
    const rangeOffset = u16(ranges + 2 * s);
    if (rangeOffset === 0) return (code + i16(deltas + 2 * s)) & 0xffff;
    const g = u16(ranges + 2 * s + rangeOffset + 2 * (code - u16(starts + 2 * s)));
    return g === 0 ? 0 : (g + i16(deltas + 2 * s)) & 0xffff;
  }
  return 0;
}

const coverage = (o) => {
  const out = [];
  if (u16(o) === 1) for (let k = 0; k < u16(o + 2); k++) out.push(u16(o + 4 + 2 * k));
  else for (let r = 0; r < u16(o + 2); r++) for (let g = u16(o + 4 + 6 * r); g <= u16(o + 6 + 6 * r); g++) out.push(g);
  return out;
};
const classOf = (o, glyph) => {
  if (u16(o) === 1) {
    const index = glyph - u16(o + 2);
    return index >= 0 && index < u16(o + 4) ? u16(o + 6 + 2 * index) : 0;
  }
  for (let r = 0; r < u16(o + 2); r++) if (glyph >= u16(o + 4 + 6 * r) && glyph <= u16(o + 6 + 6 * r)) return u16(o + 8 + 6 * r);
  return 0;
};
const bitCount = (v) => v.toString(2).split('1').length - 1;

// the pair subtables of the kern feature's lookups
const featureList = gpos + u16(gpos + 6);
const lookupList = gpos + u16(gpos + 8);
const lookupIndices = new Set();
for (let f = 0; f < u16(featureList); f++) {
  const tag = String.fromCharCode(...bytes.subarray(featureList + 2 + 6 * f, featureList + 6 + 6 * f));
  if (tag !== 'kern') continue;
  const feature = featureList + u16(featureList + 6 + 6 * f);
  for (let k = 0; k < u16(feature + 2); k++) lookupIndices.add(u16(feature + 4 + 2 * k));
}
const lookups = [...lookupIndices]
  .sort((a, b) => a - b)
  .map((index) => {
    const lookup = lookupList + u16(lookupList + 2 + 2 * index);
    const type = u16(lookup);
    const subtables = [];
    for (let k = 0; k < u16(lookup + 4); k++) {
      let sub = lookup + u16(lookup + 6 + 2 * k);
      if (type === 9) sub += u32(sub + 4);
      if (type === 2 || (type === 9 && true)) subtables.push(sub);
    }
    return subtables;
  });

function pairValue(sub, left, right) {
  const format = u16(sub);
  if (!coverage(sub + u16(sub + 2)).includes(left)) return null;
  const vf1 = u16(sub + 4);
  const vf2 = u16(sub + 6);
  const advanceOffset = (vf1 & 4) === 0 ? -1 : 2 * bitCount(vf1 & 3);
  const recordSize = 2 * bitCount(vf1 & 0xff) + 2 * bitCount(vf2 & 0xff);
  if (format === 1) {
    const index = coverage(sub + u16(sub + 2)).indexOf(left);
    const set = sub + u16(sub + 10 + 2 * index);
    for (let k = 0; k < u16(set); k++) {
      const record = set + 2 + (2 + recordSize) * k;
      if (u16(record) === right) return advanceOffset < 0 ? 0 : i16(record + 2 + advanceOffset);
    }
    return null;
  }
  const c1 = classOf(sub + u16(sub + 8), left);
  const c2 = classOf(sub + u16(sub + 10), right);
  const classes2 = u16(sub + 14);
  const record = sub + 16 + (c1 * classes2 + c2) * recordSize;
  return advanceOffset < 0 ? 0 : i16(record + advanceOffset);
}
function kerning(left, right) {
  let total = 0;
  for (const subtables of lookups)
    for (const sub of subtables) {
      const value = pairValue(sub, left, right);
      if (value !== null) {
        total += value;
        break;
      }
    }
  return total;
}

const ascii = Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k));
const pairs = [];
for (const a of ascii)
  for (const b of ascii) {
    const value = kerning(glyphOf(a.codePointAt(0)), glyphOf(b.codePointAt(0)));
    if (value !== 0) pairs.push({ left: a, right: b, value });
  }
function width(text, kern) {
  const glyphs = [...text].map((c) => glyphOf(c.codePointAt(0)));
  let total = 0;
  glyphs.forEach((g, k) => {
    total += advance(g) + (kern && k > 0 ? kerning(glyphs[k - 1], g) : 0);
  });
  return total;
}
const capHeight = i16(tables['OS/2'] + 88);
const cases = ['LLULL CAD 2026', 'AVATAR', 'To', 'LLULL', 'WRAP'].map((text) => ({
  text,
  advanceNoKerningUnits: width(text, false),
  advanceWithKerningUnits: width(text, true),
  kerningUnits: width(text, true) - width(text, false),
  // cap height 5 mm (the pack text case): scale = 5 / sCapHeight
  advanceNoKerningMm: (width(text, false) * 5) / capHeight,
  advanceWithKerningMm: (width(text, true) * 5) / capHeight,
}));
writeFileSync(
  join(here, 'data', 'kerning_firasans.json'),
  JSON.stringify(
    { font: 'Fira Sans Regular (pinned, sha256 in sources.md R24)', unitsPerEm, capHeight, kernPairsAscii: pairs.length, pairs, cases },
    null,
    1,
  ) + '\n',
);
process.stdout.write(`${pairs.length} kerned ASCII pairs, ${cases.length} cases\n`);
