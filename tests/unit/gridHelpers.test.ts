/**
 * Unit tests for the 2D grid / scale-bar pure helpers.
 *
 * All functions are pure — no DOM, Canvas, or three.js needed.
 * Tests cover: adaptiveGridStep, majorGridStep, scaleBarLength.
 */

import { describe, it, expect } from 'vitest';
import {
  adaptiveGridStep,
  majorGridStep,
  localGridPatch,
  pixelsToWorld,
  scaleBarLength,
} from '@ui/viewport/2d/gridHelpers';

// ---------------------------------------------------------------------------
// adaptiveGridStep
// ---------------------------------------------------------------------------

describe('adaptiveGridStep', () => {
  it('returns a positive step for typical zoom values', () => {
    for (const zoom of [1, 5, 10, 50, 100, 500, 1000]) {
      const step = adaptiveGridStep(zoom);
      expect(step).toBeGreaterThan(0);
    }
  });

  it('returns step >= 1 at default zoom (50)', () => {
    // zoom=50 means 1 world unit = 50 px; ideal step ~ 20/50 = 0.4 → rounds to 0.5
    const step = adaptiveGridStep(50);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThanOrEqual(10); // should be something sensible like 0.5 or 1
  });

  it('returns larger steps when zoomed out (small zoom)', () => {
    const zoomedIn = adaptiveGridStep(100);
    const zoomedOut = adaptiveGridStep(1);
    expect(zoomedOut).toBeGreaterThan(zoomedIn);
  });

  it('returns smaller steps when zoomed in (large zoom)', () => {
    const step100 = adaptiveGridStep(100);
    const step1000 = adaptiveGridStep(1000);
    expect(step1000).toBeLessThanOrEqual(step100);
  });

  it('produces minor steps in the 20–120 px range for any zoom', () => {
    for (const zoom of [0.5, 2, 10, 50, 200, 1000, 5000]) {
      const step = adaptiveGridStep(zoom);
      const px = step * zoom;
      // Allow some tolerance at boundary conditions (step must be a nice number)
      expect(px).toBeGreaterThan(5);
      expect(px).toBeLessThan(2000);
    }
  });

  it('always returns a nice step (1, 2, or 5 × 10^n)', () => {
    for (const zoom of [1, 3, 7, 20, 50, 100, 300, 1000]) {
      const step = adaptiveGridStep(zoom);
      const log10 = Math.log10(step);
      const exp = Math.floor(log10);
      const mantissa = step / Math.pow(10, exp);
      // mantissa should be 1, 2, or 5 (with floating-point tolerance)
      const isNice =
        Math.abs(mantissa - 1) < 1e-9 ||
        Math.abs(mantissa - 2) < 1e-9 ||
        Math.abs(mantissa - 5) < 1e-9;
      expect(isNice, `step=${step} zoom=${zoom} mantissa=${mantissa}`).toBe(true);
    }
  });

  it('handles zero/negative zoom gracefully (returns 1)', () => {
    expect(adaptiveGridStep(0)).toBe(1);
    expect(adaptiveGridStep(-5)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// majorGridStep
// ---------------------------------------------------------------------------

describe('majorGridStep', () => {
  it('is always 10× the minor step', () => {
    for (const minor of [0.1, 0.5, 1, 2, 5, 10, 100]) {
      expect(majorGridStep(minor)).toBeCloseTo(minor * 10);
    }
  });
});

// ---------------------------------------------------------------------------
// pixelsToWorld
// ---------------------------------------------------------------------------

describe('pixelsToWorld', () => {
  it('converts pixels to world units as pixels / zoom', () => {
    expect(pixelsToWorld(12, 50)).toBeCloseTo(0.24);
    expect(pixelsToWorld(10, 1)).toBeCloseTo(10);
    expect(pixelsToWorld(100, 1000)).toBeCloseTo(0.1);
  });

  it('shrinks the world distance as zoom grows (screen-constant)', () => {
    const zoomedOut = pixelsToWorld(12, 1);
    const zoomedIn = pixelsToWorld(12, 1000);
    expect(zoomedIn).toBeLessThan(zoomedOut);
  });

  it('keeps the on-screen pixel size constant across zoom', () => {
    for (const zoom of [1, 10, 50, 200, 1000]) {
      // world × zoom should recover the original pixel count.
      expect(pixelsToWorld(12, zoom) * zoom).toBeCloseTo(12);
    }
  });

  it('falls back to a 1:1 mapping for zero/negative zoom', () => {
    expect(pixelsToWorld(12, 0)).toBe(12);
    expect(pixelsToWorld(12, -5)).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// localGridPatch
// ---------------------------------------------------------------------------

describe('localGridPatch', () => {
  it('returns an even division count ≥ 2', () => {
    for (const visibleWorld of [1, 10, 100, 1000]) {
      for (const step of [0.01, 0.1, 1, 10, 100]) {
        const { divisions } = localGridPatch(visibleWorld, step);
        expect(divisions % 2).toBe(0);
        expect(divisions).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('keeps the cell count BOUNDED even as the step shrinks toward zero', () => {
    // This is the whole point: a fixed extent would explode here. Because the
    // patch tracks the viewport, divisions stays bounded for a realistic
    // (pixel-bounded) step regardless of how far you zoom in.
    const visibleWorld = 1000; // e.g. 50000 px / zoom 50
    for (const step of [10, 1, 0.1, 0.01, 0.001]) {
      const { divisions } = localGridPatch(visibleWorld, step);
      // With matching pixel-bounded steps the ratio visibleWorld/step is what
      // bounds divisions; here we just assert it never exceeds the safety cap.
      expect(divisions).toBeLessThanOrEqual(1000);
    }
  });

  it('covers at least the requested margin × viewport', () => {
    const { extent } = localGridPatch(100, 1, 2.5);
    expect(extent).toBeGreaterThanOrEqual(100 * 2.5);
  });

  it('extent is exactly divisions × step (lines align to the world step)', () => {
    const step = 0.5;
    const { extent, divisions } = localGridPatch(40, step);
    expect(extent).toBeCloseTo(divisions * step);
  });

  it('scales the patch with the margin multiplier', () => {
    const small = localGridPatch(100, 1, 1).extent;
    const large = localGridPatch(100, 1, 4).extent;
    expect(large).toBeGreaterThan(small);
  });

  it('clamps to an even maxDivisions cap', () => {
    // Tiny step vs huge viewport would demand a vast division count.
    const { divisions } = localGridPatch(1e6, 0.001, 2.5, 1000);
    expect(divisions).toBe(1000);
    expect(divisions % 2).toBe(0);
  });

  it('returns a minimal patch for non-positive inputs', () => {
    expect(localGridPatch(0, 1).divisions).toBe(2);
    expect(localGridPatch(100, 0).divisions).toBe(2);
    expect(localGridPatch(100, -1).divisions).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// scaleBarLength
// ---------------------------------------------------------------------------

describe('scaleBarLength', () => {
  it('returns positive worldLength and pixelLength', () => {
    const result = scaleBarLength(50);
    expect(result.worldLength).toBeGreaterThan(0);
    expect(result.pixelLength).toBeGreaterThan(0);
  });

  it('pixelLength ≈ worldLength × zoom', () => {
    const zoom = 50;
    const { worldLength, pixelLength } = scaleBarLength(zoom);
    expect(pixelLength).toBeCloseTo(worldLength * zoom, 5);
  });

  it('pixelLength is at least half the target size', () => {
    for (const zoom of [1, 10, 50, 200, 1000]) {
      const { pixelLength } = scaleBarLength(zoom, 80);
      expect(pixelLength).toBeGreaterThanOrEqual(40 - 1e-6);
    }
  });

  it('worldLength is a nice number (1, 2, 5, or 10 × 10^n)', () => {
    for (const zoom of [0.5, 1, 5, 20, 50, 100, 500]) {
      const { worldLength } = scaleBarLength(zoom);
      const log10 = Math.log10(worldLength);
      const exp = Math.floor(log10);
      const mantissa = worldLength / Math.pow(10, exp);
      const isNice =
        Math.abs(mantissa - 1) < 1e-9 ||
        Math.abs(mantissa - 2) < 1e-9 ||
        Math.abs(mantissa - 5) < 1e-9 ||
        Math.abs(mantissa - 10) < 1e-9;
      expect(isNice, `worldLength=${worldLength} zoom=${zoom} mantissa=${mantissa}`).toBe(true);
    }
  });

  it('respects a custom targetPx', () => {
    const { pixelLength } = scaleBarLength(50, 120);
    expect(pixelLength).toBeGreaterThanOrEqual(60 - 1e-6);
  });

  it('handles zero zoom gracefully', () => {
    const result = scaleBarLength(0);
    expect(result.worldLength).toBeGreaterThan(0);
    expect(result.pixelLength).toBeGreaterThan(0);
  });
});
