/**
 * 03 WRP vertical metrics variations and named instances (spec §14.18): `vhea` / `vmtx` advance heights moved by `VVAR` (with and without an advance-height map) or by the phantom points of a gvar font,
 * the fvar instance records resolved by subfamily or PostScript name (`parseFont(bytes, {}, name)`, `import_font instance`), and every damaged table. Expected values are written down by construction.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { parseFont, type ParsedFont } from '@lib/font/font';
import type { StoreSpec } from './cff2Builder';
import { AXES_OF_THE_FONT, TUPLES, t, variable } from './variableTrueType';
import { buildFvarWithInstances, buildVhea, buildVmtx, buildVvar } from './vvarBuilder';

const HEIGHTS = [1000, 1100, 1200, 1300, 1400];
/** wght+ moves the heights of glyph k by 10 k. */
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
const NAMES = [
  { platform: 3 as const, id: 258, text: 'Light' },
  { platform: 3 as const, id: 259, text: 'Regular' },
  { platform: 3 as const, id: 260, text: 'Bold' },
  { platform: 3 as const, id: 261, text: 'Condensed Bold' },
  { platform: 3 as const, id: 262, text: 'Test-Light' },
  { platform: 3 as const, id: 263, text: 'Test-Regular' },
  { platform: 3 as const, id: 264, text: 'Test-Bold' },
  { platform: 3 as const, id: 265, text: 'Test-CondBold' },
];
const INSTANCES = [
  { subfamily: 258, postScript: 262, coordinates: [200, 100] },
  { subfamily: 259, postScript: 263, coordinates: [400, 100] },
  { subfamily: 260, postScript: 264, coordinates: [700, 100] },
  { subfamily: 261, postScript: 265, coordinates: [700, 80] },
  { subfamily: 300, postScript: 265, coordinates: [900, 125] },
];

function font(bytes: Uint8Array, variation: Record<string, number> = {}, instance?: string): ParsedFont {
  const parsed = parseFont(bytes, variation, instance);
  if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.message}`);
  return parsed.font;
}
const refusal = (bytes: Uint8Array, variation: Record<string, number> = {}, instance?: string): { code: string; message: string } => {
  const parsed = parseFont(bytes, variation, instance);
  if (parsed.ok) throw new Error('expected a refusal');
  return parsed;
};
const withVertical = (extra: Record<string, readonly number[]> = {}, omit: readonly string[] = []): Uint8Array =>
  variable({ tables: { vhea: buildVhea(5), vmtx: buildVmtx(HEIGHTS, 5), VVAR: buildVvar(STORE), ...extra }, omit });
const heights = (parsed: ParsedFont): number[] => [0, 1, 2, 3, 4].map((glyph) => parsed.verticalAdvance(glyph));

describe('advance heights', () => {
  it('the default instance reads vmtx; at wght 900 VVAR moves glyph k by 10 k, at wght 650 (coordinate 0.5) by half of that, rounded', () => {
    const bytes = withVertical();
    expect(heights(font(bytes))).toEqual(HEIGHTS);
    expect(heights(font(bytes, { wght: 900 }))).toEqual([1000, 1110, 1220, 1330, 1440]);
    expect(heights(font(bytes, { wght: 650 }))).toEqual([1000, 1105, 1210, 1315, 1420]);
  });

  it('an advance-height map sends glyph k to row 3 - k (the last glyph to row 0)', () => {
    const bytes = variable({
      tables: { vhea: buildVhea(5), vmtx: buildVmtx(HEIGHTS, 5), VVAR: buildVvar(STORE, [3, 2, 1, 0, 0], { side: true }) },
    });
    expect(heights(font(bytes, { wght: 900 }))).toEqual([1030, 1120, 1210, 1300, 1400]);
  });

  it('a vhea with fewer long metrics repeats the last height for the glyphs after it', () => {
    const bytes = variable({ tables: { vhea: buildVhea(2), vmtx: buildVmtx([1000, 1100], 5) } });
    expect(heights(font(bytes))).toEqual([1000, 1100, 1100, 1100, 1100]);
  });

  it('without vhea / vmtx the height is ascender - descender (900 + 250), moved by VVAR all the same', () => {
    const bytes = variable({ tables: { VVAR: buildVvar(STORE) } });
    expect(heights(font(bytes))).toEqual([1150, 1150, 1150, 1150, 1150]);
    expect(heights(font(bytes, { wght: 900 }))).toEqual([1150, 1160, 1170, 1180, 1190]);
  });

  it('without VVAR a gvar font moves the height by its phantom points (the third minus the fourth: 30 - 10 = 20 at wght 900), and a static instance not at all', () => {
    const bytes = variable({
      tables: { vhea: buildVhea(5), vmtx: buildVmtx(HEIGHTS, 5) },
      gvar: { glyphs: [null, TUPLES[1] as never, { tuples: [t({ shared: 0, points: [5, 6], dx: [0, 0], dy: [30, 10] })] }, null, null] },
    });
    expect(heights(font(bytes, { wght: 900 }))).toEqual([1000, 1100, 1220, 1300, 1400]);
    expect(heights(font(bytes))).toEqual(HEIGHTS);
  });

  it('the heights are read once per glyph (the same number twice, from the memo)', () => {
    const parsed = font(withVertical(), { wght: 900 });
    expect(parsed.verticalAdvance(2)).toBe(parsed.verticalAdvance(2));
  });
});

describe('damaged vertical tables', () => {
  it('a VVAR of another version, with an offset outside the table, or with a damaged side-bearing map is WRP_FONT_PARSE at the instance (the default instance never reads it)', () => {
    for (const bad of [
      buildVvar(STORE, undefined, { version: 2 }),
      buildVvar(STORE, undefined, { offsets: [60_000, 0, 0, 0, 0] }),
      buildVvar(STORE, undefined, { offsets: [24, 0, 60_000, 0, 0] }),
      buildVvar(STORE, [3, 2, 1, 0, 0], { offsets: [24, 0, 0, 0, 60_000] }),
    ]) {
      const bytes = withVertical({ VVAR: bad });
      expect(refusal(bytes, { wght: 900 }).code).toBe('WRP_FONT_PARSE');
      expect(heights(font(bytes))).toEqual(HEIGHTS);
    }
  });

  it('a vhea with more long metrics than glyphs, and a vmtx shorter than its glyph count, are refused when a height is asked', () => {
    expect(() => font(variable({ tables: { vhea: buildVhea(9), vmtx: buildVmtx(HEIGHTS, 5) } })).verticalAdvance(0)).toThrow(/vhea/);
    expect(() => font(variable({ tables: { vhea: buildVhea(0), vmtx: buildVmtx(HEIGHTS, 5) } })).verticalAdvance(0)).toThrow(/vhea/);
    expect(() => font(variable({ tables: { vhea: buildVhea(5), vmtx: buildVmtx(HEIGHTS.slice(0, 3), 3) } })).verticalAdvance(0)).toThrow(
      /vmtx/,
    );
  });
});

describe('named instances', () => {
  const bytes = variable({ names: NAMES, tables: { fvar: buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true) } });

  it('lists the instances that have a name (an instance whose name id is not in the name table is left out), with their PostScript names and axis values', () => {
    expect(font(bytes).namedInstances).toEqual([
      { name: 'Light', postScriptName: 'Test-Light', variation: { wght: 200, wdth: 100 } },
      { name: 'Regular', postScriptName: 'Test-Regular', variation: { wght: 400, wdth: 100 } },
      { name: 'Bold', postScriptName: 'Test-Bold', variation: { wght: 700, wdth: 100 } },
      { name: 'Condensed Bold', postScriptName: 'Test-CondBold', variation: { wght: 700, wdth: 80 } },
    ]);
  });

  it('a name picks the instance (any case, a PostScript name too): the same font as the explicit axis values', () => {
    const explicit = font(bytes, { wght: 700 });
    for (const name of ['Bold', 'bold', '  BOLD ', 'Test-Bold']) {
      const named = font(bytes, {}, name);
      expect(named.instance).toEqual({ wght: 700 });
      expect(named.instance).toEqual(explicit.instance);
      expect([0, 1, 2, 3].map((g) => named.advance(g))).toEqual([0, 1, 2, 3].map((g) => explicit.advance(g)));
      expect(named.outline(1)).toEqual(explicit.outline(1));
    }
    expect(font(bytes, {}, 'Condensed Bold').instance).toEqual({ wdth: 80, wght: 700 });
    // the default instance has no axes that differ
    expect(font(bytes, {}, 'Regular').instance).toEqual({});
  });

  it('an unknown name lists the names the font has; a name together with axis values, or on a font without axes, is WRP_FONT_VARIATION', () => {
    const unknown = refusal(bytes, {}, 'Black');
    expect(unknown.code).toBe('WRP_FONT_VARIATION');
    expect(unknown.message).toContain('Light, Regular, Bold, Condensed Bold');
    expect(refusal(bytes, { wght: 700 }, 'Bold').message).toContain('not both');
    const none = refusal(variable({ omit: ['fvar'] }), {}, 'Bold');
    expect(none.code).toBe('WRP_FONT_VARIATION');
    expect(none.message).toContain('none');
  });

  it('the short instance records (no PostScript name id) give a name and no PostScript name', () => {
    const short = variable({ names: NAMES, tables: { fvar: buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES.slice(0, 2), false) } });
    expect(font(short).namedInstances.map((i) => [i.name, i.postScriptName])).toEqual([
      ['Light', null],
      ['Regular', null],
    ]);
  });

  it('damaged instance records: a record size that fits neither form, a value outside its axis, more instances than the cap', () => {
    const wrongSize = [...buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true)];
    wrongSize[15] = 13;
    expect(refusal(variable({ names: NAMES, tables: { fvar: wrongSize } })).code).toBe('WRP_FONT_PARSE');
    const outside = buildFvarWithInstances(AXES_OF_THE_FONT, [{ subfamily: 258, postScript: 262, coordinates: [2000, 100] }], true);
    expect(refusal(variable({ names: NAMES, tables: { fvar: outside } })).message).toContain('outside');
    const many = [...buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true)];
    many[12] = 0x13;
    many[13] = 0x88;
    expect(refusal(variable({ names: NAMES, tables: { fvar: many } })).message).toContain('exceed');
  });

  it('import_font instance="Bold" embeds the font at that instance, lists the named instances, and refuses a name that is not there or given with variation', () => {
    const base64 = Buffer.from(bytes).toString('base64');
    const doc = createEmptyDocument();
    const done = execute(doc, 'import_font', { base64, instance: 'Bold' });
    expect(done.rejected, done.summary).toBeUndefined();
    const data = done.data as { variation: Record<string, number>; namedInstances: Array<{ name: string }> };
    expect(data.variation).toEqual({ wght: 700 });
    expect(data.namedInstances.map((i) => i.name)).toEqual(['Light', 'Regular', 'Bold', 'Condensed Bold']);
    expect(execute(doc, 'import_font', { base64, instance: 'Black' }).error?.code).toBe('WRP_FONT_VARIATION');
    expect(execute(doc, 'import_font', { base64, instance: 'Bold', variation: { wght: 700 } }).error?.code).toBe('WRP_FONT_VARIATION');
  });
});
