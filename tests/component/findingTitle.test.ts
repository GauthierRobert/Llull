import { describe, expect, it } from 'vitest';
import { findingTitle } from '@ui/panels/review/checklist';

describe('finding titles read in plain words on the model', () => {
  it('names known codes, falls back to the checklist row, then to the code', () => {
    expect(findingTitle('FPR_PAIR_HARD')).toBe('Parts overlap');
    expect(findingTitle('FPR_LOOP_OPEN')).toBe('Loops closed');
    expect(findingTitle('FPR_SOMETHING_NEW')).toBe('FPR_SOMETHING_NEW');
  });
});
