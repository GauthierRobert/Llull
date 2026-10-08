/**
 * XML-safe text for SVG sheets: entity-escapes and drops characters illegal in XML 1.0.
 * @layer domain-aec
 * @pure
 */

import { escapeXml as escapeEntities } from '@lib/escapeXml';

/** True for code points XML 1.0 forbids (C0 controls other than tab, LF, CR; U+FFFE; U+FFFF). */
export function isIllegalXmlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    code === 0xfffe ||
    code === 0xffff
  );
}

export function escapeXml(text: string): string {
  return escapeEntities(
    [...text].filter((character) => !isIllegalXmlCharacter(character)).join(''),
  );
}
