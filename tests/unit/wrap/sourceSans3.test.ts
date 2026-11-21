/**
 * 03 WRP DES-3c (spec §14.21): the whole font path on a REAL CFF2 variable font, Source Sans 3 VF Italic (OFL-1.1, sources.md R28), against
 * fontTools 4.68.0 (validation/generate_cff2_refs.py -> data/cff2_sourcesans3_italic_refs.json): outlines (charstring blends, avar, region scalars),
 * HVAR advances, named instances, font_metrics, add_text / add_decal with a variation, vertical layout without vmtx / VVAR.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { uint8ArrayToBase64 } from '@lib/base64';
import { parseFont, validateGlyphs, type ParsedFont } from '@lib/font/font';
import { loopArea, type OutlineLoop } from '@lib/font/outline';
import type { CadDocument } from '@core/model/types';
import { expectRefusal } from '../../helpers/commandAssertions';
import { emptyDoc, make } from './support';

type Vec = readonly [number, number];
type RefSegment = readonly [string, ...number[]];
interface Refs {
  fontTools: string;
  font: { sha256: string };
  axes: Array<[string, number, number, number]>;
  namedInstances: Array<{ name: string; postScriptName: string | null; coordinates: Record<string, number> }>;
  tables: string[];
  unitsPerEm: number;
  numGlyphs: number;
  glyphIndex: Record<string, number>;
  instances: Record<
    string,
    {
      hhea: number[];
      os2: { sCapHeight: number; sxHeight: number };
      advance: Record<string, number>;
      kerning: Record<string, number>;
      outline: Record<string, RefSegment[][]>;
      outlineStatic: Record<string, RefSegment[][]>;
    }
  >;
}

const dir = path.join(__dirname, '..', '..', '..', 'docs', 'design', '03-wrap-emboss', 'validation', 'data');
const fontBytes = new Uint8Array(readFileSync(path.join(dir, 'reference', 'sourcesans3', 'SourceSans3VF-Italic.otf')));
const refs = JSON.parse(readFileSync(path.join(dir, 'cff2_sourcesans3_italic_refs.json'), 'utf8')) as Refs;

const load = (variation: Record<string, number> = {}, instance?: string): ParsedFont => {
  const parsed = parseFont(fontBytes, variation, instance);
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.font;
};

/** Contour as the list of its segment end points and controls, the closing line made explicit, zero-length lines dropped (both sides). */
function llullContour(loop: OutlineLoop): Vec[][] {
  const segments: Vec[][] = [];
  for (const s of loop)
    segments.push(
      s.kind === 'line' ? [s.from, s.to] : s.kind === 'cubic' ? [s.from, s.control1, s.control2, s.to] : [s.from, s.control, s.to],
    );
  return segments.filter((s) => s.length > 2 || s[0]?.[0] !== s[1]?.[0] || s[0]?.[1] !== s[1]?.[1]);
}

function refContour(contour: RefSegment[]): Vec[][] {
  const segments: Vec[][] = [];
  const first = contour[0] as RefSegment;
  const start: Vec = [first[1] as number, first[2] as number];
  let at = start;
  for (const seg of contour.slice(1)) {
    const n = seg.length;
    const to: Vec = [seg[n - 2] as number, seg[n - 1] as number];
    segments.push(seg[0] === 'L' ? [at, to] : [at, [seg[1] as number, seg[2] as number], [seg[3] as number, seg[4] as number], to]);
    at = to;
  }
  if (at[0] !== start[0] || at[1] !== start[1]) segments.push([at, start]);
  return segments.filter((s) => s.length > 2 || s[0]?.[0] !== s[1]?.[0] || s[0]?.[1] !== s[1]?.[1]);
}

const twiceArea = (segments: Vec[][]): number => {
  let sum = 0;
  for (const s of segments) {
    for (let k = 0; k + 1 < s.length; k++) sum += (s[k] as Vec)[0] * (s[k + 1] as Vec)[1] - (s[k + 1] as Vec)[0] * (s[k] as Vec)[1];
  }
  return sum;
};

/** Counter-clockwise (llull reads outer loops clockwise, fontTools counter-clockwise). */
const ccwOf = (segments: Vec[][]): Vec[][] => (twiceArea(segments) >= 0 ? segments : [...segments].reverse().map((s) => [...s].reverse()));

/** Largest coordinate difference of two loops over every rotation of the start segment; Infinity when their segment structure differs. */
function loopDistance(a: Vec[][], b: Vec[][]): number {
  if (a.length !== b.length) return Infinity;
  let best = Infinity;
  for (let shift = 0; shift < b.length; shift++) {
    let worst = 0;
    a.forEach((segment, i) => {
      const other = b[(i + shift) % b.length] as Vec[];
      if (segment.length !== other.length) worst = Infinity;
      else
        segment.forEach((p, j) => (worst = Math.max(worst, Math.abs(p[0] - (other[j] as Vec)[0]), Math.abs(p[1] - (other[j] as Vec)[1]))));
    });
    best = Math.min(best, worst);
  }
  return best;
}

/** Largest coordinate difference between the loops of the font and the reference contours (each loop paired with its nearest unused one); Infinity when the structure differs. */
function distance(loops: readonly OutlineLoop[], reference: RefSegment[][]): number {
  if (loops.length !== reference.length) return Infinity;
  const left = loops.map((loop) => ccwOf(llullContour(loop)));
  const right = reference.map((contour) => ccwOf(refContour(contour)));
  const used = new Set<number>();
  let worst = 0;
  for (const loop of left) {
    let pick = -1;
    let pickDistance = Infinity;
    right.forEach((other, k) => {
      const d = used.has(k) ? Infinity : loopDistance(loop, other);
      if (d < pickDistance) [pick, pickDistance] = [k, d];
    });
    if (pick < 0) return Infinity;
    used.add(pick);
    worst = Math.max(worst, pickDistance);
  }
  return worst;
}

const OUTLINE_CHARS = [...'HogaAg&f1ß'];

describe('the pinned font', () => {
  it('is the file recorded in sources.md R28 and the reference data was made from it', () => {
    expect(createHash('sha256').update(fontBytes).digest('hex')).toBe(refs.font.sha256);
    expect(refs.fontTools).toBe('4.68.0');
    expect(refs.font.sha256).toBe('3f5646523c6e8c504d06a34ce05a190b87c071c4d318296fd88794fd7b6bab57');
  });
});

const TOLERANCE_LIVE = 0.02;
const COORDS = Object.keys(refs.instances).map(Number);
const variationOf = (coord: number): Record<string, number> => (coord === 200 ? {} : { wght: coord });
const at = (coord: number): Refs['instances'][string] => refs.instances[String(coord)] as Refs['instances'][string];

describe('outlines against fontTools', () => {
  it('reads the axis, the glyph count and the glyph indexes the reference has; the file is CFF2 with HVAR, MVAR and avar', () => {
    const font = load();
    expect(font.format).toBe('cff');
    expect(font.axes).toEqual([{ tag: 'wght', min: 200, default: 200, max: 900 }]);
    expect(refs.axes).toEqual([['wght', 200, 200, 900]]);
    expect(font.unitsPerEm).toBe(refs.unitsPerEm);
    expect(font.numGlyphs).toBe(refs.numGlyphs);
    expect(refs.tables).toEqual(expect.arrayContaining(['CFF2', 'HVAR', 'MVAR', 'avar', 'fvar']));
    expect(refs.tables).not.toContain('vmtx');
    for (const [ch, glyph] of Object.entries(refs.glyphIndex)) expect(font.glyphIndex(ch.codePointAt(0) as number), ch).toBe(glyph);
  });

  it.each(COORDS)(
    'wght %i: every point and control point of 10 glyphs is within 0.02 font units of the unrounded fontTools blend and within 0.5 of its static instance',
    (coord) => {
      const font = load(variationOf(coord));
      const ref = at(coord);
      for (const ch of OUTLINE_CHARS) {
        const glyph = font.glyphIndex(ch.codePointAt(0) as number);
        expect(distance(font.outline(glyph), ref.outline[ch] as RefSegment[][]), `${ch} live`).toBeLessThan(TOLERANCE_LIVE);
        expect(distance(font.outline(glyph), ref.outlineStatic[ch] as RefSegment[][]), `${ch} static`).toBeLessThanOrEqual(0.5);
      }
    },
  );

  it('an intermediate value that is not a named instance (wght 477.5) lies in the order of its neighbours: the area of o grows with wght', () => {
    const areas = [200, 300, 400, 477.5, 500, 650, 900].map((w) => {
      const font = load(w === 200 ? {} : { wght: w });
      return Math.abs(font.outline(font.glyphIndex(0x6f)).reduce((sum, loop) => sum + loopArea(loop), 0));
    });
    for (let k = 1; k < areas.length; k++) expect(areas[k]).toBeGreaterThan(areas[k - 1] as number);
  });

  it('all 1998 glyphs of the default, an intermediate and the extreme instance scan within the font budgets', () => {
    for (const w of [{}, { wght: 650 }, { wght: 900 }]) {
      const parsed = parseFont(fontBytes, w);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(validateGlyphs(parsed.font)).toMatchObject({ ok: true });
    }
  });

  it('refuses an axis value outside 200..900 and an axis the font has not, by code', () => {
    expect(parseFont(fontBytes, { wght: 199 })).toMatchObject({ ok: false, code: 'WRP_FONT_VARIATION' });
    expect(parseFont(fontBytes, { wght: 901 })).toMatchObject({ ok: false, code: 'WRP_FONT_VARIATION' });
    expect(parseFont(fontBytes, { wdth: 100 })).toMatchObject({ ok: false, code: 'WRP_FONT_VARIATION' });
  });
});

describe('HVAR advances and metrics against fontTools', () => {
  it.each(COORDS)('wght %i: the advance of every one of 66 characters equals the hmtx of the fontTools static instance', (coord) => {
    const font = load(variationOf(coord));
    const ref = at(coord);
    for (const [ch, advance] of Object.entries(ref.advance))
      expect(font.advance(font.glyphIndex(ch.codePointAt(0) as number)), ch).toBe(advance);
    expect(Object.keys(ref.advance).length).toBeGreaterThan(60);
  });

  it('the advance of H moves with wght (it is not the hmtx default)', () => {
    const h = (w: Record<string, number>): number => load(w).advance(load(w).glyphIndex(0x48));
    expect(h({ wght: 900 })).not.toBe(h({}));
  });

  it.each(COORDS)(
    'wght %i: ascender, descender, line gap and cap height equal the reference (MVAR here carries hcof / stro / xhgt only)',
    (coord) => {
      const font = load(variationOf(coord));
      const ref = at(coord);
      expect([font.ascender, font.descender, font.lineGap]).toEqual(ref.hhea);
      expect(font.capHeight).toBe(ref.os2.sCapHeight);
      expect(font.capHeightSource).toBe('os2');
    },
  );
});

describe('GPOS pair kerning against HarfBuzz', () => {
  it.each(COORDS)(
    'wght %i: the kern feature of 12 pairs equals the HarfBuzz x advance difference at the instance (GDEF variation store)',
    (coord) => {
      const font = load(variationOf(coord));
      for (const [pair, value] of Object.entries(at(coord).kerning)) {
        const [left, right] = [...pair].map((ch) => font.glyphIndex(ch.codePointAt(0) as number));
        expect(font.kerning(left as number, right as number), pair).toBe(value);
      }
    },
  );

  it('kerning moves with the weight (AV: -20 at 200, -100 at 900), and layout follows it', () => {
    const av = (w: Record<string, number>): number => load(w).kerning(load(w).glyphIndex(0x41), load(w).glyphIndex(0x56));
    expect([av({}), av({ wght: 900 })]).toEqual([-20, -100]);
  });
});

describe('hostile GDEF and GPOS of the real font', () => {
  const tableAt = (bytes: Uint8Array, tag: string): number => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let k = 0; k < view.getUint16(4); k++) {
      const record = 12 + 16 * k;
      if (String.fromCharCode(...bytes.subarray(record, record + 4)) === tag) return view.getUint32(record + 8);
    }
    throw new Error(`no ${tag}`);
  };

  it('a GDEF store offset past the table is WRP_FONT_PARSE at an instance and harmless at the default (kerning never reads it)', () => {
    const bytes = fontBytes.slice();
    new DataView(bytes.buffer).setUint32(tableAt(bytes, 'GDEF') + 14, 0x7fffffff);
    expect(parseFont(bytes, {})).toMatchObject({ ok: true });
    expect(parseFont(bytes, { wght: 650 })).toMatchObject({ ok: false, code: 'WRP_FONT_PARSE' });
  });

  it('a GDEF without a store (offset 0) or older than 1.3 keeps the default kerning at every instance', () => {
    for (const patch of [
      (view: DataView, at: number) => view.setUint32(at + 14, 0),
      (view: DataView, at: number) => view.setUint16(at + 2, 2),
    ]) {
      const bytes = fontBytes.slice();
      patch(new DataView(bytes.buffer), tableAt(bytes, 'GDEF'));
      const font = load();
      const parsed = parseFont(bytes, { wght: 900 });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.font.kerning(font.glyphIndex(0x41), font.glyphIndex(0x56))).toBe(-20);
    }
  });
});

describe('named instances', () => {
  it('lists the seven instances of fvar with their names and wght, and a name equals the explicit axis value (outline and advance)', () => {
    const font = load();
    expect(font.namedInstances.map((n) => [n.name, n.variation['wght']])).toEqual(
      refs.namedInstances.map((n) => [n.name, n.coordinates['wght']]),
    );
    expect(font.namedInstances.map((n) => n.postScriptName)).toEqual(refs.namedInstances.map((n) => n.postScriptName));
    for (const named of refs.namedInstances) {
      const byName = load({}, named.name.toLowerCase());
      const explicit = load({ wght: named.coordinates['wght'] as number });
      expect(byName.instance).toEqual(explicit.instance);
      const glyph = byName.glyphIndex(0x67);
      expect(byName.outline(glyph)).toEqual(explicit.outline(glyph));
      expect(byName.advance(glyph)).toBe(explicit.advance(glyph));
    }
    expect(load({}, 'Bold Italic').instance).toEqual({ wght: 700 });
    expect(load({}, 'ExtraLight Italic').instance).toEqual({});
    expect(parseFont(fontBytes, {}, 'Heavy')).toMatchObject({ ok: false, code: 'WRP_FONT_VARIATION' });
  });

  it('the named instance outlines are those of the reference at the same wght', () => {
    for (const coord of [300, 400, 500, 700, 900]) {
      const named = refs.namedInstances.find((n) => n.coordinates['wght'] === coord) as { name: string };
      const font = load({}, named.name);
      expect(distance(font.outline(font.glyphIndex(0x41)), at(coord).outline['A'] as RefSegment[][]), named.name).toBeLessThan(
        TOLERANCE_LIVE,
      );
    }
  });
});

describe('commands on the real font', () => {
  const base64 = uint8ArrayToBase64(fontBytes);
  const imported = (extra: Record<string, unknown> = {}): { doc: CadDocument; id: string; data: Record<string, unknown> } => {
    const result = execute(emptyDoc(), 'import_font', { base64, ...extra });
    expect(result.rejected, result.summary).toBeUndefined();
    return { doc: result.document, id: (result.data as { id: string }).id, data: result.data as Record<string, unknown> };
  };
  /** Area of the reference contours: Green's theorem by composite Simpson on every cubic (independent of lib/font/outline). */
  const refArea = (coord: number, ch: string): number => {
    let twice = 0;
    for (const contour of at(coord).outline[ch] as RefSegment[][])
      for (const [p0, p1, p2, p3] of refContour(contour)) {
        const pts = [p0, p1, p2, p3] as Vec[];
        const bez = (t: number, axis: 0 | 1): number => {
          const u = 1 - t;
          const c = pts.length === 2 ? [u, t] : [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
          return c.reduce((sum, w, k) => sum + w * (pts[k] as Vec)[axis], 0);
        };
        const steps = 400;
        const f = (t: number): number => {
          const h = 1e-6;
          const dx = (bez(t + h, 0) - bez(t - h, 0)) / (2 * h);
          const dy = (bez(t + h, 1) - bez(t - h, 1)) / (2 * h);
          return bez(t, 0) * dy - bez(t, 1) * dx;
        };
        let acc = f(0.0000001) + f(0.9999999);
        for (let k = 1; k < steps; k++) acc += f(k / steps) * (k % 2 === 1 ? 4 : 2);
        twice += acc / (3 * steps);
      }
    return Math.abs(twice / 2);
  };

  it('import_font detects CFF2, lists the wght axis and the seven named instances, and picks one by name', () => {
    const { data } = imported();
    expect(data).toMatchObject({ format: 'cff', axes: [{ tag: 'wght', min: 200, default: 200, max: 900 }], variation: {} });
    expect((data['namedInstances'] as Array<{ name: string }>).map((n) => n.name)).toEqual(refs.namedInstances.map((n) => n.name));
    const bold = imported({ instance: 'Bold Italic' });
    expect(bold.data).toMatchObject({ variation: { wght: 700 } });
    expect(bold.doc.fonts?.[bold.id]?.variation).toEqual({ wght: 700 });
    expectRefusal(emptyDoc(), 'import_font', { base64, variation: { wght: 950 } }, 'WRP_FONT_VARIATION', 'variation');
  });

  it('add_text with a variation: the outline area equals the fontTools area scaled to the height, and the advance follows HVAR', () => {
    const { doc, id } = imported();
    for (const coord of [200, 650, 900]) {
      const label = execute(doc, 'add_text', {
        content: 'o',
        position: [0, 0, 0],
        height: 6.6,
        font: id,
        ...(coord === 200 ? {} : { variation: { wght: coord } }),
      });
      expect(label.rejected, label.summary).toBeUndefined();
      const data = execute(label.document, 'text_outline', { id: label.affected[0] }).data as { area: number; advanceWidth: number };
      // height 6.6 = cap height 660 units: 0.01 per font unit
      expect(data.area).toBeCloseTo(refArea(coord, 'o') * 1e-4, 2);
      expect(data.advanceWidth).toBeCloseTo((at(coord).advance['o'] as number) * 0.01, 9);
    }
  });

  it('add_decal with a variation records the instance font: two font records of one blob; a value outside the axis is refused', () => {
    const { doc: withFont, id: fontId } = imported();
    const box = make(withFont, 'add_box', { size: [60, 40, 10] });
    const params = { id: box.id, text: 'Llull', at: [30, 0, 0], normal: [1, 0, 0], height: 5, font: fontId };
    const decal = execute(box.doc, 'add_decal', { ...params, variation: { wght: 900 } });
    expect(decal.rejected, decal.summary).toBeUndefined();
    const records = Object.values(decal.document.fonts ?? {});
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.variation ?? {})).toEqual(expect.arrayContaining([{}, { wght: 900 }]));
    expect(Object.keys(decal.document.blobs ?? {})).toHaveLength(1);
    const bad = execute(box.doc, 'add_decal', { ...params, variation: { wght: 50 } });
    expect(bad.document).toBe(box.doc);
    expect(bad.error?.code).toBe('WRP_FONT_VARIATION');
  });

  it('font_metrics: vertical metrics from hhea / OS/2 and the advance width of each character at the instance; without vertical metrics the advance height is ascender - descender', () => {
    const { doc, id } = imported();
    const result = execute(doc, 'font_metrics', { font: id, text: 'HAg', instance: 'Black Italic' });
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as {
      unitsPerEm: number;
      ascender: number;
      descender: number;
      capHeight: number;
      instance: unknown;
      glyphs: Array<{ character: string; advanceWidth: number; advanceHeight: number; verticalOrigin: { y: number; source: string } }>;
    };
    expect(data.instance).toEqual({ wght: 900 });
    expect([data.unitsPerEm, data.ascender, data.descender, data.capHeight]).toEqual([1000, 1000, -326, 660]);
    expect(data.glyphs.map((g) => g.advanceWidth)).toEqual(['H', 'A', 'g'].map((ch) => at(900).advance[ch]));
    expect(data.glyphs.map((g) => [g.advanceHeight, g.verticalOrigin])).toEqual(Array(3).fill([1326, { y: 1000, source: 'ascender' }]));
  });

  it('vertical layout falls back (no vmtx / VVAR / VORG): each glyph advances ascender - descender = 1326 units and hangs from the ascender', () => {
    const { doc, id } = imported();
    const label = execute(doc, 'add_text', {
      content: 'HH',
      position: [0, 0, 0],
      height: 6.6,
      font: id,
      direction: 'vertical',
      anchor: 'center',
    });
    expect(label.rejected, label.summary).toBeUndefined();
    const data = execute(label.document, 'text_outline', { id: label.affected[0] }).data as {
      advanceHeight: number;
      advanceWidth: number;
      bbox: { min: number[]; max: number[] };
      lines: number;
    };
    expect(data.advanceHeight).toBeCloseTo(2 * 13.26, 9);
    expect(data.lines).toBe(1);
    // the first H top (660) sits 10 - 6.6 = 3.4 below the origin (ascender 1000); the second hangs 13.26 lower
    expect(data.bbox.max[1]).toBeCloseTo(-3.4, 9);
    expect(data.bbox.min[1]).toBeCloseTo(-3.4 - 13.26 - 6.6, 9);
    expect(data.advanceWidth).toBeCloseTo(load().advance(load().glyphIndex(0x48)) * 0.01, 9);
  });

  it('text layout follows the instance kerning: the width of "AV" is the two advances plus the kerning of the instance (-20 at 200, -100 at 900)', () => {
    const { doc, id } = imported();
    for (const coord of [200, 900]) {
      const label = execute(doc, 'add_text', {
        content: 'AV',
        position: [0, 0, 0],
        height: 6.6,
        font: id,
        ...(coord === 200 ? {} : { variation: { wght: coord } }),
      });
      const data = execute(label.document, 'text_outline', { id: label.affected[0] }).data as { advanceWidth: number };
      const ref = at(coord);
      expect(data.advanceWidth).toBeCloseTo(
        ((ref.advance['A'] as number) + (ref.advance['V'] as number) + (ref.kerning['AV'] as number)) * 0.01,
        9,
      );
    }
  });

  it('is deterministic: the same text twice gives the same outline data', () => {
    const { doc, id } = imported();
    const params = { content: 'Llull & Co', position: [1, 2, 0], height: 7, font: id, variation: { wght: 650 } };
    const a = execute(doc, 'add_text', params);
    const b = execute(doc, 'add_text', params);
    expect(execute(a.document, 'text_outline', { id: a.affected[0] }).data).toEqual(
      execute(b.document, 'text_outline', { id: b.affected[0] }).data,
    );
  });
});
