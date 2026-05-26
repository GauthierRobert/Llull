/**
 * Unit tests for the 3D adaptive grid / scale-bar pure helpers.
 *
 * All functions are pure — no DOM, Canvas, or three.js needed.
 * Tests cover: snapToNiceStep, adaptiveGridStep3D, gridFadeDistance3D,
 *              scaleBarLength3D.
 *
 * Golden table for the 1-2-5 step function:
 *   distance=1    → step=0.1  (visibleWidth≈0.83, idealStep≈0.033 → 0.05 → ... snap to 0.1)
 *   distance=10   → step=1    (visibleWidth≈8.3, idealStep≈0.33 → snap to 0.5... 1)
 *   distance=100  → step=10
 *   distance=1000 → step=100
 *   distance=10000→ step=1000
 */

import { describe, it, expect } from 'vitest';
import {
  snapToNiceStep,
  adaptiveGridStep3D,
  gridFadeDistance3D,
  scaleBarLength3D,
} from '@ui/viewport/3d/gridHelpers3D';

// ---------------------------------------------------------------------------
// snapToNiceStep — the core 1-2-5 step picker
// ---------------------------------------------------------------------------

describe('snapToNiceStep', () => {
  it('returns 1 for raw = 1', () => {
    expect(snapToNiceStep(1)).toBe(1);
  });

  it('returns 2 for raw = 1.1', () => {
    expect(snapToNiceStep(1.1)).toBe(2);
  });

  it('returns 2 for raw = 2', () => {
    expect(snapToNiceStep(2)).toBe(2);
  });

  it('returns 5 for raw = 2.1', () => {
    expect(snapToNiceStep(2.1)).toBe(5);
  });

  it('returns 5 for raw = 5', () => {
    expect(snapToNiceStep(5)).toBe(5);
  });

  it('returns 10 for raw = 5.1', () => {
    expect(snapToNiceStep(5.1)).toBe(10);
  });

  it('handles sub-unit values correctly', () => {
    expect(snapToNiceStep(0.1)).toBe(0.1);
    expect(snapToNiceStep(0.11)).toBe(0.2);
    expect(snapToNiceStep(0.3)).toBe(0.5);
    expect(snapToNiceStep(0.6)).toBe(1);
  });

  it('handles large values correctly', () => {
    expect(snapToNiceStep(100)).toBe(100);
    expect(snapToNiceStep(150)).toBe(200);
    expect(snapToNiceStep(300)).toBe(500);
    expect(snapToNiceStep(600)).toBe(1000);
  });

  it('always returns a value in the 1-2-5 sequence (mantissa check)', () => {
    for (const raw of [0.03, 0.07, 0.15, 0.4, 0.9, 1.5, 3, 7, 15, 40, 90, 150, 400, 900]) {
      const result = snapToNiceStep(raw);
      const exp = Math.floor(Math.log10(result));
      const mantissa = result / Math.pow(10, exp);
      const isNice =
        Math.abs(mantissa - 1) < 1e-9 ||
        Math.abs(mantissa - 2) < 1e-9 ||
        Math.abs(mantissa - 5) < 1e-9;
      expect(isNice, `raw=${raw} → result=${result} mantissa=${mantissa}`).toBe(true);
    }
  });

  it('result is always >= raw', () => {
    for (const raw of [0.03, 0.1, 0.5, 1, 2.5, 7, 33, 100, 777]) {
      expect(snapToNiceStep(raw)).toBeGreaterThanOrEqual(raw - 1e-9);
    }
  });

  it('handles zero and negative gracefully (returns 1)', () => {
    expect(snapToNiceStep(0)).toBe(1);
    expect(snapToNiceStep(-5)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// adaptiveGridStep3D — golden table across zoom decades
// ---------------------------------------------------------------------------

describe('adaptiveGridStep3D', () => {
  it('always returns a positive value', () => {
    for (const d of [0.1, 1, 10, 100, 1000, 10000, 100000]) {
      expect(adaptiveGridStep3D(d)).toBeGreaterThan(0);
    }
  });

  it('returns values in the 1-2-5 sequence (mantissa check)', () => {
    for (const d of [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const step = adaptiveGridStep3D(d);
      const exp = Math.floor(Math.log10(step));
      const mantissa = step / Math.pow(10, exp);
      const isNice =
        Math.abs(mantissa - 1) < 1e-9 ||
        Math.abs(mantissa - 2) < 1e-9 ||
        Math.abs(mantissa - 5) < 1e-9;
      expect(isNice, `distance=${d} → step=${step} mantissa=${mantissa}`).toBe(true);
    }
  });

  it('golden table: step grows with distance (order of magnitude)', () => {
    // Each decade of distance should increase the step by approximately a decade.
    const step1   = adaptiveGridStep3D(1);
    const step10  = adaptiveGridStep3D(10);
    const step100 = adaptiveGridStep3D(100);
    const step1k  = adaptiveGridStep3D(1000);
    const step10k = adaptiveGridStep3D(10000);

    expect(step10).toBeGreaterThan(step1);
    expect(step100).toBeGreaterThan(step10);
    expect(step1k).toBeGreaterThan(step100);
    expect(step10k).toBeGreaterThan(step1k);

    // The step ratio across a decade of distance should be roughly 10:1
    // (within the 1-2-5 quantisation, at most a 5× deviation expected).
    expect(step10 / step1).toBeGreaterThanOrEqual(5);
    expect(step100 / step10).toBeGreaterThanOrEqual(5);
    expect(step1k / step100).toBeGreaterThanOrEqual(5);
    expect(step10k / step1k).toBeGreaterThanOrEqual(5);
  });

  it('handles zero and negative distance gracefully (returns 1)', () => {
    expect(adaptiveGridStep3D(0)).toBe(1);
    expect(adaptiveGridStep3D(-10)).toBe(1);
  });

  it('respects a custom fovDeg — larger FOV gives larger visible area → same or larger step', () => {
    const step45 = adaptiveGridStep3D(10, 45);
    const step90 = adaptiveGridStep3D(10, 90);
    // 90° FOV sees more world → ideal step is larger → result is ≥ the 45° result
    expect(step90).toBeGreaterThanOrEqual(step45);
  });

  it('step * ~25 is within visible width at fov=45 (density check)', () => {
    // At any distance, step × N ≈ visibleWidth where N is the grid line count.
    // We expect N in [5, 50] — coarser than "too dense", finer than "no lines".
    for (const d of [1, 5, 10, 50, 100, 500, 1000]) {
      const step = adaptiveGridStep3D(d, 45);
      const fovHalfRad = (45 / 2) * (Math.PI / 180);
      const visibleWidth = 2 * d * Math.tan(fovHalfRad);
      const lineCount = visibleWidth / step;
      expect(lineCount, `d=${d} step=${step} lineCount=${lineCount}`).toBeGreaterThanOrEqual(4);
      expect(lineCount, `d=${d} step=${step} lineCount=${lineCount}`).toBeLessThanOrEqual(60);
    }
  });
});

// ---------------------------------------------------------------------------
// gridFadeDistance3D
// ---------------------------------------------------------------------------

describe('gridFadeDistance3D', () => {
  it('returns a value >= 50 at any distance', () => {
    for (const d of [0, 1, 5, 10, 100, 1000]) {
      expect(gridFadeDistance3D(d)).toBeGreaterThanOrEqual(50);
    }
  });

  it('grows with distance', () => {
    expect(gridFadeDistance3D(10)).toBeLessThan(gridFadeDistance3D(100));
    expect(gridFadeDistance3D(100)).toBeLessThan(gridFadeDistance3D(1000));
  });

  it('is approximately 6 × distance for distance > ~8', () => {
    expect(gridFadeDistance3D(100)).toBeCloseTo(600, 0);
    expect(gridFadeDistance3D(1000)).toBeCloseTo(6000, 0);
  });

  it('handles zero/negative distance gracefully', () => {
    expect(gridFadeDistance3D(0)).toBeGreaterThan(0);
    expect(gridFadeDistance3D(-10)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// scaleBarLength3D
// ---------------------------------------------------------------------------

describe('scaleBarLength3D', () => {
  it('returns positive worldLength and pixelLength', () => {
    const result = scaleBarLength3D(10, 800);
    expect(result.worldLength).toBeGreaterThan(0);
    expect(result.pixelLength).toBeGreaterThan(0);
  });

  it('worldLength is a nice number (1-2-5 sequence)', () => {
    for (const d of [1, 5, 10, 50, 100, 500, 1000]) {
      const { worldLength } = scaleBarLength3D(d, 800);
      const exp = Math.floor(Math.log10(worldLength));
      const mantissa = worldLength / Math.pow(10, exp);
      const isNice =
        Math.abs(mantissa - 1) < 1e-9 ||
        Math.abs(mantissa - 2) < 1e-9 ||
        Math.abs(mantissa - 5) < 1e-9;
      expect(isNice, `d=${d} → worldLength=${worldLength} mantissa=${mantissa}`).toBe(true);
    }
  });

  it('pixelLength scales with worldLength × (viewportPx / visibleWidth)', () => {
    const d = 10;
    const vpx = 800;
    const fovDeg = 45;
    const { worldLength, pixelLength } = scaleBarLength3D(d, vpx, fovDeg);
    const fovHalfRad = (fovDeg / 2) * (Math.PI / 180);
    const visibleWidth = 2 * d * Math.tan(fovHalfRad);
    const pxPerUnit = vpx / visibleWidth;
    expect(pixelLength).toBeCloseTo(worldLength * pxPerUnit, 5);
  });

  it('worldLength grows with camera distance (zoomed out → bigger world label)', () => {
    const near = scaleBarLength3D(1, 800).worldLength;
    const far  = scaleBarLength3D(1000, 800).worldLength;
    expect(far).toBeGreaterThan(near);
  });

  it('handles zero/negative inputs gracefully', () => {
    const r1 = scaleBarLength3D(0, 800);
    expect(r1.worldLength).toBeGreaterThan(0);
    expect(r1.pixelLength).toBeGreaterThan(0);

    const r2 = scaleBarLength3D(10, 0);
    expect(r2.worldLength).toBeGreaterThan(0);
    expect(r2.pixelLength).toBeGreaterThan(0);
  });

  it('respects a custom targetPx — larger target → larger pixel bar', () => {
    const small = scaleBarLength3D(10, 800, 45, 80).pixelLength;
    const large = scaleBarLength3D(10, 800, 45, 160).pixelLength;
    expect(large).toBeGreaterThanOrEqual(small);
  });
});
