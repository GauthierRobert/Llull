import { describe, expect, it } from 'vitest';
import { release, withOwned, type NativeObject } from '@core/geometry/nativeObject';

function native(log: string[], name: string, throws = false): NativeObject {
  return {
    delete: () => {
      log.push(name);
      if (throws) throw new Error('already deleted');
    },
  };
}

describe('nativeObject', () => {
  it('release frees once and tolerates null or an already-released object', () => {
    const log: string[] = [];
    release(native(log, 'a'));
    release(null);
    expect(() => release(native(log, 'b', true))).not.toThrow();
    expect(log).toEqual(['a', 'b']);
  });

  it('withOwned returns the body result and frees every registered object', () => {
    const log: string[] = [];
    const result = withOwned((own) => {
      own(native(log, 'a'));
      own(null);
      own(native(log, 'b'));
      return 42;
    });
    expect(result).toBe(42);
    expect(log).toEqual(['a', 'b']);
  });

  it('withOwned maps a throw to null, reports it and still frees', () => {
    const log: string[] = [];
    const errors: unknown[] = [];
    const result = withOwned(
      (own) => {
        own(native(log, 'a'));
        throw new Error('boom');
      },
      (error) => errors.push(error),
    );
    expect(result).toBeNull();
    expect(log).toEqual(['a']);
    expect(errors).toHaveLength(1);
    expect(
      withOwned(() => {
        throw new Error('silent');
      }),
    ).toBeNull();
  });
});
