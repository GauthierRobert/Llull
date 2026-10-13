import { describe, it, expect } from 'vitest';
import { cameraGestures, MAP_CONTROLS_CONFIG } from '@ui/viewport/2d/cameraControlsPolicy';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { xy } from '../helpers/xy';

describe('MAP_CONTROLS_CONFIG', () => {
  it('is a top-down view that zooms toward the cursor with screen-space panning', () => {
    expect(MAP_CONTROLS_CONFIG).toMatchObject({ enableRotate: false, screenSpacePanning: true, zoomToCursor: true });
    expect(MAP_CONTROLS_CONFIG.zoomSpeed).toBeGreaterThan(1.2);
  });
  it('never lets the tool-armed gestures re-enable rotation', () => {
    expect({ ...MAP_CONTROLS_CONFIG, ...cameraGestures(true) }).toMatchObject({ enableRotate: false, enablePan: false, enableZoom: true });
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

describe('camera polar clamp', () => {
  const doc = createEmptyDocument();
  it.each(xy(0, 0.01, -3, 0.01, Math.PI, Math.PI - 0.01, 10, Math.PI - 0.01, 1, 1))(
    'set_camera polar %s is stored as %s',
    (polar, expected) => {
      const result = execute(doc, 'set_camera', { polar });
      expect(result.document.camera.polar).toBeCloseTo(expected);
    },
  );
  it('set_camera clamps polar the same way', () => {
    const result = execute(doc, 'set_camera', { target: [0, 0, 0], polar: 0 });
    expect(result.document.camera.polar).toBeCloseTo(0.01);
  });
  it('set_camera without polar keeps the current polar', () => {
    const result = execute(doc, 'set_camera', { target: [1, 2, 3] });
    expect(result.document.camera.polar).toBe(doc.camera.polar);
  });
});
