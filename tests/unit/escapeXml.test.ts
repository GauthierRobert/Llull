import { describe, expect, it } from 'vitest';
import { escapeXml } from '@lib/escapeXml';

describe('escapeXml', () => {
  it('escapes the four XML-significant characters', () => {
    expect(escapeXml('a < b & "c" > d')).toBe('a &lt; b &amp; &quot;c&quot; &gt; d');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeXml('Level 1')).toBe('Level 1');
  });
});
