import { describe, it, expect } from 'vitest';
import { degradedReasonOf } from '@ui/services/backendKernel';

describe('degradedReasonOf (/health kernelStatus)', () => {
  it('is null when the requested kernel is the active one, or the body says nothing', () => {
    expect(degradedReasonOf({ kernelStatus: { active: 'occt', requested: 'occt' } })).toBeNull();
    expect(degradedReasonOf({ status: 'ok', kernel: 'occt' })).toBeNull();
    expect(degradedReasonOf(null)).toBeNull();
  });
  it('gives the fallback reason when requested differs from active, or a generic one without it', () => {
    expect(degradedReasonOf({ kernelStatus: { active: 'manifold', requested: 'occt', fallbackReason: 'binary not found' } })).toBe(
      'binary not found',
    );
    expect(degradedReasonOf({ kernelStatus: { active: 'manifold', requested: 'occt' } })).toBe('the exact kernel is unavailable');
  });
});
