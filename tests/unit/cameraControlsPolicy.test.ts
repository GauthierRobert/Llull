import { describe, it, expect } from 'vitest';
import { cameraGestures } from '@ui/viewport/2d/cameraControlsPolicy';

describe('cameraGestures', () => {
  it('keeps wheel zoom but disables drag-pan while a draw/modify tool is armed', () => {
    expect(cameraGestures(true)).toEqual({ enablePan: false, enableZoom: true });
  });
  it('allows pan and zoom when no tool is armed', () => {
    expect(cameraGestures(false)).toEqual({ enablePan: true, enableZoom: true });
  });
});
