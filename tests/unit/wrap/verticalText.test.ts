/**
 * 03 WRP vertical text layout (spec §14.20): glyphs stacked top to bottom by the vertical advance (vmtx, ascender - descender without it), hung from the vertical origin
 * (VORG of a CFF font, else the top of the glyph + its vmtx top side bearing, else the ascender; the middle of the advance width in x), columns running leftward one vertical line pitch apart.
 * Expected values are written down by construction on the fixture fonts: heights 1100 (A), 1200 (B), 1300 (C), 1400 (D), top side bearings 700 / 650 / 600 / 500 (A and B reach 100: origins 800 / 750),
 * widths 600 .. 900, ascender 900, descender -250, line gap 100 (hhea; vhea 900 / -250 / 0), cap height 700; height 7 gives 0.01 document units per font unit.
 */

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { uint8ArrayToBase64 } from '@lib/base64';
import { parseFont, type ParsedFont } from '@lib/font/font';
import { layoutText, type LayoutOptions, type TextLayout } from '@lib/font/layout';
import { loopBox } from '@lib/font/outline';
import { buildCffFont } from './cffBuilder';
import { expectRefusal } from '../../helpers/commandAssertions';
import { firaBytes } from './fixtures';
import { type StoreSpec } from './cff2Builder';
import { buildMvar } from './gvarBuilder';
import { buildVhea, buildVmtx, buildVvar } from './vvarBuilder';
import { cylinder, FACE, useFakeKernel } from './support';
import { t, variable } from './variableTrueType';

const HEIGHTS = [1000, 1100, 1200, 1300, 1400];
const TOPS = [0, 700, 650, 600, 500];
const withHeights = (extra: Record<string, readonly number[]> = {}): Uint8Array =>
  variable({ tables: { vhea: buildVhea(5), vmtx: buildVmtx(HEIGHTS, 5, TOPS), ...extra } });
afterEach(() => setGeometryKernel(null));
const u16 = (v: number): number[] => [(v >> 8) & 255, v & 255];
const vorg = (fallback: number, records: ReadonlyArray<readonly [number, number]>, version = 1): number[] => [
  ...u16(version),
  ...u16(0),
  ...u16(fallback & 0xffff),
  ...u16(records.length),
  ...records.flatMap(([glyph, y]) => [...u16(glyph), ...u16(y & 0xffff)]),
];

function parsed(bytes: Uint8Array): ParsedFont {
  const result = parseFont(bytes);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.font;
}

const VERTICAL: LayoutOptions = {
  height: 7,
  anchor: 'center',
  verticalAnchor: 'baseline',
  letterSpacing: 0,
  kerning: true,
  lineSpacing: 1,
  direction: 'vertical',
};
const layout = (font: ParsedFont, text: string, options: Partial<LayoutOptions> = {}): TextLayout =>
  layoutText(font, text, { ...VERTICAL, ...options });

/** [minX, minY, maxX, maxY] of glyph `index` of a layout, rounded to 1e-9. */
function box(placed: TextLayout, index: number): number[] {
  const boxes = (placed.glyphs[index]?.loops ?? []).map(loopBox).filter((b): b is NonNullable<typeof b> => b !== null);
  const round = (v: number): number => Math.round(v * 1e9) / 1e9;
  return [
    round(Math.min(...boxes.map((b) => b.min[0]))),
    round(Math.min(...boxes.map((b) => b.min[1]))),
    round(Math.max(...boxes.map((b) => b.max[0]))),
    round(Math.max(...boxes.map((b) => b.max[1]))),
  ];
}

describe('vertical layout on a font with vmtx', () => {
  const font = parsed(withHeights());

  it('stacks the glyphs by their advance heights, each hung from the top of the glyph + its top side bearing, at the middle of its advance width', () => {
    const placed = layout(font, 'AB');
    // A: square 0..100, advance 600, height 1100, origin 100 + 700 = 800: x -3..-2, y 0 - 8 .. 0 - 7; B: triangle, advance 700, origin 100 + 650 = 750, starts 11 lower: x -3.5..-2.5, y -11 - 7.5 .. -11 - 6.5
    expect(box(placed, 0)).toEqual([-3, -8, -2, -7]);
    expect(box(placed, 1)).toEqual([-3.5, -18.5, -2.5, -17.5]);
    expect(placed).toMatchObject({ direction: 'vertical', lines: 1, advanceWidth: 7, advanceHeight: 23 });
    expect(placed.glyphs.map((glyph) => glyph.advanceHeight)).toEqual([11, 12]);
    expect(placed.scale).toBeCloseTo(0.01, 12);
  });

  it('letter spacing goes between glyphs, vertically; kerning is not applied; a horizontal layout of the same text is unchanged', () => {
    const spaced = layout(font, 'AB', { letterSpacing: 2 });
    expect(box(spaced, 1)).toEqual([-3.5, -20.5, -2.5, -19.5]);
    expect(spaced.advanceHeight).toBe(25);
    const horizontal = layout(font, 'AB', { direction: 'horizontal' });
    expect(horizontal).toMatchObject({ direction: 'horizontal', advanceHeight: 0 });
    expect(box(horizontal, 0)).toEqual([-6.5, 0, -5.5, 1]);
  });

  it('cap_middle centres the column on y = 0, anchor left and right put the column edge on x = 0', () => {
    const middle = layout(font, 'AB', { verticalAnchor: 'cap_middle' });
    expect(box(middle, 0)).toEqual([-3, 3.5, -2, 4.5]);
    expect(box(layout(font, 'AB', { verticalAnchor: 'cap_top' }), 0)).toEqual(box(layout(font, 'AB'), 0));
    // the column is 7 wide (B): left puts its left edge on x = 0, right its right edge
    expect(box(layout(font, 'AB', { anchor: 'left' }), 1)).toEqual([0, -18.5, 1, -17.5]);
    expect(box(layout(font, 'AB', { anchor: 'left' }), 0)).toEqual([0.5, -8, 1.5, -7]);
    expect(box(layout(font, 'AB', { anchor: 'right' }), 1)).toEqual([-7, -18.5, -6, -17.5]);
  });

  it('a newline starts a column to the LEFT, one vertical line pitch (vhea 900 + 250 + 0 = 1150 font units, not the horizontal 1250) away; every column starts at the top', () => {
    const placed = layout(font, 'A\nB');
    expect(placed.lines).toBe(2);
    expect(box(placed, 0)).toEqual([-3, -8, -2, -7]);
    expect(box(placed, 1)).toEqual([-15, -7.5, -14, -6.5]);
    expect(placed.advanceHeight).toBe(12);
    expect(placed.advanceWidth).toBe(7);
    expect(font.verticalLine).toEqual({ height: 1150, source: 'vhea' });
    // lineSpacing 2 doubles the pitch
    expect(box(layout(font, 'A\nB', { lineSpacing: 2 }), 1)).toEqual([-26.5, -7.5, -25.5, -6.5]);
  });

  it('several columns with every anchor: the first column at the position, the later ones one pitch (11.5) further left, each aligned by its OWN width (AB is 7 wide, A is 6)', () => {
    // columns "AB" and "A": left puts each column's left edge on its x (0 and -11.5), right its right edge, center the middle
    const left = layout(font, 'AB\nA', { anchor: 'left' });
    expect(box(left, 0)).toEqual([0.5, -8, 1.5, -7]);
    expect(box(left, 1)).toEqual([0, -18.5, 1, -17.5]);
    expect(box(left, 2)).toEqual([-11.5, -8, -10.5, -7]);
    const right = layout(font, 'AB\nA', { anchor: 'right' });
    expect(box(right, 0)).toEqual([-6.5, -8, -5.5, -7]);
    expect(box(right, 2)).toEqual([-17.5, -8, -16.5, -7]);
    const center = layout(font, 'AB\nA');
    expect(box(center, 2)).toEqual([-14.5, -8, -13.5, -7]);
    expect(center).toMatchObject({ lines: 2, advanceWidth: 7, advanceHeight: 23 });
  });

  it('missing characters are listed once, a space takes its height, and the glyph count is one per character', () => {
    const placed = layout(font, 'A Z Z');
    expect(placed.glyphs).toHaveLength(5);
    expect(placed.missing).toEqual(['Z']);
    // glyph 0 (.notdef) has the height 1000 of its vmtx entry: space and Z both take it
    expect(placed.glyphs.map((glyph) => glyph.advanceHeight)).toEqual([11, 10, 10, 10, 10]);
  });
});

const STORE: StoreSpec = {
  axisCount: 2,
  regions: [
    [
      [0, 1, 1],
      [0, 0, 0],
    ],
  ],
  data: [{ regionIndexes: [0], rows: [[0], [10], [20], [30], [40]] }],
};

describe('the vertical origin of a font with vmtx: top of the glyph + top side bearing', () => {
  it('A (yMax 100, bearing 700) 800, B (100, 650) 750, C (a composite of two squares, 100, 600) 700, D (a 600-point staircase: highest point 49, bearing 500) 549; a blank glyph falls back to the ascender', () => {
    const font = parsed(withHeights());
    expect([1, 2, 3, 4].map((glyph) => font.verticalOrigin(glyph))).toEqual([
      { y: 800, source: 'vmtx' },
      { y: 750, source: 'vmtx' },
      { y: 700, source: 'vmtx' },
      { y: 549, source: 'vmtx' },
    ]);
    expect(font.verticalOrigin(0)).toEqual({ y: 900, source: 'ascender' });
  });

  it('a vmtx with fewer long metrics reads the bearings after them; without vhea / vmtx the origin is the ascender, and the layout differs from the vmtx one', () => {
    const short = parsed(
      variable({ tables: { vhea: buildVhea(2), vmtx: [...buildVmtx([1000, 1100], 2, [0, 700]), 0x02, 0x8a, 0x02, 0x8a, 0x02, 0x8a] } }),
    );
    // glyphs 2 and 3 and 4 take the bearings 650 (0x028a) after the two long metrics, and the height of the last long metric
    expect([1, 2, 4].map((glyph) => short.verticalOrigin(glyph).y)).toEqual([800, 750, 699]);
    expect(parsed(variable()).verticalOrigin(1)).toEqual({ y: 900, source: 'ascender' });
  });

  it('a VVAR with a top-side-bearing map moves the bearing: at wght 900 the glyph k is moved by the row of the map (A 20 -> 820); without the map, or at the default instance, nothing moves', () => {
    const mapped = variable({
      tables: { vhea: buildVhea(5), vmtx: buildVmtx(HEIGHTS, 5, TOPS), VVAR: buildVvar(STORE, [3, 2, 1, 0, 0], { side: true }) },
    });
    expect(parsed(mapped).verticalOrigin(1).y).toBe(800);
    const at900 = parseFont(mapped, { wght: 900 });
    if (!at900.ok) throw new Error(at900.message);
    expect(at900.font.verticalOrigin(1)).toEqual({ y: 820, source: 'vmtx' });
    expect(at900.font.verticalOrigin(2).y).toBe(750 + 10);
    const unmapped = variable({
      tables: { vhea: buildVhea(5), vmtx: buildVmtx(HEIGHTS, 5, TOPS), VVAR: buildVvar(STORE, [3, 2, 1, 0, 0]) },
    });
    const plain = parseFont(unmapped, { wght: 900 });
    if (!plain.ok) throw new Error(plain.message);
    expect(plain.font.verticalOrigin(1).y).toBe(800);
  });

  it('a gvar font without VVAR moves the origin with the top phantom point of the glyph (here +25 at wght 900) from the default outline', () => {
    const bytes = variable({
      gvar: { glyphs: [null, { tuples: [t({ shared: 0, points: [10], dx: [0], dy: [25] })] }, null, null, null] },
      tables: { vhea: buildVhea(5), vmtx: buildVmtx(HEIGHTS, 5, TOPS) },
    });
    expect(parsed(bytes).verticalOrigin(1).y).toBe(800);
    const at900 = parseFont(bytes, { wght: 900 });
    if (!at900.ok) throw new Error(at900.message);
    expect(at900.font.verticalOrigin(1)).toEqual({ y: 825, source: 'vmtx' });
    expect(at900.font.verticalOrigin(2).y).toBe(750);
  });

  it('the vertical line pitch is vhea ascender - descender + gap moved by MVAR vasc / vdsc / vlgp, the horizontal line height without vhea', () => {
    const store: StoreSpec = { ...STORE, data: [{ regionIndexes: [0], rows: [[0], [100], [50], [-20], [10]] }] };
    const bytes = variable({
      tables: {
        vhea: buildVhea(5),
        vmtx: buildVmtx(HEIGHTS, 5, TOPS),
        MVAR: buildMvar(
          [
            ['vasc', 0, 1],
            ['vlgp', 0, 3],
          ],
          store,
        ),
      },
    });
    expect(parsed(bytes).verticalLine).toEqual({ height: 1150, source: 'vhea' });
    const at900 = parseFont(bytes, { wght: 900 });
    if (!at900.ok) throw new Error(at900.message);
    // (900 + 100) - (-250) + (0 - 20)
    expect(at900.font.verticalLine).toEqual({ height: 1230, source: 'vhea' });
    // without vhea: the horizontal ascender - descender + gap (900 + 250 + 100)
    expect(parsed(variable()).verticalLine).toEqual({ height: 1250, source: 'hhea' });
    expect(box(layout(parsed(variable()), 'A\nB'), 1)).toEqual([-16, -9, -15, -8]);
  });
});

describe('vertical layout without vertical metrics, and VORG', () => {
  it('without vhea / vmtx every height is ascender - descender = 1150 and the glyph hangs from the ascender (the last resort)', () => {
    const font = parsed(variable());
    const placed = layout(font, 'AB');
    expect(font.verticalOrigin(1)).toEqual({ y: 900, source: 'ascender' });
    expect(box(placed, 0)).toEqual([-3, -9, -2, -8]);
    expect(box(placed, 1)).toEqual([-3.5, -20.5, -2.5, -19.5]);
    expect(placed.advanceHeight).toBe(23);
  });

  const SQUARE_TOKENS = [0, 0, 'rmoveto', 100, 0, 'rlineto', 0, 100, 'rlineto', -100, 0, 'rlineto', 'endchar'] as const;
  const cff = (table: number[] | null): ParsedFont =>
    parsed(
      buildCffFont(
        { glyphs: [{ tokens: ['endchar'] }, { tokens: SQUARE_TOKENS }, { tokens: SQUARE_TOKENS }] },
        table === null ? {} : { tables: { VORG: table } },
      ),
    );

  it('a CFF font with VORG hangs each glyph from its own vertical origin, the default for the glyphs without a record', () => {
    const font = cff(vorg(950, [[2, 700]]));
    expect(font.verticalOrigin(1)).toEqual({ y: 950, source: 'VORG' });
    expect(font.verticalOrigin(2)).toEqual({ y: 700, source: 'VORG' });
    const placed = layout(font, 'AB');
    // A hangs 9.5 below the top: y -9.5 .. -8.5; B starts 11.5 lower (no vmtx: 1150) and hangs 7 below: y -18.5 .. -17.5
    expect(box(placed, 0)).toEqual([-3, -9.5, -2, -8.5]);
    expect(box(placed, 1)).toEqual([-3, -18.5, -2, -17.5]);
  });

  it('a CFF font without VORG falls back to the ascender; a VORG on a TrueType font is not used', () => {
    expect(cff(null).verticalOrigin(1)).toEqual({ y: 900, source: 'ascender' });
    const truetype = parsed(variable({ tables: { VORG: vorg(500, []) } }));
    expect(truetype.verticalOrigin(1)).toEqual({ y: 900, source: 'ascender' });
    // with vmtx a TrueType font reads its bearings, never a VORG
    const withBearings = parsed(variable({ tables: { VORG: vorg(500, []), vhea: buildVhea(5), vmtx: buildVmtx(HEIGHTS, 5, TOPS) } }));
    expect(withBearings.verticalOrigin(1)).toEqual({ y: 800, source: 'vmtx' });
  });

  it('a negative origin and the binary search over many records are read', () => {
    const records = Array.from({ length: 60 }, (_, k) => [k + 3, 1000 + k] as const);
    const font = cff(vorg(-120, [[1, -50], ...records]));
    expect(font.verticalOrigin(1).y).toBe(-50);
    expect(font.verticalOrigin(2).y).toBe(-120);
  });

  it('a damaged VORG is a font parse error when a vertical origin is asked: version 2, shorter than its header, shorter than its records', () => {
    expect(() => cff(vorg(950, [], 2)).verticalOrigin(1)).toThrow(/VORG: version 2.0 is not 1.0/);
    expect(() => cff([0, 1, 0, 0]).verticalOrigin(1)).toThrow(/VORG: shorter than its 8-byte header/);
    expect(() => cff(vorg(950, [[1, 100]]).slice(0, 10)).verticalOrigin(1)).toThrow(/VORG: shorter than its record count/);
  });
});

function imported(bytes: Uint8Array): { doc: CadDocument; font: string } {
  const result = execute(createEmptyDocument(), 'import_font', { base64: uint8ArrayToBase64(bytes) });
  expect(result.rejected, result.summary).toBeUndefined();
  return { doc: result.document, font: (result.data as { id: string }).id };
}

describe('commands', () => {
  const { doc: base, font } = imported(withHeights());
  const text = (params: Record<string, unknown> = {}): { doc: CadDocument; id: string; result: ReturnType<typeof execute> } => {
    const result = execute(base, 'add_text', { content: 'AB', position: [0, 0, 0], height: 7, font, anchor: 'center', ...params });
    return { doc: result.document, id: result.affected[0] as string, result };
  };
  const outline = (doc: CadDocument, id: string, params: Record<string, unknown> = {}): Record<string, unknown> => {
    const result = execute(doc, 'text_outline', { id, ...params });
    expect(result.error, result.summary).toBeUndefined();
    return result.data as Record<string, unknown>;
  };

  it('add_text direction vertical is stored; text_outline reports the direction, the tallest column and the placed bbox, with the same area as the horizontal text', () => {
    const vertical = text({ direction: 'vertical' });
    expect(vertical.doc.entities[vertical.id]).toMatchObject({ direction: 'vertical' });
    const data = outline(vertical.doc, vertical.id);
    expect(data).toMatchObject({ direction: 'vertical', lines: 1 });
    expect(data['advanceWidth']).toBeCloseTo(7, 9);
    expect(data['advanceHeight']).toBeCloseTo(23, 9);
    const bbox = data['bbox'] as { min: number[]; max: number[] };
    expect(bbox.min[0]).toBeCloseTo(-3.5, 9);
    expect(bbox.max[0]).toBeCloseTo(-2, 9);
    expect(bbox.min[1]).toBeCloseTo(-18.5, 9);
    expect(bbox.max[1]).toBeCloseTo(-7, 9);
    // the square (1) and the triangle (0.5) keep their areas whatever the direction
    expect(data['area']).toBeCloseTo(1.5, 9);
    const horizontal = text();
    expect(horizontal.doc.entities[horizontal.id]).not.toHaveProperty('direction');
    const flat = outline(horizontal.doc, horizontal.id);
    expect(flat).toMatchObject({ direction: 'horizontal' });
    expect(flat).not.toHaveProperty('advanceHeight');
    expect(flat['area']).toBeCloseTo(1.5, 9);
  });

  it('text_outline direction overrides the entity setting both ways', () => {
    const horizontal = text();
    expect(outline(horizontal.doc, horizontal.id, { direction: 'vertical' })).toMatchObject({ direction: 'vertical' });
    const vertical = text({ direction: 'vertical' });
    expect(outline(vertical.doc, vertical.id, { direction: 'horizontal' })).toMatchObject({ direction: 'horizontal' });
  });

  it('refusals by name: vertical without a font, vertical on a curve, and text_outline asked for vertical on a text that follows a curve', () => {
    expectRefusal(
      base,
      'add_text',
      { content: 'AB', position: [0, 0, 0], height: 7, direction: 'vertical' },
      'WRP_TEXT_NO_FONT',
      'direction',
    );
    const curve = execute(base, 'draw_polyline', {
      points: [
        [0, 0],
        [50, 0],
      ],
    });
    const curveId = curve.affected[0] as string;
    expectRefusal(
      curve.document,
      'add_text',
      { content: 'AB', position: [0, 0, 0], height: 7, font, direction: 'vertical', onCurve: { curveId } },
      'WRP_TEXT_VERTICAL_CURVE',
      'direction',
    );
    const along = execute(curve.document, 'add_text', { content: 'AB', position: [0, 0, 0], height: 7, font, onCurve: { curveId } });
    expect(along.rejected, along.summary).toBeUndefined();
    expectRefusal(along.document, 'text_outline', { id: along.affected[0], direction: 'vertical' }, 'WRP_TEXT_VERTICAL_CURVE');
    const wrong = execute(base, 'add_text', { content: 'AB', position: [0, 0, 0], height: 7, font, direction: 'diagonal' });
    expect(wrong.document).toBe(base);
    expect(wrong.summary).toContain('invalid params');
  });

  it('font_metrics lists the vertical origin of every character with its source', () => {
    const result = execute(base, 'font_metrics', { font, text: 'AB' });
    expect(result.rejected, result.summary).toBeUndefined();
    const glyphs = (result.data as { glyphs: Array<{ verticalOrigin: unknown }> }).glyphs;
    expect(glyphs.map((glyph) => glyph.verticalOrigin)).toEqual([
      { y: 800, source: 'vmtx' },
      { y: 750, source: 'vmtx' },
    ]);
  });
});

describe('the wrap and extrusion paths read the direction of the text', () => {
  it('extrude_profile of the vertical AB (1.5 x depth 2 = volume 3): bbox x [-3.5, -2], y [-18.5, -7], z [0, 2]', async () => {
    setGeometryKernel(await createManifoldKernel());
    const { doc, font } = imported(withHeights());
    const label = execute(doc, 'add_text', {
      content: 'AB',
      position: [0, 0, 0],
      height: 7,
      font,
      anchor: 'center',
      direction: 'vertical',
    });
    const solid = execute(label.document, 'extrude_profile', { id: label.affected[0], depth: 2 });
    expect(solid.rejected, solid.summary).toBeUndefined();
    const id = solid.affected[0] as string;
    expect((execute(solid.document, 'mass_properties', { entityId: id }).data as { volume: number }).volume).toBeCloseTo(3, 6);
    const bounds = execute(solid.document, 'measure_bounding_box', { entityId: id }).data as { min: number[]; max: number[] };
    expect(bounds.min.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-3.5, -18.5, 0]);
    expect(bounds.max.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-2, -7, 2]);
  });
});

describe('a vertical text as the profile of an emboss on a cylinder (develop chart)', () => {
  useFakeKernel();

  const footprint = (direction: 'horizontal' | 'vertical'): { zs: number[]; loops: number; volume: number } => {
    const base = cylinder();
    const imported = execute(base.doc, 'import_font', { base64: uint8ArrayToBase64(withHeights()) });
    const font = (imported.data as { id: string }).id;
    const label = execute(imported.document, 'add_text', {
      content: 'AB',
      position: [0, 0, 0],
      height: 7,
      font,
      anchor: 'center',
      direction,
    });
    const result = execute(label.document, 'preview_emboss_on_face', {
      id: base.id,
      face: FACE,
      profileIds: [label.affected[0]],
      mode: 'emboss',
      depth: 1,
      placement: { method: 'develop' },
    });
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as { footprint: Array<{ points: number[][] }>; expectedVolumeDelta: number };
    return {
      zs: data.footprint.flatMap((loop) => loop.points.map((p) => p[2] as number)),
      loops: data.footprint.length,
      volume: data.expectedVolumeDelta,
    };
  };

  it('the footprint is the same two loops and the same relief volume (area 1.5 x depth 1 x (1 + 1 / 40) on the cylinder R 20) either way, but 11.5 tall along the axis when vertical and 1 when horizontal', () => {
    const vertical = footprint('vertical');
    const horizontal = footprint('horizontal');
    expect(vertical.loops).toBe(2);
    expect(horizontal.loops).toBe(2);
    expect(vertical.volume).toBeCloseTo(1.5 * 1.025, 6);
    expect(horizontal.volume).toBeCloseTo(1.5 * 1.025, 6);
    expect(Math.max(...vertical.zs) - Math.min(...vertical.zs)).toBeCloseTo(11.5, 6);
    expect(Math.max(...horizontal.zs) - Math.min(...horizontal.zs)).toBeCloseTo(1, 6);
  });
});

describe('real fonts', () => {
  it('Fira Sans (no vertical metrics): every height is ascender - descender, the column is the sum, the origin is the ascender', () => {
    const font = parsed(firaBytes());
    const scale = 7 / font.capHeight;
    const placed = layout(font, 'Hi');
    expect(font.verticalOrigin(font.glyphIndex(0x48))).toEqual({ y: font.ascender, source: 'ascender' });
    const expected = 2 * (font.ascender - font.descender) * scale;
    expect(placed.advanceHeight).toBeCloseTo(expected, 9);
    expect(font.verticalAdvance(font.glyphIndex(0x48))).toBe(font.ascender - font.descender);
  });

  const bahnschrift = 'C:/Windows/Fonts/bahnschrift.ttf';
  it.skipIf(!existsSync(bahnschrift))(
    'Bahnschrift (a variable system font with no vmtx) takes the ascender - descender fallback at its default instance',
    () => {
      const font = parsed(new Uint8Array(readFileSync(bahnschrift)));
      const glyph = font.glyphIndex(0x48);
      expect(font.verticalOrigin(glyph).source).toBe('ascender');
      expect(font.verticalAdvance(glyph)).toBe(font.ascender - font.descender);
      const placed = layout(font, 'HH');
      expect(placed.advanceHeight).toBeCloseTo((2 * (font.ascender - font.descender) * 7) / font.capHeight, 9);
    },
  );
});
