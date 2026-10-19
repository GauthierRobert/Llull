import { describe, expect, it } from 'vitest';
import { REST_AXES, mergeReport, parseSpaceMouseReport } from '@ui/input/spaceMouseReports';
import { DEFAULT_SETTINGS, cameraMotion, isIdle, mapAxes, sanitizeSettings } from '@ui/input/spaceMouseMapping';
import { moveCamera } from '@ui/input/spaceMouseCamera';

function int16s(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return bytes;
}

describe('SpaceMouse HID reports', () => {
  it('parses translation (id 1) and rotation (id 2), normalised to -1..1', () => {
    expect(parseSpaceMouseReport(1, int16s(350, -175, 0))).toEqual({ type: 'translation', values: [1, -0.5, 0] });
    expect(parseSpaceMouseReport(2, int16s(0, 0, -350))).toEqual({ type: 'rotation', values: [0, 0, -1] });
  });
  it('clamps readings beyond full deflection', () => {
    expect(parseSpaceMouseReport(1, int16s(30000, -30000, 0))).toEqual({ type: 'translation', values: [1, -1, 0] });
  });
  it('parses the combined 6-axis report of newer devices', () => {
    expect(parseSpaceMouseReport(1, int16s(350, 0, 0, 0, 0, 350))).toEqual({ type: 'motion', translation: [1, 0, 0], rotation: [0, 0, 1] });
  });
  it('parses the button bitmask and ignores unknown / short reports', () => {
    expect(parseSpaceMouseReport(3, new Uint8Array([0x05, 0x01]))).toEqual({ type: 'buttons', mask: 0x105 });
    expect(parseSpaceMouseReport(9, int16s(1, 2, 3))).toBeNull();
    expect(parseSpaceMouseReport(1, new Uint8Array([1, 2]))).toBeNull();
    expect(parseSpaceMouseReport(2, new Uint8Array([]))).toBeNull();
  });
  it('merges half reports into the latest axes', () => {
    const afterT = mergeReport(REST_AXES, { type: 'translation', values: [1, 0, 0] });
    const afterR = mergeReport(afterT, { type: 'rotation', values: [0, 0, 0.5] });
    expect(afterR).toEqual({ translation: [1, 0, 0], rotation: [0, 0, 0.5] });
    expect(mergeReport(afterR, { type: 'buttons', mask: 1 })).toBe(afterR);
    expect(mergeReport(afterR, { type: 'motion', translation: [0, 1, 0], rotation: [0, 0, 0] })).toEqual({
      translation: [0, 1, 0],
      rotation: [0, 0, 0],
    });
  });
});

describe('SpaceMouse mapping', () => {
  it('is idle inside the dead zone', () => {
    expect(isIdle(cameraMotion({ translation: [0.02, -0.03, 0.01], rotation: [0.03, 0, 0] }, DEFAULT_SETTINGS, 1))).toBe(true);
  });
  it('maps the default gestures', () => {
    const pan = cameraMotion({ translation: [1, 0, 0], rotation: [0, 0, 0] }, DEFAULT_SETTINGS, 1);
    expect(pan.panRight).toBeGreaterThan(0);
    const pushForward = cameraMotion({ translation: [0, -1, 0], rotation: [0, 0, 0] }, DEFAULT_SETTINGS, 1);
    expect(pushForward.dolly).toBeGreaterThan(0);
    const lift = cameraMotion({ translation: [0, 0, -1], rotation: [0, 0, 0] }, DEFAULT_SETTINGS, 1);
    expect(lift.panUp).toBeGreaterThan(0);
    const twist = cameraMotion({ translation: [0, 0, 0], rotation: [0, 0, 1] }, DEFAULT_SETTINGS, 1);
    expect(twist.orbitAzimuth).not.toBe(0);
  });
  it('inverts one axis and scales by speed and time', () => {
    const base = cameraMotion({ translation: [1, 0, 0], rotation: [0, 0, 0] }, DEFAULT_SETTINGS, 0.5);
    const inverted = cameraMotion(
      { translation: [1, 0, 0], rotation: [0, 0, 0] },
      { ...DEFAULT_SETTINGS, invert: { ...DEFAULT_SETTINGS.invert, tx: true } },
      0.5,
    );
    expect(inverted.panRight).toBeCloseTo(-base.panRight);
    const fast = cameraMotion({ translation: [1, 0, 0], rotation: [0, 0, 0] }, { ...DEFAULT_SETTINGS, panSpeed: 2 }, 0.5);
    expect(fast.panRight).toBeCloseTo(base.panRight * 2);
  });
  it('keeps only the strongest axis in dominant mode', () => {
    const mapped = mapAxes({ translation: [0.9, 0.3, 0], rotation: [0, 0, 0.2] }, { ...DEFAULT_SETTINGS, dominantAxis: true });
    expect(mapped.tx).toBeGreaterThan(0);
    expect(mapped.ty).toBe(0);
    expect(mapped.rz).toBe(0);
  });
  it('sanitises stored settings', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ panSpeed: 99, zoomSpeed: 'x', invert: { tx: true, bogus: true }, dominantAxis: true })).toMatchObject({
      panSpeed: 4,
      zoomSpeed: 1,
      dominantAxis: true,
      invert: { tx: true, ty: false },
    });
  });
});

describe('moveCamera', () => {
  const pose = { position: [0, -10, 0] as const, target: [0, 0, 0] as const };
  const none = { panRight: 0, panUp: 0, dolly: 0, orbitAzimuth: 0, orbitPolar: 0 };

  it('does not move without motion', () => {
    const next = moveCamera({ position: [3, 4, 5], target: [0, 0, 0] }, none);
    expect(next.position[0]).toBeCloseTo(3);
    expect(next.position[1]).toBeCloseTo(4);
    expect(next.position[2]).toBeCloseTo(5);
  });
  it('dollies toward the target', () => {
    const next = moveCamera(pose, { ...none, dolly: Math.log(2) });
    expect(next.position[1]).toBeCloseTo(-5);
  });
  it('pans the eye and target together, sideways for a horizontal view', () => {
    const next = moveCamera(pose, { ...none, panRight: 0.1 });
    expect(next.target[0]).toBeCloseTo(1);
    expect(next.position[0]).toBeCloseTo(1);
    expect(next.position[1]).toBeCloseTo(-10);
  });
  it('orbits at constant distance and never reaches the pole', () => {
    const turned = moveCamera(pose, { ...none, orbitAzimuth: Math.PI / 2 });
    expect(Math.hypot(...turned.position)).toBeCloseTo(10);
    const lifted = moveCamera(pose, { ...none, orbitPolar: 10 });
    expect(Math.hypot(...lifted.position)).toBeCloseTo(10);
    expect(lifted.position[2]).toBeLessThan(10);
  });
});
