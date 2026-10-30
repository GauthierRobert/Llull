/**
 * What `seac` (the accented-character form of Type 2 `endchar`) needs to find its two components: the Standard Encoding (character code to string id) and the
 * charset (string id to glyph) of a name-keyed CFF font (03 WRP M4, TECHNICAL_SPEC §5.5).
 * @invariant the charset of a font is read once, at most `glyphCount` glyphs; a code without a standard name has string id 0
 * @failure a charset format other than 0 / 1 / 2, a predefined Expert charset -> WRP_FONT_PARSE
 */

import { type ByteView, parseError } from './reader';

/** Codes of the Standard Encoding that have a name outside ASCII, in the order of string ids 96..149 (CFF specification, Appendix B). */
const UPPER_CODES = [
  161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 177, 178, 179, 180, 182, 183, 184, 185, 186, 187, 188, 189,
  191, 193, 194, 195, 196, 197, 198, 199, 200, 202, 203, 205, 206, 207, 208, 225, 227, 232, 233, 234, 235, 241, 245, 248, 249, 250, 251,
];

/** String id of the Standard Encoding name of each character code 0..255 (0 = no name). */
export const STANDARD_ENCODING_SID: readonly number[] = Array.from({ length: 256 }, (_, code) => {
  if (code >= 32 && code <= 126) return code - 31;
  const k = UPPER_CODES.indexOf(code);
  return k < 0 ? 0 : 96 + k;
});

/** The glyph of each string id. @failure unknown charset format -> WRP_FONT_PARSE */
export function readCharset(table: ByteView, offset: number, glyphCount: number): ReadonlyMap<number, number> {
  const glyphOf = new Map<number, number>();
  if (offset === 0) {
    for (let glyph = 0; glyph < Math.min(glyphCount, 229); glyph++) glyphOf.set(glyph, glyph);
    return glyphOf;
  }
  if (offset === 1 || offset === 2) throw parseError('CFF: seac in a font with a predefined Expert charset is not supported');
  const format = table.u8(offset);
  let glyph = 1;
  let at = offset + 1;
  if (format === 0) {
    for (; glyph < glyphCount; glyph++, at += 2) glyphOf.set(table.u16(at), glyph);
  } else if (format === 1 || format === 2) {
    while (glyph < glyphCount) {
      const first = table.u16(at);
      const left = format === 1 ? table.u8(at + 2) : table.u16(at + 2);
      at += format === 1 ? 3 : 4;
      for (let k = 0; k <= left && glyph < glyphCount; k++, glyph++) glyphOf.set(first + k, glyph);
    }
  } else throw parseError(`CFF: charset format ${format} is not 0, 1 or 2`);
  return glyphOf;
}
