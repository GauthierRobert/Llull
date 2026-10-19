import { describe, expect, it } from 'vitest';
import { findingTitle } from '@ui/panels/review/checklist';

describe('finding titles read in plain words on the model', () => {
  it('names known codes and falls back to the code', () => {
    expect(findingTitle('FPR_PAIR_HARD')).toBe('Parts overlap');
    expect(findingTitle('FPR_LOOP_OPEN')).toBe('Loop does not close');
    expect(findingTitle('FPR_TIMESTEP_SENSITIVE')).toBe('Result depends on the timestep');
    expect(findingTitle('FPR_SOMETHING_NEW')).toBe('FPR_SOMETHING_NEW');
  });
});
