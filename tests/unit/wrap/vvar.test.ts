/**
 * 03 WRP vertical metrics variations and named instances (spec §14.18): `vhea` / `vmtx` advance heights moved by `VVAR` (with and without an advance-height map) or by the phantom points of a gvar font,
 * the fvar instance records resolved by subfamily or PostScript name (`parseFont(bytes, {}, name)`, `import_font instance`), and every damaged table. Expected values are written down by construction.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { parseFont, type ParsedFont } from '@lib/font/font';
import { buildHvar, type StoreSpec } from './cff2Builder';
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

  it('a damaged instance record leaves that instance out (and says why); a record table that cannot be read leaves them all out; the font stays usable', () => {
    const wrongSize = [...buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true)];
    wrongSize[15] = 13;
    const noSize = font(variable({ names: NAMES, tables: { fvar: wrongSize } }));
    expect(noSize.namedInstances).toEqual([]);
    expect(noSize.namedInstanceProblems.join(' ')).toContain('instance records of 13 bytes');
    const outside = buildFvarWithInstances(
      AXES_OF_THE_FONT,
      [
        { subfamily: 258, postScript: 262, coordinates: [2000, 100] },
        { subfamily: 260, postScript: 264, coordinates: [700, 100] },
      ],
      true,
    );
    const partly = font(variable({ names: NAMES, tables: { fvar: outside } }));
    expect(partly.namedInstances.map((i) => i.name)).toEqual(['Bold']);
    expect(partly.namedInstanceProblems.join(' ')).toContain('named instance 0 has wght = 2000 outside 100..900; left out');
    const many = [...buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true)];
    many[12] = 0x13;
    many[13] = 0x88;
    expect(font(variable({ names: NAMES, tables: { fvar: many } })).namedInstanceProblems.join(' ')).toContain('exceed');
    const cut = buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true);
    expect(font(variable({ names: NAMES, tables: { fvar: cut.slice(0, cut.length - 30) } })).namedInstanceProblems.join(' ')).toContain(
      'run past the table',
    );
    // the other uses of the font are not affected, and the problems reach import_font
    expect(font(variable({ names: NAMES, tables: { fvar: wrongSize } }), { wght: 700 }).instance).toEqual({ wght: 700 });
    const imported = execute(createEmptyDocument(), 'import_font', {
      base64: Buffer.from(variable({ names: NAMES, tables: { fvar: outside } })).toString('base64'),
    });
    expect((imported.data as { namedInstanceProblems: string[] }).namedInstanceProblems).toHaveLength(1);
  });

  it('a name is read in every language: the English record is the primary one even when a localised record comes later, and either name picks the instance', () => {
    const localised = [
      ...NAMES.filter((n) => n.id !== 260),
      { platform: 3 as const, id: 260, text: 'Bold', language: 0x0409 },
      { platform: 3 as const, id: 260, text: 'Gras', language: 0x040c },
    ];
    const bytes = variable({ names: localised, tables: { fvar: buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true) } });
    expect(font(bytes).namedInstances.map((i) => i.name)).toEqual(['Light', 'Regular', 'Bold', 'Condensed Bold']);
    expect(font(bytes, {}, 'Gras').instance).toEqual({ wght: 700 });
    expect(font(bytes, {}, 'Bold').instance).toEqual({ wght: 700 });
    // the localised record first in the table: the English one is still primary
    const reversed = [
      ...NAMES.filter((n) => n.id !== 260),
      { platform: 3 as const, id: 260, text: 'Gras', language: 0x040c },
      { platform: 3 as const, id: 260, text: 'Bold', language: 0x0409 },
    ];
    const other = variable({ names: reversed, tables: { fvar: buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true) } });
    expect(font(other).namedInstances[2]?.name).toBe('Bold');
    // a Macintosh English record ranks under Windows English and over a Windows record of another language
    const mac = [
      ...NAMES.filter((n) => n.id !== 260),
      { platform: 3 as const, id: 260, text: 'Gras', language: 0x040c },
      { platform: 1 as const, id: 260, text: 'Bold' },
    ];
    expect(
      font(variable({ names: mac, tables: { fvar: buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true) } })).namedInstances[2]?.name,
    ).toBe('Bold');
  });

  it('the 600th name record is read (no cap of 512 on the records that are kept), and 20 languages of one name keep 16', () => {
    const filler = Array.from({ length: 600 }, (_, k) => ({ platform: 3 as const, id: 1000 + k, text: `n${k}`, language: 0x0409 }));
    const bytes = variable({ names: [...filler, ...NAMES], tables: { fvar: buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true) } });
    expect(font(bytes).namedInstances).toHaveLength(4);
    const many = Array.from({ length: 20 }, (_, k) => ({ platform: 3 as const, id: 260, text: `Bold${k}`, language: 0x0500 + k }));
    const crowded = variable({
      names: [...NAMES.filter((n) => n.id !== 260), ...many],
      tables: { fvar: buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true) },
    });
    expect(font(crowded, {}, 'Bold15').instance).toEqual({ wght: 700 });
    expect(refusal(crowded, {}, 'Bold17').code).toBe('WRP_FONT_VARIATION');
  });

  it('an ItemVariationStore that starts inside the header of an HVAR or a VVAR is WRP_FONT_PARSE', () => {
    const inside = withVertical({ VVAR: buildVvar(STORE, undefined, { offsets: [8, 0, 0, 0, 0] }) });
    expect(refusal(inside, { wght: 900 }).message).toContain('VVAR');
    const hvar = buildHvar(STORE);
    hvar[4] = 0;
    hvar[5] = 0;
    hvar[6] = 0;
    hvar[7] = 8;
    expect(refusal(variable({ tables: { HVAR: hvar } }), { wght: 900 }).message).toContain('HVAR');
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

describe('font_metrics', () => {
  const bytes = variable({
    names: NAMES,
    tables: {
      fvar: buildFvarWithInstances(AXES_OF_THE_FONT, INSTANCES, true),
      vhea: buildVhea(5),
      vmtx: buildVmtx(HEIGHTS, 5),
      VVAR: buildVvar(STORE),
    },
  });
  const imported = execute(createEmptyDocument(), 'import_font', { base64: Buffer.from(bytes).toString('base64') });
  const doc = imported.document;
  const id = imported.affected[0] as string;

  it('gives the vertical metrics and the advance width and height of each character at the default instance and at a named one', () => {
    const base = execute(doc, 'font_metrics', { font: id, text: 'AB' });
    expect(base.rejected, base.summary).toBeUndefined();
    const data = base.data as {
      unitsPerEm: number;
      ascender: number;
      glyphs: Array<{ character: string; glyph: number; advanceWidth: number; advanceHeight: number }>;
      height: number;
      width: number;
    };
    expect(data.unitsPerEm).toBe(1000);
    expect(data.glyphs.map((g) => [g.character, g.glyph, g.advanceWidth, g.advanceHeight])).toEqual([
      ['A', 1, 600, 1100],
      ['B', 2, 700, 1200],
    ]);
    expect([data.width, data.height]).toEqual([1300, 2300]);
    // the instance moves the heights: wght 700 is coordinate 0.6 (VVAR 10 k)
    const bold = execute(doc, 'font_metrics', { font: id, text: 'AB', instance: 'Bold' }).data as {
      glyphs: Array<{ advanceHeight: number }>;
      instance: unknown;
    };
    expect(bold.instance).toEqual({ wght: 700 });
    expect(bold.glyphs.map((g) => g.advanceHeight)).toEqual([1106, 1212]);
    expect(base.document).toBe(doc);
  });

  it('refuses an unknown font and an instance or variation the font does not have, by code', () => {
    expect(execute(doc, 'font_metrics', { font: 'nope' }).error?.code).toBe('WRP_FONT_UNAVAILABLE');
    expect(execute(doc, 'font_metrics', { font: id, instance: 'Black' }).error?.code).toBe('WRP_FONT_VARIATION');
    expect(execute(doc, 'font_metrics', { font: id, instance: 'Bold', variation: { wght: 700 } }).error?.code).toBe('WRP_FONT_VARIATION');
    const metricsOnly = execute(doc, 'font_metrics', { font: id });
    expect((metricsOnly.data as { glyphs: unknown[] }).glyphs).toEqual([]);
  });
});
