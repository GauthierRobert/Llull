/**
 * 03 WRP M4: font-wide bounds of the CFF / CFF2 reader against BUILT adversarial fonts (hostileFonts.ts): shared Subrs behind many font dicts, aliased variation
 * data subtables, a fan-out subroutine in every glyph, a long FDSelect. Each is refused with its code quickly, or (at the cap) read within a time budget.
 */

import { describe, expect, it } from 'vitest';
import { parseFont, validateGlyphs } from '@lib/font/font';
import { aliasedStoreFont, manyRangesFont, operatorFanFont, sharedSubrsFont } from './hostileFonts';

function outcome(bytes: Uint8Array): { ok: boolean; code?: string; message: string; ms: number } {
  const started = performance.now();
  const parsed = parseFont(bytes);
  const result = parsed.ok ? validateGlyphs(parsed.font) : parsed;
  return {
    ...(result.ok ? { ok: true, message: '' } : { ok: false, code: result.code, message: result.message }),
    ms: performance.now() - started,
  };
}

describe('font-wide bounds (built adversarial fonts)', () => {
  it('many font dicts sharing one 262 144-entry Subrs INDEX: more than 256 dicts are refused, 256 are read once per offset', () => {
    const refused = outcome(sharedSubrsFont(4000, 262_144, 1));
    expect(refused).toMatchObject({ ok: false, code: 'WRP_FONT_PARSE' });
    expect(refused.message).toContain('4000 font dicts exceed 256');
    const capped = outcome(sharedSubrsFont(256, 262_144, 256));
    expect(capped.ok, capped.message).toBe(true);
    expect(capped.ms).toBeLessThan(2000);
  });

  it('4096 data subtables aliasing one subtable of 4096 region indexes are refused by the region index cap', () => {
    const refused = outcome(aliasedStoreFont(4096, 4096));
    expect(refused).toMatchObject({ ok: false, code: 'WRP_FONT_PARSE' });
    expect(refused.message).toContain('region indexes over all subtables');
    expect(refused.ms).toBeLessThan(2000);
    expect(outcome(aliasedStoreFont(8, 8)).ok).toBe(true);
  });

  it('a subtable that lists more regions than the store has is refused', () => {
    const refused = outcome(aliasedStoreFont(8, 1, 9));
    expect(refused).toMatchObject({ ok: false, code: 'WRP_FONT_PARSE' });
    expect(refused.message).toContain('lists 9 regions of 8');
  });

  it('glyphs that each run about 70 000 operators are stopped by the font-wide operator budget', () => {
    const refused = outcome(operatorFanFont(2000));
    expect(refused).toMatchObject({ ok: false, code: 'WRP_FONT_PARSE' });
    expect(refused.message).toContain('operators over the glyphs of one font');
    expect(refused.ms).toBeLessThan(15_000);
    expect(outcome(operatorFanFont(50)).ok).toBe(true);
  });

  it('an FDSelect with one range per glyph is read once (linear); unordered ranges are refused', () => {
    const many = outcome(manyRangesFont(20_000));
    expect(many.ok, many.message).toBe(true);
    expect(many.ms).toBeLessThan(3000);
    const unordered = outcome(manyRangesFont(100, true));
    expect(unordered).toMatchObject({ ok: false, code: 'WRP_FONT_PARSE' });
    expect(unordered.message).toContain('FDSelect');
  });
});
