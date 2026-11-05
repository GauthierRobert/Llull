/** describeNative honours the missing-binary skip in every variant (not only the call and .each). */
import { describe, expect, it, vi } from 'vitest';
import { skippingDescribe } from './kernelTestSupport';

/** A stand-in `describe` whose every entry point records which chain declared the suite. */
function fakeDescribe(): { base: typeof describe; calls: string[] } {
  const calls: string[] = [];
  const named = (label: string): ReturnType<typeof vi.fn> =>
    Object.assign(
      vi.fn(() => void calls.push(label)),
      { each: vi.fn(() => () => void calls.push(`${label}.each`)) },
    );
  const base = Object.assign(named('describe'), {
    skip: named('skip'),
    only: named('only'),
    concurrent: named('concurrent'),
    sequential: named('sequential'),
    shuffle: named('shuffle'),
    todo: named('todo'),
    skipIf: (condition: boolean) => named(condition ? 'skipIf(true)' : 'skipIf(false)'),
  });
  return { base: base as unknown as typeof describe, calls };
}

const declare = (wrapped: typeof describe, variant: string): void => {
  const target = variant === 'call' ? wrapped : (wrapped as unknown as Record<string, typeof describe>)[variant];
  (target as unknown as (name: string, body: () => void) => void)('suite', () => undefined);
};

describe('describeNative variants', () => {
  it('skips every variant when the binary is missing', () => {
    for (const variant of ['call', 'only', 'concurrent', 'sequential', 'shuffle', 'todo']) {
      const { base, calls } = fakeDescribe();
      declare(
        skippingDescribe(base, () => true),
        variant,
      );
      expect(calls, variant).toHaveLength(1);
      expect(calls[0], variant).toMatch(/^(skip|skipIf\(true\))$/);
    }
  });

  it('combines skipIf and runIf with the missing-binary condition', () => {
    const { base, calls } = fakeDescribe();
    const missing = skippingDescribe(base, () => true);
    missing.skipIf(false)('a', () => undefined);
    missing.runIf(true)('b', () => undefined);
    const present = skippingDescribe(base, () => false);
    present.skipIf(false)('c', () => undefined);
    present.runIf(false)('d', () => undefined);
    expect(calls).toEqual(['skipIf(true)', 'skipIf(true)', 'skipIf(false)', 'skipIf(true)']);
  });

  it('forwards the real variant when the binary is present', () => {
    for (const variant of ['only', 'concurrent', 'sequential', 'shuffle', 'todo']) {
      const { base, calls } = fakeDescribe();
      declare(
        skippingDescribe(base, () => false),
        variant,
      );
      expect(calls, variant).toEqual([variant]);
    }
  });
});
