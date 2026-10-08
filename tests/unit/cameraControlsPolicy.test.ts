import { describe, it, expect } from 'vitest';
import { cameraGestures, MAP_CONTROLS_CONFIG } from '@ui/viewport/2d/cameraControlsPolicy';

describe('MAP_CONTROLS_CONFIG', () => {
  it('is a top-down view that zooms toward the cursor with screen-space panning', () => {
    expect(MAP_CONTROLS_CONFIG).toMatchObject({
      enableRotate: false,
      screenSpacePanning: true,
      zoomToCursor: true,
    });
    expect(MAP_CONTROLS_CONFIG.zoomSpeed).toBeGreaterThan(1.2);
  });

  it('never lets the tool-armed gestures re-enable rotation', () => {
    expect({ ...MAP_CONTROLS_CONFIG, ...cameraGestures(true) }).toMatchObject({
      enableRotate: false,
      enablePan: false,
      enableZoom: true,
    });
  });
});

describe('cameraGestures', () => {
  it('keeps wheel zoom but disables drag-pan while a draw/modify tool is armed', () => {
    expect(cameraGestures(true)).toEqual({ enablePan: false, enableZoom: true });
  });
  it('allows pan and zoom when no tool is armed', () => {
    expect(cameraGestures(false)).toEqual({ enablePan: true, enableZoom: true });
  });
});
