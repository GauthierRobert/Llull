import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStableByKey } from '@ui/viewport/useStableByKey';

describe('useStableByKey', () => {
  it('keeps the first value while the key is unchanged and adopts a new one when it changes', () => {
    const first = { n: 1 };
    const { result, rerender } = renderHook(({ value, key }) => useStableByKey(value, key), {
      initialProps: { value: first, key: 'a' },
    });
    rerender({ value: { n: 1 }, key: 'a' });
    expect(result.current).toBe(first);
    const next = { n: 2 };
    rerender({ value: next, key: 'b' });
    expect(result.current).toBe(next);
  });
});
