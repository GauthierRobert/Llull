import { describe, it, expect } from 'vitest';
import type { Vec2 } from '@core/model/types';
import { involuteOverlay, isInvoluteId, overlaySegments } from '@ui/viewport/2d/entities/involuteFrames';

// Involute of a unit circle sampled at t = 0..2: x = cos t + t sin t, y = sin t - t cos t.
const involute: Vec2[] = Array.from({ length: 41 }, (_, i) => {
  const t = (i / 40) * 2;
  return [Math.cos(t) + t * Math.sin(t), Math.sin(t) - t * Math.cos(t)];
});

describe('involute overlay frames', () => {
  it('recognises draw_involute ids only', () => {
    expect(isInvoluteId('inv-3.1')).toBe(true);
    expect(isInvoluteId('pl-3.1')).toBe(false);
  });

  it('normals at interior points are tangent to the base circle (perpendicular to the radius of the contact point)', () => {
    const { frames } = involuteOverlay(involute);
    expect(frames).toHaveLength(3);
    const mid = frames[1]!;
    const t = 1;
    const contact: Vec2 = [Math.cos(t), Math.sin(t)];
    expect(Math.abs(mid.normal[0] * contact[0] + mid.normal[1] * contact[1])).toBeLessThan(0.02);
    expect(Math.hypot(mid.tangent[0], mid.tangent[1])).toBeCloseTo(1);
  });

  it('is empty for degenerate input and emits one tangent and one normal shaft per frame', () => {
    expect(involuteOverlay([[0, 0]]).frames).toEqual([]);
    expect(
      involuteOverlay([
        [1, 1],
        [1, 1],
        [1, 1],
      ]).frames,
    ).toEqual([]);
    const { frames, arrow } = involuteOverlay(involute);
    const { tangents, normals } = overlaySegments(frames, arrow);
    expect(tangents).toHaveLength(18);
    expect(normals).toHaveLength(18);
  });
});
