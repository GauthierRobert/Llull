import { describe, expect, it } from 'vitest';
import { parseFont, validateGlyphs, type ParsedFont } from '@lib/font/font';
import { fillRegions } from '@lib/font/fill';
import { layoutText, type LayoutOptions } from '@lib/font/layout';
import { loopArea, loopBox, loopLength, type OutlineLoop } from '@lib/font/outline';
import { firaBytes, glyphReferences, textReferences, withFsType } from './fixtures';

const fira = (): ParsedFont => {
  const parsed = parseFont(firaBytes());
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.font;
};

const relative = (value: number, expected: number): number => Math.abs(value - expected) / Math.abs(expected);

const PLAIN: LayoutOptions = { height: 10, anchor: 'left', verticalAnchor: 'baseline', letterSpacing: 0, kerning: false, lineSpacing: 1 };

describe('lib/font TrueType reader (VC-WRP-13, 15)', () => {
  it('reads the pinned Fira Sans metrics', () => {
    const font = fira();
    expect(font.unitsPerEm).toBe(1000);
    expect(font.capHeight).toBe(689);
    expect(font.capHeightSource).toBe('os2');
    expect(font.numGlyphs).toBe(2708);
    expect(font.embedding).toBe('installable');
    expect(font.names.family).toBe('Fira Sans');
    expect(font.names.style).toBe('Regular');
    expect(validateGlyphs(font)).toEqual({ ok: true });
  });

  it('matches the exact glyph areas, contour and hole counts, advances and boxes of the reference data', () => {
    const font = fira();
    for (const reference of glyphReferences()) {
      const glyph = font.glyphIndex(reference.char.codePointAt(0) as number);
      const loops = font.outline(glyph);
      const areas = loops.map(loopArea);
      expect(loops.length, reference.char).toBe(reference.contours);
      expect(areas.filter((area) => area > 0).length, `${reference.char} holes`).toBe(reference.holes);
      expect(font.advance(glyph), reference.char).toBe(reference.advance);
      if (reference.contours === 0) continue;
      expect(relative(-areas.reduce((sum, area) => sum + area, 0), reference.areaFontUnits2), `${reference.char} area`).toBeLessThan(1e-9);
      expect(
        relative(
          loops.reduce((sum, loop) => sum + loopLength(loop), 0),
          reference.outlineLengthFontUnits,
        ),
        `${reference.char} length`,
      ).toBeLessThan(2e-6);
      const boxes = loops.map((loop) => loopBox(loop));
      expect(Math.min(...boxes.map((box) => box?.min[0] ?? 0))).toBeCloseTo((reference.bbox as number[])[0] as number, 6);
      expect(Math.max(...boxes.map((box) => box?.max[1] ?? 0))).toBeCloseTo((reference.bbox as number[])[3] as number, 6);
    }
  });

  it('lays out the reference strings: area, loop count, outline length and advance width', () => {
    const font = fira();
    for (const reference of textReferences()) {
      const layout = layoutText(font, reference.text, { ...PLAIN, height: reference.capHeightMm });
      const area = -layout.loops.reduce((sum, loop) => sum + loopArea(loop), 0);
      expect(layout.loops.length, reference.text).toBe(reference.loops);
      expect(relative(area, reference.areaMm2), `${reference.text} area`).toBeLessThan(1e-9);
      expect(
        relative(
          layout.loops.reduce((sum, loop) => sum + loopLength(loop), 0),
          reference.outlineLengthMm,
        ),
        `${reference.text} length`,
      ).toBeLessThan(2e-6);
      expect(relative(layout.advanceWidth, reference.advanceWidthNoKerningMm), `${reference.text} width`).toBeLessThan(1e-6);
      expect(layout.missing).toEqual([]);
    }
  });

  it('groups "B8%" into regions with the reference hole counts and keeps every curve exact', () => {
    const layout = layoutText(fira(), 'B8%', PLAIN);
    const fill = fillRegions(layout.loops);
    if ('error' in fill) throw new Error('unexpected fill error');
    expect(fill.united).toBe(false);
    expect(fill.regions.reduce((sum, region) => sum + region.holes.length, 0)).toBe(6);
    expect(fill.regions.length).toBe(5);
  });

  it('anchors, spaces letters, reports unmapped characters and breaks lines', () => {
    const font = fira();
    const left = layoutText(font, 'LL', PLAIN);
    const center = layoutText(font, 'LL', { ...PLAIN, anchor: 'center' });
    const right = layoutText(font, 'LL', { ...PLAIN, anchor: 'right' });
    const minX = (layout: ReturnType<typeof layoutText>): number => Math.min(...layout.loops.map((loop) => loopBox(loop)?.min[0] ?? 0));
    expect(minX(center) - minX(left)).toBeCloseTo(-left.advanceWidth / 2, 9);
    expect(minX(right) - minX(left)).toBeCloseTo(-left.advanceWidth, 9);
    expect(layoutText(font, 'LL', { ...PLAIN, letterSpacing: 2 }).advanceWidth).toBeCloseTo(left.advanceWidth + 2, 9);
    expect(layoutText(font, 'A\u{1F600}', PLAIN).missing).toEqual(['\u{1F600}']);
    const two = layoutText(font, 'L\nL', { ...PLAIN, verticalAnchor: 'cap_top' });
    expect(two.lines).toBe(2);
    expect(Math.max(...two.loops.map((loop) => loopBox(loop)?.max[1] ?? 0))).toBeCloseTo(0, 9);
    const middle = layoutText(font, 'L', { ...PLAIN, verticalAnchor: 'cap_middle' });
    expect(Math.max(...middle.loops.map((loop) => loopBox(loop)?.max[1] ?? 0))).toBeCloseTo(5, 9);
  });

  it('applies kern pairs only when kerning is requested', () => {
    const font = fira();
    const a = font.glyphIndex(0x41);
    const v = font.glyphIndex(0x56);
    const off = layoutText(font, 'AV', PLAIN);
    const on = layoutText(font, 'AV', { ...PLAIN, kerning: true });
    expect(on.advanceWidth).toBeCloseTo(off.advanceWidth + font.kerning(a, v) * on.scale, 9);
  });
});

describe('lib/font hostile input (VC-WRP-20, fuzz corpus)', () => {
  it('refuses restricted embedding (fsType 2) and bitmap-only embedding', () => {
    const restricted = parseFont(withFsType(firaBytes(), 2));
    expect(restricted.ok ? null : restricted.code).toBe('WRP_FONT_EMBEDDING_RESTRICTED');
    const bitmap = parseFont(withFsType(firaBytes(), 0x0200));
    expect(bitmap.ok ? null : bitmap.code).toBe('WRP_FONT_EMBEDDING_RESTRICTED');
    const editable = parseFont(withFsType(firaBytes(), 8));
    expect(editable.ok ? editable.font.embedding : null).toBe('editable');
    const preview = parseFont(withFsType(firaBytes(), 4));
    expect(preview.ok ? preview.font.embedding : null).toBe('preview_print');
  });

  it('classifies non-fonts and unsupported containers with stable codes', () => {
    const code = (bytes: Uint8Array): string | null => {
      const parsed = parseFont(bytes);
      return parsed.ok ? null : parsed.code;
    };
    const tagged = (tag: string): Uint8Array => new Uint8Array([...tag].map((c) => c.charCodeAt(0)).concat(new Array<number>(40).fill(0)));
    expect(code(new TextEncoder().encode('this is not a font file at all'))).toBe('WRP_FONT_PARSE');
    expect(code(new Uint8Array(0))).toBe('WRP_FONT_PARSE');
    expect(code(tagged('OTTO'))).toBe('WRP_FONT_FORMAT_UNSUPPORTED');
    expect(code(tagged('wOFF'))).toBe('WRP_FONT_FORMAT_UNSUPPORTED');
    expect(code(tagged('wOF2'))).toBe('WRP_FONT_FORMAT_UNSUPPORTED');
    expect(code(tagged('ttcf'))).toBe('WRP_FONT_FORMAT_UNSUPPORTED');
    expect(code(new Uint8Array(5 * 1024 * 1024))).toBe('WRP_FONT_TOO_LARGE');
  });

  it('never throws and never reads out of range on truncated or corrupted fonts', () => {
    const original = firaBytes();
    let rejected = 0;
    for (const cut of [1, 11, 12, 100, 300, 1000, 5000, 100000, 300000, original.length - 1]) {
      const parsed = parseFont(original.subarray(0, cut));
      if (!parsed.ok) rejected += 1;
      else expect(() => validateGlyphs(parsed.font)).not.toThrow();
    }
    expect(rejected).toBeGreaterThan(5);
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 60; round++) {
      const copy = new Uint8Array(original);
      for (let hit = 0; hit < 40; hit++) copy[next() % 2000] = next() & 0xff;
      const parsed = parseFont(copy);
      if (parsed.ok) {
        const result = validateGlyphs(parsed.font);
        if (!result.ok) expect(result.code).toBe('WRP_FONT_PARSE');
      } else expect(parsed.code).toMatch(/^WRP_FONT_/);
    }
  });

  it('bounds composite glyphs: a glyph that includes itself is refused, not followed forever', () => {
    const bytes = new Uint8Array(firaBytes());
    const view = new DataView(bytes.buffer);
    const table = (tag: string): { offset: number; length: number } => {
      for (let k = 0, count = view.getUint16(4); k < count; k++) {
        const record = 12 + 16 * k;
        if (String.fromCharCode(...bytes.subarray(record, record + 4)) === tag)
          return { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) };
      }
      throw new Error(tag);
    };
    const head = table('head');
    const loca = table('loca');
    const glyf = table('glyf');
    const long = view.getInt16(head.offset + 50) === 1;
    const glyph = 5;
    const start = long ? view.getUint32(loca.offset + 4 * glyph) : 2 * view.getUint16(loca.offset + 2 * glyph);
    const end = long ? view.getUint32(loca.offset + 4 * glyph + 4) : 2 * view.getUint16(loca.offset + 2 * glyph + 2);
    expect(end - start).toBeGreaterThanOrEqual(22);
    const at = glyf.offset + start;
    view.setInt16(at, -1);
    view.setUint16(at + 10, 0x0001 | 0x0002 | 0x0020);
    view.setUint16(at + 12, glyph);
    view.setInt16(at + 14, 0);
    view.setInt16(at + 16, 0);
    view.setUint16(at + 18, 0x0001 | 0x0002);
    view.setUint16(at + 20, glyph);
    const parsed = parseFont(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(() => parsed.font.outline(glyph)).toThrow(/composite|nested/);
    const scan = validateGlyphs(parsed.font);
    expect(scan.ok ? null : scan.code).toBe('WRP_FONT_PARSE');
  });
});

describe('lib/font overlapping contours (TECHNICAL_SPEC §5.4)', () => {
  const loop = (points: Array<[number, number]>): OutlineLoop =>
    points.map((from, k) => ({ kind: 'line' as const, from, to: points[(k + 1) % points.length] as [number, number] }));
  const clockwise = (x: number, y: number, size: number): OutlineLoop =>
    loop([
      [x, y],
      [x, y + size],
      [x + size, y + size],
      [x + size, y],
    ]);
  const counter = (x: number, y: number, size: number): OutlineLoop =>
    loop([
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
    ]);

  it('unites two overlapping filled contours into one polygonal region and keeps a hole inside it', () => {
    const united = fillRegions([clockwise(0, 0, 10), clockwise(5, 5, 10), counter(2, 2, 2)]);
    if ('error' in united) throw new Error('unexpected');
    expect(united.united).toBe(true);
    expect(united.regions).toHaveLength(1);
    expect(united.regions[0]?.holes).toHaveLength(1);
    expect(Math.abs(loopArea(united.regions[0]?.outer ?? []))).toBeCloseTo(175, 6);
  });

  it('refuses a hole that crosses the united outline', () => {
    expect('error' in fillRegions([clockwise(0, 0, 10), clockwise(5, 5, 10), counter(8, 2, 4)])).toBe(true);
  });

  it('classifies nested loops by containment depth', () => {
    const nested = fillRegions([clockwise(0, 0, 20), counter(5, 5, 10), clockwise(8, 8, 4)]);
    if ('error' in nested) throw new Error('unexpected');
    expect(nested.regions).toHaveLength(2);
    expect(nested.regions.map((region) => region.holes.length).sort()).toEqual([0, 1]);
  });
});
