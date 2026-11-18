import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '@lib/sha256';

const reference = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

describe('sha256Hex against the platform digest', () => {
  it('agrees on the FIPS vectors, on text with multi-byte characters and across every padding boundary', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('héllo ✓')).toBe(reference('héllo ✓'));
    for (let length = 0; length <= 200; length++) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 131 + length * 17) & 0xff);
      expect(sha256Hex(bytes), `length ${length}`).toBe(reference(bytes));
    }
  });

  it('agrees on a multi-megabyte input', () => {
    const large = 'llull '.repeat(400_000);
    expect(sha256Hex(large)).toBe(reference(large));
  });
});
