/**
 * Single-script text layout over a parsed font (03 WRP, D-WRP-6: one character -> one glyph, pair kerning, no shaping): glyphs are placed along a
 * baseline by their advance widths, scaled so the cap height equals the requested height, and aligned about the text origin.
 */

import type { Vec2 } from '../../model/vectors';
import { mapLoop, type OutlineLoop } from './outline';
import type { ParsedFont } from './font';

export interface LayoutOptions {
  /** Cap height in document units. */
  readonly height: number;
  readonly anchor: 'left' | 'center' | 'right';
  readonly verticalAnchor: 'baseline' | 'cap_middle' | 'cap_top';
  /** Document units added after each glyph. */
  readonly letterSpacing: number;
  readonly kerning: boolean;
  /** Line pitch as a multiple of (ascender - descender + line gap). */
  readonly lineSpacing: number;
}

interface PlacedGlyph {
  readonly character: string;
  readonly glyph: number;
  readonly loops: readonly OutlineLoop[];
  /** Open strokes of a single-line font in document units (empty for outline fonts). */
  readonly strokes: readonly (readonly Vec2[])[];
  /** Advance width in document units (before kerning and letter spacing). */
  readonly advance: number;
}

export interface TextLayout {
  readonly glyphs: readonly PlacedGlyph[];
  readonly loops: readonly OutlineLoop[];
  /** Every open stroke of a single-line font, placed (document units). */
  readonly strokes: readonly (readonly Vec2[])[];
  /** Document units per font unit. */
  readonly scale: number;
  /** Widest line: sum of advances, kerning and letter spacing between glyphs. */
  readonly advanceWidth: number;
  readonly lines: number;
  /** Distinct characters the font has no glyph for (drawn as nothing). */
  readonly missing: readonly string[];
}

export const MAX_TEXT_CHARACTERS = 2000;

/** @failure more than MAX_TEXT_CHARACTERS characters are cut off (the caller checks the length first) */
export function layoutText(font: ParsedFont, content: string, options: LayoutOptions): TextLayout {
  const scale = options.height / font.capHeight;
  const characters = [...content].slice(0, MAX_TEXT_CHARACTERS);
  const lines: string[][] = [[]];
  for (const character of characters) {
    if (character === '\n') lines.push([]);
    else (lines[lines.length - 1] as string[]).push(character);
  }
  const pitch = options.lineSpacing * (font.ascender - font.descender + font.lineGap) * scale;
  const top = options.verticalAnchor === 'cap_top' ? options.height : options.verticalAnchor === 'cap_middle' ? options.height / 2 : 0;
  const glyphs: PlacedGlyph[] = [];
  const missing = new Set<string>();
  let widest = 0;
  for (const [row, line] of lines.entries()) {
    const baseline = -top - row * pitch;
    const pens: { character: string; glyph: number; pen: number }[] = [];
    let pen = 0;
    let previous = 0;
    for (const [column, character] of line.entries()) {
      const codePoint = character.codePointAt(0) as number;
      const glyph = font.glyphIndex(codePoint);
      if (glyph === 0 && character.trim().length > 0) missing.add(character);
      if (column > 0 && options.kerning) pen += font.kerning(previous, glyph) * scale;
      pens.push({ character, glyph, pen });
      pen += font.advance(glyph) * scale + (column < line.length - 1 ? options.letterSpacing : 0);
      previous = glyph;
    }
    widest = Math.max(widest, pen);
    const origin = options.anchor === 'center' ? -pen / 2 : options.anchor === 'right' ? -pen : 0;
    for (const { character, glyph, pen: at } of pens)
      glyphs.push({
        character,
        glyph,
        advance: font.advance(glyph) * scale,
        loops:
          glyph === 0 ? [] : font.outline(glyph).map((loop) => mapLoop(loop, ([x, y]) => [scale * x + origin + at, scale * y + baseline])),
        strokes:
          glyph === 0
            ? []
            : font.strokes(glyph).map((stroke) => stroke.map(([x, y]): Vec2 => [scale * x + origin + at, scale * y + baseline])),
      });
  }
  return {
    glyphs,
    loops: glyphs.flatMap((glyph) => glyph.loops),
    strokes: glyphs.flatMap((glyph) => glyph.strokes),
    scale,
    advanceWidth: widest,
    lines: lines.length,
    missing: [...missing],
  };
}
