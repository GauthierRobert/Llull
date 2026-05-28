/**
 * Unit tests for the pure quality-tier derivation logic in useRenderQuality.ts.
 *
 * Covers deriveQualityTier (auto thresholds) and resolveQualityTier (override
 * path + auto path) — pure functions with no side effects.
 *
 * @layer tests/unit
 */

import { describe, it, expect } from 'vitest';
import { deriveQualityTier, resolveQualityTier } from '@ui/viewport/3d/useRenderQuality';

// ---------------------------------------------------------------------------
// deriveQualityTier — auto thresholds
// ---------------------------------------------------------------------------

describe('deriveQualityTier — auto thresholds', () => {
  it('0 entities → high', () => {
    expect(deriveQualityTier(0)).toBe('high');
  });

  it('1 entity → high', () => {
    expect(deriveQualityTier(1)).toBe('high');
  });

  it('50 entities → high (boundary)', () => {
    expect(deriveQualityTier(50)).toBe('high');
  });

  it('51 entities → medium (boundary +1)', () => {
    expect(deriveQualityTier(51)).toBe('medium');
  });

  it('100 entities → medium', () => {
    expect(deriveQualityTier(100)).toBe('medium');
  });

  it('200 entities → medium (boundary)', () => {
    expect(deriveQualityTier(200)).toBe('medium');
  });

  it('201 entities → low (boundary +1)', () => {
    expect(deriveQualityTier(201)).toBe('low');
  });

  it('500 entities → low', () => {
    expect(deriveQualityTier(500)).toBe('low');
  });

  it('1000 entities → low', () => {
    expect(deriveQualityTier(1000)).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// resolveQualityTier — override takes precedence over entity count
// ---------------------------------------------------------------------------

describe('resolveQualityTier — explicit override ignores entity count', () => {
  it('override=high with 500 entities → high', () => {
    expect(resolveQualityTier('high', 500)).toBe('high');
  });

  it('override=medium with 0 entities → medium', () => {
    expect(resolveQualityTier('medium', 0)).toBe('medium');
  });

  it('override=low with 1 entity → low', () => {
    expect(resolveQualityTier('low', 1)).toBe('low');
  });
});

describe('resolveQualityTier — auto delegates to deriveQualityTier', () => {
  it('auto + 10 entities → high', () => {
    expect(resolveQualityTier('auto', 10)).toBe('high');
  });

  it('auto + 50 entities → high', () => {
    expect(resolveQualityTier('auto', 50)).toBe('high');
  });

  it('auto + 51 entities → medium', () => {
    expect(resolveQualityTier('auto', 51)).toBe('medium');
  });

  it('auto + 200 entities → medium', () => {
    expect(resolveQualityTier('auto', 200)).toBe('medium');
  });

  it('auto + 201 entities → low', () => {
    expect(resolveQualityTier('auto', 201)).toBe('low');
  });
});
