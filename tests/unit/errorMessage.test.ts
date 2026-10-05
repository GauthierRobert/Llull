import { describe, expect, it } from 'vitest';
import { errorMessage } from '@lib/errorMessage';

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new TypeError('boom'))).toBe('boom');
  });

  it('stringifies any other thrown value', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
