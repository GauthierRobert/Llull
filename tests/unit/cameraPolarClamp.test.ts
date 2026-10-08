import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

describe('camera polar clamp', () => {
  const doc = createEmptyDocument();

  it.each([
    [0, 0.01],
    [-3, 0.01],
    [Math.PI, Math.PI - 0.01],
    [10, Math.PI - 0.01],
    [1, 1],
  ])('set_camera polar %s is stored as %s', (polar, expected) => {
    const result = execute(doc, 'set_camera', { polar });
    expect(result.document.camera.polar).toBeCloseTo(expected);
  });

  it('look_at clamps polar the same way', () => {
    const result = execute(doc, 'look_at', { target: [0, 0, 0], polar: 0 });
    expect(result.document.camera.polar).toBeCloseTo(0.01);
  });

  it('look_at without polar keeps the current polar', () => {
    const result = execute(doc, 'look_at', { target: [1, 2, 3] });
    expect(result.document.camera.polar).toBe(doc.camera.polar);
  });
});
