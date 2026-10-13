import { describe, expect, it } from 'vitest';
import { nonEmptyString } from '@lib/nonEmptyString';

describe('nonEmptyString', () => {
  it('keeps a non-empty string', () => {
    expect(nonEmptyString(' a ')).toBe(' a ');
  });
  it('rejects empty strings and non-strings', () => {
    expect(nonEmptyString('')).toBeUndefined();
    expect(nonEmptyString(3)).toBeUndefined();
    expect(nonEmptyString(undefined)).toBeUndefined();
  });
});
