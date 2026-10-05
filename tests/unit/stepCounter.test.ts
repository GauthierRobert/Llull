import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { withMonotonicStepCounter } from '@core/model/stepCounter';

describe('withMonotonicStepCounter', () => {
  const at = (nextStepNumber: number): CadDocument => ({
    ...createEmptyDocument(),
    nextStepNumber,
  });

  it('raises the restored counter to the current one', () => {
    expect(withMonotonicStepCounter(at(3), at(7)).nextStepNumber).toBe(7);
  });

  it('returns the restored document itself when it already holds the maximum', () => {
    const restored = at(9);
    expect(withMonotonicStepCounter(restored, at(2))).toBe(restored);
  });
});
