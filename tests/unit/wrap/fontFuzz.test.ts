/**
 * 03 WRP M4 fuzz seeds: every byte of the generated CFF2 variable font and of the CFF font with seac / arithmetic operators is replaced by hostile values; the reader must answer
 * with a font or a stable refusal code, never throw, and finish a whole scan within the operator and point budgets.
 */

import { describe, expect, it } from 'vitest';
import { parseFont, validateGlyphs } from '@lib/font/font';
import { seacFont, variableFont } from './variableFonts';

const CODES = new Set([
  'WRP_FONT_PARSE',
  'WRP_FONT_FORMAT_UNSUPPORTED',
  'WRP_FONT_EMBEDDING_RESTRICTED',
  'WRP_FONT_TOO_LARGE',
  'WRP_FONT_VARIATION',
]);
const VALUES = [0x00, 0x01, 0x0e, 0x10, 0x7f, 0x80, 0xff];

function sweep(bytes: Uint8Array, variation: Record<string, number>): { refused: number; read: number } {
  let refused = 0;
  let read = 0;
  for (let at = 0; at < bytes.length; at++)
    for (const value of VALUES) {
      if (bytes[at] === value) continue;
      const copy = new Uint8Array(bytes);
      copy[at] = value;
      const parsed = parseFont(copy, variation);
      const outcome = parsed.ok ? validateGlyphs(parsed.font) : parsed;
      if (outcome.ok) read++;
      else {
        expect(CODES.has(outcome.code), `byte ${at} = ${value}: ${outcome.message}`).toBe(true);
        expect(outcome.message, `byte ${at} = ${value}`).not.toMatch(
          /undefined|cannot read|is not a function|invalid array|call stack|NaN/i,
        );
        refused++;
      }
    }
  return { refused, read };
}

describe('hostile CFF2 and Type 2 bytes', () => {
  it('a CFF2 variable font with every byte replaced is read or refused with a stable code, at the default and at an instance', () => {
    const bytes = variableFont({ avar: true, hvar: [3, 2, 1] });
    for (const variation of [{}, { wght: 650, wdth: 112.5 }]) {
      const { refused, read } = sweep(bytes, variation);
      expect(refused).toBeGreaterThan(100);
      expect(read).toBeGreaterThan(100);
    }
  });

  it('a CFF font with seac, arithmetic and a charset with every byte replaced is read or refused with a stable code', () => {
    const { refused, read } = sweep(seacFont(), {});
    expect(refused).toBeGreaterThan(100);
    expect(read).toBeGreaterThan(100);
  });
});
