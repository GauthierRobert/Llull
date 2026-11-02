import { describe, expect, it } from 'vitest';
import { isIsoUtc } from '@aec/shared/isoUtc';

describe('isIsoUtc', () => {
  it('accepts a real instant, with or without a fraction', () => {
    expect(isIsoUtc('2026-11-02T09:30:00Z')).toBe(true);
    expect(isIsoUtc('2026-11-02T09:30:00.250Z')).toBe(true);
    expect(isIsoUtc('2028-02-29T00:00:00Z')).toBe(true);
  });

  it('refuses a wrong shape or an impossible date or time', () => {
    const bad = [
      '2026-11-02',
      '2026-11-02T09:30:00',
      '2026-11-02T09:30:00+01:00',
      '2026-02-31T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-11-02T25:00:00Z',
      '2027-02-29T00:00:00Z',
      '',
    ];
    for (const text of bad) expect(isIsoUtc(text), text).toBe(false);
  });
});
