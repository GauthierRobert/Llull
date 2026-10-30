/**
 * 03 WRP M4: variable-font instances through the commands. import_font / add_text / add_decal take `variation`; one font blob backs one record per instance; text_outline,
 * extrude_profile, emboss_on_face and wrap_to_face read the instance; the document round trip and replay keep it. The font is the generated CFF2 font of variableFonts.ts.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { uint8ArrayToBase64 } from '@lib/base64';
import type { CadDocument } from '@core/model/types';
import { expectRefusal } from '../../helpers/commandAssertions';
import { cylinder, emptyDoc, FACE, useFakeKernel } from './support';
import { firaBytes } from './fixtures';
import { variableFont } from './variableFonts';

const base64 = (hvar = false): string => uint8ArrayToBase64(variableFont({ avar: true, hvar }));
const outlineData = (doc: CadDocument, id: string): { area: number; advanceWidth: number; bbox: number[] } =>
  execute(doc, 'text_outline', { id }).data as { area: number; advanceWidth: number; bbox: number[] };

function imported(
  variation?: Record<string, number>,
  doc: CadDocument = emptyDoc(),
): { doc: CadDocument; id: string; data: Record<string, unknown> } {
  const result = execute(doc, 'import_font', { base64: base64(true), ...(variation === undefined ? {} : { variation }) });
  expect(result.rejected, result.summary).toBeUndefined();
  return { doc: result.document, id: (result.data as { id: string }).id, data: result.data as Record<string, unknown> };
}

describe('import_font with a variation', () => {
  it('lists the axes, records the instance, and shares one blob between instance records', () => {
    const first = imported();
    expect(first.data).toMatchObject({
      format: 'cff',
      variation: {},
      existing: false,
      axes: [
        { tag: 'wght', min: 100, default: 400, max: 900 },
        { tag: 'wdth', min: 75, default: 100, max: 125 },
      ],
    });
    const bold = imported({ wght: 900, wdth: 100 }, first.doc);
    expect(bold.id).not.toBe(first.id);
    expect(bold.data).toMatchObject({ variation: { wght: 900 }, existing: false });
    expect(bold.doc.fonts?.[bold.id]?.variation).toEqual({ wght: 900 });
    expect(bold.doc.fonts?.[first.id]?.variation).toBeUndefined();
    expect(bold.doc.fonts?.[bold.id]?.blob).toBe(bold.doc.fonts?.[first.id]?.blob);
    expect(Object.keys(bold.doc.blobs ?? {})).toHaveLength(1);
    expect(bold.data['sha256']).toBe(first.data['sha256']);
    expect(execute(bold.doc, 'import_font', { base64: base64(true), variation: { wght: 900 } }).data).toMatchObject({
      id: bold.id,
      existing: true,
    });
    expect(execute(bold.doc, 'import_font', { base64: base64(true), variation: { wght: 400 } }).data).toMatchObject({
      id: first.id,
      existing: true,
    });
    expect(execute(bold.doc, 'import_font', { base64: base64(true) }).data).toMatchObject({ id: first.id, existing: true });
  });

  it('list_fonts names the variation of each record, and the summary names the axes', () => {
    const result = execute(emptyDoc(), 'import_font', { base64: base64(), variation: { wght: 650 } });
    expect(result.summary).toContain('axes wght 100..400..900 wdth 75..100..125');
    expect(result.summary).toContain('instance {"wght":650}');
    const listed = execute(result.document, 'list_fonts', {}).data as { fonts: Array<{ variation?: Record<string, number> }> };
    expect(listed.fonts[0]?.variation).toEqual({ wght: 650 });
  });

  it('refuses an unknown axis, a value outside the range and a font that has no axes, naming the parameter', () => {
    const doc = emptyDoc();
    const unknown = expectRefusal(doc, 'import_font', { base64: base64(), variation: { slnt: 1 } }, 'WRP_FONT_VARIATION', 'variation');
    expect(unknown.summary).toContain("no axis 'slnt'");
    expectRefusal(doc, 'import_font', { base64: base64(), variation: { wght: 50 } }, 'WRP_FONT_VARIATION', 'variation');
    const ttf = uint8ArrayToBase64(firaBytes());
    expectRefusal(doc, 'import_font', { base64: ttf, variation: { wght: 500 } }, 'WRP_FONT_VARIATION', 'variation');
    expect(execute(doc, 'import_font', { base64: ttf }).rejected).toBeUndefined();
  });
});

describe('text in an instance', () => {
  it('add_text variation picks the instance record of a font id or family name; text_outline, advance and kerning-free layout follow it', () => {
    const { doc, id } = imported();
    const regular = execute(doc, 'add_text', { content: 'A', position: [0, 0, 0], height: 7, font: id });
    const bold = execute(regular.document, 'add_text', {
      content: 'A',
      position: [0, 0, 0],
      height: 7,
      font: id,
      variation: { wght: 900 },
    });
    expect(bold.rejected, bold.summary).toBeUndefined();
    const boldId = bold.affected[0] as string;
    const boldFont = (bold.data as { font: string }).font;
    expect(boldFont).not.toBe(id);
    expect(bold.document.entities[boldId]).toMatchObject({ font: boldFont });
    const byName = execute(bold.document, 'add_text', {
      content: 'A',
      position: [0, 0, 0],
      height: 7,
      font: 'Unknown',
      variation: { wght: 900 },
    });
    expect((byName.data as { font: string }).font).toBe(boldFont);
    const regularArea = outlineData(bold.document, regular.affected[0] as string).area;
    const boldArea = outlineData(bold.document, boldId).area;
    // 500 x 700 and 800 x 700 font units at 7 / 700 mm per unit
    expect(regularArea).toBeCloseTo(500 * 700 * 0.0001, 9);
    expect(boldArea).toBeCloseTo(800 * 700 * 0.0001, 9);
    expect(outlineData(bold.document, boldId).advanceWidth).toBeCloseTo(7, 9);
    const again = execute(bold.document, 'add_text', { content: 'A', position: [0, 0, 0], height: 7, font: id, variation: { wght: 900 } });
    expect((again.data as { font: string }).font).toBe(boldFont);
    expect(Object.keys(again.document.fonts ?? {})).toHaveLength(2);
  });

  it('HVAR advances widen the text: BB at wdth 125 advances each B by 640 instead of 600', () => {
    const { doc, id } = imported();
    const plain = execute(doc, 'add_text', { content: 'BB', position: [0, 0, 0], height: 7, font: id });
    const wide = execute(plain.document, 'add_text', { content: 'BB', position: [0, 0, 0], height: 7, font: id, variation: { wdth: 125 } });
    const advance = (result: typeof plain): number => outlineData(result.document, result.affected[0] as string).advanceWidth;
    expect(advance(wide) - advance(plain)).toBeCloseTo(2 * 40 * 0.01, 9);
  });

  it('refuses a variation the font cannot take with the font parameter, and keeps the document unchanged', () => {
    const { doc, id } = imported();
    expectRefusal(
      doc,
      'add_text',
      { content: 'A', position: [0, 0, 0], height: 7, font: id, variation: { wght: 9999 } },
      'WRP_FONT_VARIATION',
      'font',
    );
  });

  it('survives a save and a load, and replay_history rebuilds the same document', () => {
    const { doc, id } = imported({ wght: 900 });
    const label = execute(doc, 'add_text', { content: 'A', position: [0, 0, 0], height: 7, font: id, variation: { wght: 100 } });
    const loaded = deserializeDocument(serializeDocument(label.document));
    expect(loaded.fonts).toEqual(label.document.fonts);
    expect(outlineData(loaded, label.affected[0] as string).area).toBeCloseTo(400 * 700 * 0.0001, 9);
    const replayed = execute(label.document, 'replay_history', {});
    expect(replayed.rejected, replayed.summary).toBeUndefined();
    expect(JSON.stringify(replayed.document.fonts)).toBe(JSON.stringify(label.document.fonts));
    expect(JSON.stringify(replayed.document.entities)).toBe(JSON.stringify(label.document.entities));
  });

  it('add_decal with a font and a variation paints the instance', () => {
    const { doc, id } = imported();
    const box = execute(doc, 'add_box', { size: [60, 40, 10] });
    const params = { id: box.affected[0], text: 'A', at: [0, 0, 5], normal: [0, 0, 1], height: 10, font: id };
    const regular = execute(box.document, 'add_decal', params);
    const bold = execute(box.document, 'add_decal', { ...params, variation: { wght: 900 } });
    expect(regular.rejected, regular.summary).toBeUndefined();
    expect(bold.rejected, bold.summary).toBeUndefined();
    expect(Object.keys(bold.document.fonts ?? {})).toHaveLength(2);
    expectRefusal(box.document, 'add_decal', { ...params, variation: { wght: 1 } }, 'WRP_FONT_VARIATION', 'font');
  });
});

describe('emboss and wrap of a CFF2 instance (fake exact kernel)', () => {
  useFakeKernel();

  it('emboss_on_face of text in two instances: the region area follows the glyph area (800 x 700 against 500 x 700)', () => {
    const base = cylinder();
    const { doc, id } = imported(undefined, base.doc);
    const label = (variation?: Record<string, number>): { doc: CadDocument; id: string } => {
      const result = execute(doc, 'add_text', {
        content: 'A',
        position: [0, 0, 0],
        height: 10,
        anchor: 'center',
        font: id,
        ...(variation === undefined ? {} : { variation }),
      });
      return { doc: result.document, id: result.affected[0] as string };
    };
    const regular = label();
    const bold = execute(regular.doc, 'add_text', {
      content: 'A',
      position: [0, 0, 0],
      height: 10,
      anchor: 'center',
      font: id,
      variation: { wght: 900 },
    });
    const emboss = (source: CadDocument, textId: string): { regionArea: number; unverified: boolean } =>
      execute(source, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [textId], mode: 'emboss', depth: 1 }).data as {
        regionArea: number;
        unverified: boolean;
      };
    const a = emboss(bold.document, regular.id);
    const b = emboss(bold.document, bold.affected[0] as string);
    expect(a.regionArea).toBeCloseTo(500 * 700 * (10 / 700) ** 2, 6);
    expect(b.regionArea / a.regionArea).toBeCloseTo(1.6, 9);
    expect(a.unverified).toBe(true);
  });

  it('wrap_to_face wraps the text of an instance; extrude_profile extrudes it', () => {
    const base = cylinder();
    const { doc, id } = imported(undefined, base.doc);
    const bold = execute(doc, 'add_text', {
      content: 'A',
      position: [0, 0, 0],
      height: 10,
      anchor: 'center',
      font: id,
      variation: { wght: 900 },
    });
    const textId = bold.affected[0] as string;
    const wrapped = execute(bold.document, 'wrap_to_face', { id: base.id, face: FACE, entityIds: [textId] });
    expect(wrapped.rejected, wrapped.summary).toBeUndefined();
    const extruded = execute(bold.document, 'extrude_profile', { id: textId, depth: 2 });
    expect(extruded.rejected, extruded.summary).toBeUndefined();
  });
});
