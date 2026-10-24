/**
 * 03 WRP M5 on a fake exact kernel: the single-line font and mode engrave, text on a curve, pattern_on_face. The exact solids are proved natively in server/tests/nativeWrapM5.test.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { setFontProvider } from '@core/commands/fontPort';
import { execute } from '@core/commands/registry';
import { parseFont } from '@lib/font/font';
import { readStrokeFont } from '@lib/font/stroke';
import { strokeRegions } from '@core/geometry/strokeRegions';
import { curveMapper } from '@core/geometry/textOnCurve';
import { expectRefusal } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';
import { bundledProvider, singleLineBytes } from './fixtures';
import { cylinder, FACE, make, rectangleOn, useFakeKernel, type Made } from './support';

const data = (result: ReturnType<typeof execute>): Record<string, unknown> => result.data as Record<string, unknown>;
const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const label = (made: Made, content: string, extra: Record<string, unknown> = {}): Made =>
  make(made.doc, 'add_text', { content, position: [0, 0, 0], height: 8, anchor: 'center', font: 'LLULL Single Line', ...extra });

describe('the single-line font', () => {
  it('parses as an open-stroke font: capitals and digits, lower case through the capitals, strokes in font units', () => {
    const parsed = parseFont(singleLineBytes());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const font = parsed.font;
    expect(font).toMatchObject({
      format: 'stroke',
      singleLine: true,
      unitsPerEm: 1000,
      capHeight: 700,
      capHeightSource: 'declared',
      embedding: 'installable',
    });
    expect(font.names).toMatchObject({ family: 'LLULL Single Line', licence: expect.stringContaining('CC0') });
    expect(font.glyphIndex(0x61)).toBe(font.glyphIndex(0x41));
    expect(font.glyphIndex(0x41)).toBeGreaterThan(0);
    expect(font.glyphIndex(0x4e2d)).toBe(0);
    expect(font.outline(font.glyphIndex(0x41))).toEqual([]);
    expect(font.strokes(font.glyphIndex(0x4c))[0]).toEqual([
      [50, 700],
      [50, 0],
      [500, 0],
    ]);
    expect(font.strokes(99999)).toEqual([]);
    expect(font.advance(font.glyphIndex(0x49))).toBe(300);
    expect(font.advance(-1)).toBe(0);
    expect(font.kerning(1, 2)).toBe(0);
    expect(() => font.scanGlyphs()).not.toThrow();
  });

  it('refuses a damaged stroke font with WRP_FONT_PARSE', () => {
    const good = JSON.parse(new TextDecoder().decode(singleLineBytes())) as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>): string => {
      const parsed = parseFont(encode({ ...good, ...patch }));
      if (parsed.ok) throw new Error('expected a refusal');
      expect(parsed.code).toBe('WRP_FONT_PARSE');
      return parsed.message;
    };
    expect(bad({ format: 'other' })).toContain('format');
    expect(bad({ version: 2 })).toContain('version');
    expect(bad({ unitsPerEm: 4 })).toContain('unitsPerEm');
    expect(bad({ capHeight: 0 })).toContain('capHeight');
    expect(bad({ family: '' })).toContain('family');
    expect(bad({ glyphs: [] })).toContain('glyphs');
    expect(bad({ glyphs: {} })).toContain('0 glyphs');
    expect(bad({ glyphs: { AB: { advance: 1, strokes: [] } } })).toContain('one character');
    expect(bad({ glyphs: { A: { advance: 'x', strokes: [] } } })).toContain('advance');
    expect(bad({ glyphs: { A: { advance: 1, strokes: [[]] } } })).toContain('points');
    expect(bad({ glyphs: { A: { advance: 1, strokes: [[[1, 'x']]] } } })).toContain('pair of finite');
    expect(bad({ glyphs: { A: { advance: 1, strokes: Array.from({ length: 65 }, () => [[0, 0]]) } } })).toContain('at most 64');
    expect(bad({ glyphs: { A: { advance: 1, strokes: [[[1e9, 0]]] } } })).toContain('pair of finite');
    const flood = { A: { advance: 1, strokes: Array.from({ length: 60 }, () => Array.from({ length: 1000 }, () => [0, 0])) } };
    expect(bad({ glyphs: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [String.fromCharCode(65 + k), flood.A])) })).toContain(
      'more than',
    );
    const garbled = parseFont(new TextEncoder().encode('{ not json'));
    expect(garbled.ok).toBe(false);
    expect(() => readStrokeFont(new Uint8Array([0x7b, 0xff, 0xfe]))).toThrow(/UTF-8/);
  });
});

describe('single-line text through the commands', () => {
  useFakeKernel();
  beforeEach(() => setFontProvider(bundledProvider()));

  it('text_outline: no area, open strokes with a length; the font is embedded as a font/x-llull-stroke blob', () => {
    const base = cylinder();
    const text = label(base, 'LLULL');
    const outline = execute(text.doc, 'text_outline', { id: text.id });
    expect(outline.rejected, outline.summary).toBeUndefined();
    const info = data(outline);
    expect(info).toMatchObject({ area: 0, loops: 0, singleLine: true, exact: true });
    expect(info['strokes']).toBeGreaterThan(0);
    // L: 700 + 450 font units, three of them, plus U (two sides, a half circle) and the L pair: just bound the sum
    expect(info['outlineLength']).toBeGreaterThan(30);
    const font = Object.values(text.doc.fonts ?? {})[0];
    expect(font).toMatchObject({ format: 'stroke', family: 'LLULL Single Line' });
    expect(text.doc.blobs?.[font?.blob as string]?.mediaType).toBe('font/x-llull-stroke');
  });

  it('wrap_to_face wraps the strokes as open curves of equal length; extrude_profile refuses them', () => {
    const base = cylinder();
    const text = label(base, 'LLULL');
    const outline = execute(text.doc, 'text_outline', { id: text.id });
    const wrapped = execute(text.doc, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [text.id] });
    expect(wrapped.rejected, wrapped.summary).toBeUndefined();
    const curves = (data(wrapped)['curves'] as Array<{ role: string; length3d: number; chartLength: number }>) ?? [];
    expect(curves.every((curve) => curve.role === 'open')).toBe(true);
    expect(curves.length).toBe(data(outline)['strokes']);
    expect(
      relative(
        curves.reduce((sum, curve) => sum + curve.length3d, 0),
        data(outline)['outlineLength'] as number,
      ),
    ).toBeLessThan(1e-4);
    expectRefusal(text.doc, 'extrude_profile', { id: text.id, depth: 1 }, 'WRP_TEXT_SINGLE_LINE', 'id');
  });
});

describe('emboss_on_face mode engrave', () => {
  useFakeKernel();
  beforeEach(() => setFontProvider(bundledProvider()));

  it('a straight stroke of length 30 cut with a 2 mm tool is a stadium: 30 x 2 + pi x 1^2, depth 0.5, a deboss on the cylinder', () => {
    const base = cylinder();
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [-15, 0],
        [15, 0],
      ],
    });
    const result = execute(line.doc, 'emboss_on_face', {
      id: base.id,
      face: FACE,
      profileIds: [line.id],
      mode: 'engrave',
      depth: 0.5,
      toolWidth: 2,
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const info = data(result);
    expect(info).toMatchObject({ mode: 'engrave', toolWidth: 2, exact: false, regions: 1 });
    expect(relative(info['strokeLength'] as number, 30)).toBeLessThan(1e-12);
    // the half-discs are 8-gons per quarter turn: the polygon area is a hair below the exact stadium
    expect(relative(info['regionArea'] as number, 60 + Math.PI)).toBeLessThan(5e-3);
    expect(info['expectedVolumeDelta']).toBeLessThan(0);
    expect(info['volumeDelta']).toBeLessThan(0);
    expect(result.summary).toContain('tool 2');
    expectPure(line.doc, () =>
      execute(line.doc, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [line.id], mode: 'engrave', depth: 0.5, toolWidth: 2 }),
    );
  });

  it('engraves single-line text: the groove area is about the stroke length times the tool width', () => {
    const base = cylinder();
    const text = label(base, 'LLULL');
    const outline = data(execute(text.doc, 'text_outline', { id: text.id }));
    const result = execute(text.doc, 'emboss_on_face', {
      id: base.id,
      face: FACE,
      profileIds: [text.id],
      mode: 'engrave',
      depth: 0.4,
      toolWidth: 0.8,
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const area = data(result)['regionArea'] as number;
    const bounds = (outline['outlineLength'] as number) * 0.8;
    expect(area).toBeGreaterThan(0.7 * bounds);
    expect(area).toBeLessThan(1.15 * bounds + 20);
    expect(data(result)['unverified']).toBe(false);
    expect(data(result)['volumeDelta']).toBeLessThan(0);
  });

  it('engraves the contour of a closed shape (a ring-shaped groove with a hole), and refuses missing or bad parameters', () => {
    const base = cylinder();
    const square = rectangleOn(base.doc, 20, 20);
    const result = execute(square.doc, 'emboss_on_face', {
      id: base.id,
      face: FACE,
      profileIds: [square.id],
      mode: 'engrave',
      depth: 0.5,
      toolWidth: 1,
    });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(data(result)['loops']).toBe(2);
    expect(relative(data(result)['strokeLength'] as number, 80)).toBeLessThan(1e-9);
    expect(relative(data(result)['regionArea'] as number, 80 + Math.PI * 0.25)).toBeLessThan(0.02);
    const line = make(base.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [10, 0],
      ],
    });
    expectRefusal(
      line.doc,
      'emboss_on_face',
      { id: base.id, face: FACE, profileIds: [line.id], mode: 'engrave', depth: 0.5 },
      'WRP_PARAM_INVALID',
      'toolWidth',
    );
    expectRefusal(
      line.doc,
      'emboss_on_face',
      { id: base.id, face: FACE, profileIds: [line.id], mode: 'engrave', toolWidth: 1 },
      'WRP_DEPTH_INVALID',
      'depth',
    );
    expectRefusal(
      line.doc,
      'emboss_on_face',
      { id: base.id, face: FACE, profileIds: [line.id], mode: 'deboss', depth: 0.5 },
      'WRP_PROFILE_OPEN',
      'profileIds.0',
    );
    expectRefusal(
      line.doc,
      'emboss_on_face',
      { id: base.id, face: FACE, profileIds: [line.id], mode: 'engrave', depth: 30, toolWidth: 1 },
      'WRP_DEPTH_EXCEEDS_SOLID',
      'depth',
    );
    const point = make(base.doc, 'draw_point', { position: [0, 0, 0] });
    expectRefusal(
      point.doc,
      'emboss_on_face',
      { id: base.id, face: FACE, profileIds: [point.id], mode: 'engrave', depth: 0.5, toolWidth: 1 },
      'WRP_PROFILE_EMPTY',
    );
  });
});

describe('strokeRegions (the swept tool)', () => {
  it('unites crossing strokes into one region and an island into a hole', () => {
    const plus = strokeRegions(
      [
        [
          [-5, 0],
          [5, 0],
        ],
        [
          [0, -5],
          [0, 5],
        ],
      ],
      1,
    );
    expect('error' in plus).toBe(false);
    if ('error' in plus) return;
    expect(plus).toHaveLength(1);
    expect(plus[0]?.holes).toHaveLength(0);
    const ring = strokeRegions(
      [
        Array.from({ length: 25 }, (_, k): [number, number] => [
          5 * Math.cos((2 * Math.PI * k) / 24),
          5 * Math.sin((2 * Math.PI * k) / 24),
        ]),
      ],
      1,
    );
    expect('error' in ring).toBe(false);
    if ('error' in ring) return;
    expect(ring).toHaveLength(1);
    expect(ring[0]?.holes).toHaveLength(1);
    const dot = strokeRegions([[[1, 1]]], 2);
    expect('error' in dot || dot.length === 1).toBe(true);
  });

  it('refuses a non-positive width, nothing to sweep, and too many segments', () => {
    expect(
      strokeRegions(
        [
          [
            [0, 0],
            [1, 0],
          ],
        ],
        0,
      ),
    ).toEqual({ error: expect.stringContaining('width') });
    expect(
      strokeRegions(
        [
          [
            [0, 0],
            [0, 0],
          ],
        ],
        1,
      ),
    ).toEqual({ error: expect.stringContaining('no length') });
    expect(strokeRegions([Array.from({ length: 3002 }, (_, k): [number, number] => [k, 0])], 1)).toEqual({
      error: expect.stringContaining('exceed'),
    });
  });
});

describe('text on a curve', () => {
  useFakeKernel();
  beforeEach(() => setFontProvider(bundledProvider()));

  const arc = (made: Made, radius = 40, sweep = Math.PI): Made =>
    make(made.doc, 'draw_arc', { center: [0, 0], radius, startAngle: 0, endAngle: sweep });

  it('bends Fira Sans along a half circle of radius 40: the baseline keeps its length, the outline is polygonal and stays near the arc', () => {
    const base = cylinder();
    const curve = arc(base);
    const flat = make(curve.doc, 'add_text', { content: 'LLULL', position: [0, 0, 0], height: 6, anchor: 'center', font: 'Fira Sans' });
    const bent = make(flat.doc, 'add_text', {
      content: 'LLULL',
      position: [0, 0, 0],
      height: 6,
      anchor: 'center',
      font: 'Fira Sans',
      onCurve: { curveId: curve.id },
    });
    const flatInfo = data(execute(bent.doc, 'text_outline', { id: flat.id }));
    const info = data(execute(bent.doc, 'text_outline', { id: bent.id }));
    expect(info).toMatchObject({ exact: false, onCurve: { curveId: curve.id } });
    expect(flatInfo['exact']).toBe(true);
    // letters stand on the left of the counter-clockwise arc, i.e. inside the circle: the area shrinks a little, never by more than a few percent
    expect(relative(info['area'] as number, flatInfo['area'] as number)).toBeLessThan(0.15);
    expect(info['area'] as number).toBeLessThan(flatInfo['area'] as number);
    const box = info['bbox'] as { min: number[]; max: number[] };
    expect(box.max[1]).toBeGreaterThan(30);
  });

  it('anchors: left starts at the start of the curve, right ends at its end; reverse runs the other way; offset slides along', () => {
    const base = cylinder();
    const curve = make(base.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [60, 0],
      ],
    });
    const at = (extra: Record<string, unknown>): { min: [number, number]; max: [number, number] } => {
      const text = make(curve.doc, 'add_text', { content: 'LLULL', position: [0, 0, 0], height: 6, font: 'Fira Sans', ...extra });
      return data(execute(text.doc, 'text_outline', { id: text.id }))['bbox'] as { min: [number, number]; max: [number, number] };
    };
    const left = at({ anchor: 'left', onCurve: { curveId: curve.id } });
    expect(left.min[0]).toBeGreaterThanOrEqual(-1e-9);
    expect(left.min[0]).toBeLessThan(2);
    const right = at({ anchor: 'right', onCurve: { curveId: curve.id } });
    expect(right.max[0]).toBeLessThanOrEqual(60 + 1e-9);
    expect(right.max[0]).toBeGreaterThan(55);
    const centre = at({ anchor: 'center', onCurve: { curveId: curve.id } });
    expect((centre.min[0] + centre.max[0]) / 2).toBeCloseTo(30, 0);
    const moved = at({ anchor: 'left', onCurve: { curveId: curve.id, offset: 10 } });
    expect(moved.min[0] - left.min[0]).toBeCloseTo(10, 6);
    // glyph tops stand on the left of travel (above for a left-to-right line); reversed they hang below, running right to left
    expect(left.min[1]).toBeGreaterThanOrEqual(-0.3);
    const reversed = at({ anchor: 'left', onCurve: { curveId: curve.id, reverse: true } });
    expect(reversed.max[1]).toBeLessThanOrEqual(0.3);
    expect(reversed.max[0]).toBeLessThanOrEqual(60);
    expect(reversed.max[0]).toBeGreaterThan(58);
  });

  it('refuses a missing curve, a non-curve, another plane, text without a font, and text longer than the curve', () => {
    const base = cylinder();
    const curve = make(base.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [20, 0],
      ],
    });
    const text = { content: 'LLULL CAD 2026', position: [0, 0, 0], height: 6, font: 'Fira Sans' };
    expectRefusal(curve.doc, 'add_text', { ...text, onCurve: { curveId: 'nope' } }, 'WRP_TEXT_CURVE_INVALID', 'onCurve.curveId');
    expectRefusal(curve.doc, 'add_text', { ...text, onCurve: { curveId: base.id } }, 'WRP_TEXT_CURVE_INVALID');
    expectRefusal(
      curve.doc,
      'add_text',
      { ...text, rotation: [0, 0.5, 0], onCurve: { curveId: curve.id } },
      'WRP_TEXT_CURVE_PLANE',
      'rotation',
    );
    expectRefusal(
      curve.doc,
      'add_text',
      { content: 'AB', position: [0, 0, 0], height: 6, onCurve: { curveId: curve.id } },
      'WRP_TEXT_NO_FONT',
      'onCurve',
    );
    const long = make(curve.doc, 'add_text', { ...text, onCurve: { curveId: curve.id } });
    expectRefusal(long.doc, 'text_outline', { id: long.id }, 'WRP_TEXT_CURVE_TOO_SHORT');
    // the curve disappears after the text was made
    const gone = execute(long.doc, 'delete_entities', { ids: [curve.id] });
    expectRefusal(gone.document, 'text_outline', { id: long.id }, 'WRP_TEXT_CURVE_INVALID');
    expect(curveMapper([[0, 0]], 'left', 0, false, [0, 0])).toBeNull();
    expect(
      curveMapper(
        [
          [0, 0],
          [0, 0],
        ],
        'left',
        0,
        false,
        [0, 0],
      ),
    ).toBeNull();
  });

  it('bent text can be wrapped and embossed on a cylinder like any text', () => {
    const base = cylinder();
    const curve = make(base.doc, 'draw_polyline', {
      points: [
        [-20, 0],
        [20, 0],
      ],
    });
    const text = make(curve.doc, 'add_text', {
      content: 'LLULL',
      position: [0, 0, 0],
      height: 5,
      anchor: 'center',
      font: 'Fira Sans',
      onCurve: { curveId: curve.id },
    });
    const result = execute(text.doc, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [text.id], mode: 'emboss', depth: 0.5 });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(data(result)['expectedVolumeDelta']).toBeGreaterThan(0);
  });
});

describe('pattern_on_face', () => {
  useFakeKernel();

  const square = (made: Made): Made => rectangleOn(made.doc, 4, 4);

  it('a 3 x 2 grid of 4 x 4 squares: six copies, six times the area, the closed form of one emboss', () => {
    const base = cylinder();
    const seed = square(base);
    const one = execute(seed.doc, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [seed.id], mode: 'emboss', depth: 1 });
    const grid = { countX: 3, countY: 2, pitchX: 8, pitchY: 6 };
    const result = execute(seed.doc, 'pattern_on_face', {
      id: base.id,
      face: FACE,
      seedProfileIds: [seed.id],
      mode: 'emboss',
      depth: 1,
      grid,
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const info = data(result);
    expect(info).toMatchObject({ instances: 6, regions: 6, grid });
    expect(relative(info['regionArea'] as number, 6 * (data(one)['regionArea'] as number))).toBeLessThan(1e-12);
    expect(relative(info['expectedVolumeDelta'] as number, 6 * (data(one)['expectedVolumeDelta'] as number))).toBeLessThan(1e-9);
    expect(result.summary).toContain('6 instances');
    expectPure(seed.doc, () =>
      execute(seed.doc, 'pattern_on_face', { id: base.id, face: FACE, seedProfileIds: [seed.id], mode: 'emboss', depth: 1, grid }),
    );
    const single = execute(seed.doc, 'pattern_on_face', {
      id: base.id,
      face: FACE,
      seedProfileIds: [seed.id],
      mode: 'emboss',
      depth: 1,
      grid: { countX: 1, countY: 1, pitchX: 1, pitchY: 1 },
    });
    expect(data(single)['expectedVolumeDelta']).toBeCloseTo(data(one)['expectedVolumeDelta'] as number, 12);
    const cut = execute(seed.doc, 'pattern_on_face', {
      id: base.id,
      face: FACE,
      seedProfileIds: [seed.id],
      mode: 'deboss',
      depth: 1,
      grid,
    });
    expect(data(cut)['expectedVolumeDelta']).toBeLessThan(0);
    const scribe = execute(seed.doc, 'pattern_on_face', { id: base.id, face: FACE, seedProfileIds: [seed.id], mode: 'scribe', grid });
    expect(scribe.rejected, scribe.summary).toBeUndefined();
  });

  it('refuses overlapping copies, a copy leaving the face, too many copies, bad seeds and parameters', () => {
    const base = cylinder();
    const seed = square(base);
    const params = { id: base.id, face: FACE, seedProfileIds: [seed.id], mode: 'emboss', depth: 1 };
    expectRefusal(
      seed.doc,
      'pattern_on_face',
      { ...params, grid: { countX: 2, countY: 1, pitchX: 3, pitchY: 6 } },
      'WRP_PATTERN_OVERLAP',
      'grid',
    );
    expectRefusal(seed.doc, 'pattern_on_face', { ...params, grid: { countX: 1, countY: 2, pitchX: 6, pitchY: 3 } }, 'WRP_PATTERN_OVERLAP');
    expectRefusal(
      seed.doc,
      'pattern_on_face',
      { ...params, grid: { countX: 1, countY: 20, pitchX: 6, pitchY: 6 } },
      'WRP_OUTSIDE_FACE',
      'grid',
    );
    expectRefusal(
      seed.doc,
      'pattern_on_face',
      { ...params, grid: { countX: 200, countY: 20, pitchX: 6, pitchY: 6 } },
      'WRP_PARAM_INVALID',
      'grid',
    );
    expectRefusal(
      seed.doc,
      'pattern_on_face',
      { ...params, depth: 0, grid: { countX: 2, countY: 1, pitchX: 6, pitchY: 6 } },
      'WRP_DEPTH_INVALID',
    );
    expectRefusal(
      seed.doc,
      'pattern_on_face',
      { ...params, seedProfileIds: ['nope'], grid: { countX: 2, countY: 1, pitchX: 6, pitchY: 6 } },
      'WRP_ENTITY_NOT_FOUND',
    );
  });
});
