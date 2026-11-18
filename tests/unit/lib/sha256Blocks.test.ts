import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '@lib/sha256';

const reference = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const patterned = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 2654435761) >>> 24);

describe('sha256Hex block handling', () => {
  it('matches the platform digest around every block and padding boundary, up to 1 MB', () => {
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129, 191, 192, 1_000_000, 1_048_576]) {
      const bytes = patterned(length);
      expect(sha256Hex(bytes), `length ${length}`).toBe(reference(bytes));
    }
  });

  it('matches on random lengths and on a view into a larger buffer (non-zero byteOffset)', () => {
    let state = 12345;
    for (let round = 0; round < 60; round++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const length = state % 700;
      const whole = patterned(length + 37);
      const view = whole.subarray(11, 11 + length);
      expect(sha256Hex(view), `length ${length}`).toBe(reference(Uint8Array.from(view)));
    }
  });

  it('does not modify its input and hashes high bytes (0x80..0xff) as unsigned', () => {
    const bytes = Uint8Array.from({ length: 200 }, (_, i) => 0x80 + (i % 128));
    const copy = Uint8Array.from(bytes);
    expect(sha256Hex(bytes)).toBe(reference(copy));
    expect(bytes).toEqual(copy);
  });
});
