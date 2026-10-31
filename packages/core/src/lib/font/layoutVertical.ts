/**
 * Vertical text layout (03 WRP §14.20, CJK style): the glyphs of a line are stacked top to bottom by their vertical advance (`vmtx` at the instance, ascender - descender without vertical
 * metrics), each hung from its vertical origin (`VORG` of a CFF font, else the horizontal middle of its advance width at x and the ascender at y), glyphs upright. Lines become columns that
 * run leftward, one pitch apart. Kerning is not applied (the pairs are horizontal).
 */

import type { Vec2 } from '../../model/vectors';
import { mapLoop, type OutlineLoop } from './outline';
import type { ParsedFont } from './font';

export interface PlacedGlyph {
  readonly character: string;
  readonly glyph: number;
  readonly loops: readonly OutlineLoop[];
  /** Open strokes of a single-line font in document units (empty for outline fonts). */
  readonly strokes: readonly (readonly Vec2[])[];
  /** Advance width in document units (before kerning and letter spacing). */
  readonly advance: number;
  /** Advance height in document units (vertical text only). */
  readonly advanceHeight?: number;
}

export interface ColumnOptions {
  readonly anchor: 'left' | 'center' | 'right';
  readonly verticalAnchor: 'baseline' | 'cap_middle' | 'cap_top';
  readonly letterSpacing: number;
}

export interface VerticalLayout {
  readonly glyphs: PlacedGlyph[];
  readonly missing: string[];
  /** Widest column: the largest advance width in it. */
  readonly advanceWidth: number;
  /** Tallest column: its vertical advances plus the letter spacing between its glyphs. */
  readonly advanceHeight: number;
}

/**
 * Places every line of `lines` as a column. `scale` is document units per font unit, `pitch` the distance between columns.
 * Column k is centred on x = -k pitch (glyph advance middles on it); `anchor` left puts the column's left edge there instead, right its right edge. The top of the first advance box is at y = 0
 * (baseline and cap_top), or the column is centred on y = 0 (cap_middle).
 */
export function layoutVertical(
  font: ParsedFont,
  lines: readonly (readonly string[])[],
  options: ColumnOptions,
  scale: number,
  pitch: number,
): VerticalLayout {
  const glyphs: PlacedGlyph[] = [];
  const missing = new Set<string>();
  let widest = 0;
  let tallest = 0;
  for (const [column, line] of lines.entries()) {
    const entries = line.map((character) => {
      const glyph = font.glyphIndex(character.codePointAt(0) as number);
      if (glyph === 0 && character.trim().length > 0) missing.add(character);
      return { character, glyph, advance: font.advance(glyph) * scale, height: font.verticalAdvance(glyph) * scale };
    });
    const length = entries.reduce((sum, entry, k) => sum + entry.height + (k < entries.length - 1 ? options.letterSpacing : 0), 0);
    const width = entries.reduce((most, entry) => Math.max(most, entry.advance), 0);
    widest = Math.max(widest, width);
    tallest = Math.max(tallest, length);
    const centre = -column * pitch + (options.anchor === 'left' ? width / 2 : options.anchor === 'right' ? -width / 2 : 0);
    let top = options.verticalAnchor === 'cap_middle' ? length / 2 : 0;
    for (const entry of entries) {
      const dx = centre - entry.advance / 2;
      const dy = top - font.verticalOrigin(entry.glyph).y * scale;
      glyphs.push({
        character: entry.character,
        glyph: entry.glyph,
        advance: entry.advance,
        advanceHeight: entry.height,
        loops:
          entry.glyph === 0 ? [] : font.outline(entry.glyph).map((loop) => mapLoop(loop, ([x, y]) => [scale * x + dx, scale * y + dy])),
        strokes:
          entry.glyph === 0
            ? []
            : font.strokes(entry.glyph).map((stroke) => stroke.map(([x, y]): Vec2 => [scale * x + dx, scale * y + dy])),
      });
      top -= entry.height + options.letterSpacing;
    }
  }
  return { glyphs, missing: [...missing], advanceWidth: widest, advanceHeight: tallest };
}
