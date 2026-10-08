import { describe, expect, it } from 'vitest';
import { escapeXml } from '@lib/escapeXml';

describe('escapeXml', () => {
  it('escapes the four XML-significant characters', () => {
    expect(escapeXml('a < b & "c" > d')).toBe('a &lt; b &amp; &quot;c&quot; &gt; d');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeXml('Level 1')).toBe('Level 1');
  });

  it('strips XML-1.0-illegal control characters but keeps tab, newline and carriage return', () => {
    const illegal = String.fromCharCode(0, 1, 8, 0x0b, 0x0c, 0x0e, 0x1f);
    expect(escapeXml(`A${illegal}B`)).toBe('AB');
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('strips U+FFFE, U+FFFF and lone surrogates', () => {
    const noncharacters = String.fromCharCode(0xfffe, 0xffff);
    expect(escapeXml(`x${noncharacters}y`)).toBe('xy');
    expect(escapeXml(`a${String.fromCharCode(0xd800)}b`)).toBe('ab');
    expect(escapeXml(`a${String.fromCharCode(0xdc00)}b`)).toBe('ab');
    expect(escapeXml(`a${String.fromCharCode(0xd800)}`)).toBe('a');
  });

  it('keeps accented and astral characters (valid surrogate pairs)', () => {
    expect(escapeXml('Café 😀 °')).toBe('Café 😀 °');
  });

  it('produces text a strict XML parser would accept', () => {
    const cleaned = escapeXml(`Room${String.fromCharCode(3)} <1>`);
    expect(cleaned).toBe('Room &lt;1&gt;');
  });
});
