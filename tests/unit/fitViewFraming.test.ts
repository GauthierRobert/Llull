import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const VIEWPORT_HALF_FOV_RAD = (45 / 2) * (Math.PI / 180);

describe('fit_view framing margin', () => {
  const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] }).document;

  it('keeps the whole bounding sphere inside the 45 degree viewport frustum with margin', () => {
    const { camera } = execute(box, 'fit_view', {}).document;
    const radius = Math.sqrt(3);
    const angularRadius = Math.asin(radius / camera.distance);
    expect(angularRadius).toBeLessThan(VIEWPORT_HALF_FOV_RAD * 0.9);
    expect(camera.distance).toBeCloseTo((radius / Math.sin(VIEWPORT_HALF_FOV_RAD)) * 1.2);
  });

  it('padding scales the distance linearly', () => {
    const base = execute(box, 'fit_view', { padding: 1 }).document.camera.distance;
    const wide = execute(box, 'fit_view', { padding: 2 }).document.camera.distance;
    expect(wide).toBeCloseTo(base * 2);
  });

  it('rejects a non-positive padding without moving the camera', () => {
    const result = execute(box, 'fit_view', { padding: 0 });
    expect(result.document).toBe(box);
    expect(result.summary).toContain('padding must be > 0');
  });
});
