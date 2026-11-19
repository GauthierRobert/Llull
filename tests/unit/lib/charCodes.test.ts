import { describe, expect, it } from 'vitest';
import { stringFromCharCodes } from '@lib/charCodes';

describe('stringFromCharCodes', () => {
  it('equals String.fromCharCode of the spread, incl. ToUint16 wrap-around, lone surrogates and chunk boundaries', () => {
    const lists: ArrayLike<number>[] = [
      [],
      [72, 105],
      [0xd83d, 0xde00],
      [0xd800],
      [0xdc00, 65],
      [65536 + 65, -1, 1.9, NaN, 0x1_0000_0041],
      new Uint8Array(Array.from({ length: 300 }, (_, i) => i)),
      Array.from({ length: 4096 * 2 + 17 }, (_, i) => (i * 7919) % 65536),
      Array.from({ length: 4096 }, (_, i) => 0xd800 + (i % 2048)),
    ];
    for (const codes of lists) expect(stringFromCharCodes(codes)).toBe(String.fromCharCode(...Array.from(codes)));
  });

  it('decodes 1e6 bytes where the spread throws RangeError', () => {
    const bytes = new Uint8Array(1_000_000).fill(65);
    expect(() => String.fromCharCode(...bytes)).toThrow(RangeError);
    expect(stringFromCharCodes(bytes)).toBe('A'.repeat(1_000_000));
  });
});
