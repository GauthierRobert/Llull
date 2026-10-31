/** font_metrics — read-only metrics of a font at an instance: the vertical metrics and the advance width and height of every character of a text (03 WRP, spec §14.18). */

import type { CadDocument } from '../../model/types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { isFontFailure, loadFont, resolveFont } from './fontStore';
import { variationField } from './variationField';

const MAX_TEXT = 256;

/**
 * @affects none (read-only); data = unitsPerEm, ascender, descender, lineGap, capHeight (font units, at the instance), the instance, glyphs [{ character, codePoint, glyph, advanceWidth, advanceHeight, verticalOrigin { y, source } }] and their sums
 * @invariant advance heights come from vmtx moved by VVAR (or the phantom points of a gvar font), widths from hmtx moved by HVAR (or the phantom points); font units, rounded to a unit like the layout does
 * @failure no such font, a variation / instance the font does not have -> WRP_FONT_UNAVAILABLE / WRP_FONT_VARIATION; text over 256 characters -> WRP_PARAM_INVALID
 */
export const fontMetrics = defineCommand({
  name: 'font_metrics',
  annotations: { readOnly: true },
  description:
    'Metrics of a font at one instance, in font units (divide by data.unitsPerEm for em): data.ascender / descender / lineGap / capHeight (moved by MVAR for a variable font) and, for each character of `text`, ' +
    'its glyph index, advanceWidth (hmtx + HVAR) and advanceHeight (vmtx + VVAR, or the phantom points of a TrueType gvar font; ascender - descender when the font has no vertical metrics), verticalOrigin (where the glyph hangs in vertical text: VORG of a CFF font, else the ascender), plus their sums. ' +
    '`font` = a font id of the document, a family name, or a bundled font; `variation` = {axisTag: value} or `instance` = a named instance (Bold), not both; omitted = the default instance. ' +
    'Read-only. Next: add_text with the same font and instance, import_font to embed it.',
  params: z.object({
    font: z.string().min(1).describe('A font id of the document (list_fonts), a family name ("Fira Sans") or a bundled font.'),
    text: z.string().max(MAX_TEXT).optional().describe('Characters to measure (at most 256). Omitted: only the vertical metrics.'),
    variation: variationField(),
    instance: z
      .string()
      .min(1)
      .optional()
      .describe('A named instance of the variable font (subfamily or PostScript name, any case), instead of `variation`.'),
  }),
  run: (doc: CadDocument, params, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      wrapRejection(doc, 'font_metrics', code, message, [], [path]);
    const resolved = resolveFont(doc, ctx, params.font, params.variation, params.instance);
    if (isFontFailure(resolved))
      return fail(resolved.code, resolved.message, resolved.code === 'WRP_FONT_VARIATION' ? 'variation' : 'font');
    const loaded = loadFont(resolved.document, resolved.record.id);
    if (isFontFailure(loaded)) return fail(loaded.code, loaded.message, 'font');
    const font = loaded.font;
    const glyphs = [...(params.text ?? '')].map((character) => {
      const codePoint = character.codePointAt(0) as number;
      const glyph = font.glyphIndex(codePoint);
      return {
        character,
        codePoint,
        glyph,
        advanceWidth: font.advance(glyph),
        advanceHeight: font.verticalAdvance(glyph),
        verticalOrigin: font.verticalOrigin(glyph),
      };
    });
    const width = glyphs.reduce((sum, entry) => sum + entry.advanceWidth, 0);
    const height = glyphs.reduce((sum, entry) => sum + entry.advanceHeight, 0);
    return report(
      doc,
      `font_metrics: '${resolved.record.family} ${resolved.record.style}'${Object.keys(font.instance).length === 0 ? '' : ` at ${JSON.stringify(font.instance)}`}: ascender ${font.ascender}, descender ${font.descender}, line gap ${font.lineGap}, cap height ${font.capHeight} (${font.unitsPerEm} per em)${glyphs.length === 0 ? '' : `; ${glyphs.length} character(s), width ${width}, height ${height}`}.`,
      {
        unitsPerEm: font.unitsPerEm,
        ascender: font.ascender,
        descender: font.descender,
        lineGap: font.lineGap,
        capHeight: font.capHeight,
        instance: font.instance,
        glyphs,
        width,
        height,
      },
    );
  },
});
