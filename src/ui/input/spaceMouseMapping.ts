// Axis values -> camera motion for a SpaceMouse, with per-axis invert, per-gesture speed and the dominant-axis option. Pure.
//
// Default gestures: push/pull sideways = pan right/left, lift/press = pan up/down, push/pull forward = dolly in/out,
// twist = orbit around the vertical axis, tilt forward/back = orbit up/down. Roll is unused.

import type { SpaceMouseAxes } from './spaceMouseReports';

export const AXIS_NAMES = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'] as const;
export type AxisName = (typeof AXIS_NAMES)[number];

export interface SpaceMouseSettings {
  invert: Readonly<Record<AxisName, boolean>>;
  /** Multipliers, 1 = default feel. */
  panSpeed: number;
  zoomSpeed: number;
  orbitSpeed: number;
  /** Only the single strongest axis moves the camera at a time (no accidental drift while panning). */
  dominantAxis: boolean;
}

export const DEFAULT_SETTINGS: SpaceMouseSettings = {
  invert: { tx: false, ty: false, tz: false, rx: false, ry: false, rz: false },
  panSpeed: 1,
  zoomSpeed: 1,
  orbitSpeed: 1,
  dominantAxis: false,
};

/** Per-second camera motion at full deflection and speed 1. */
const PAN_PER_SECOND = 1.0; // of the view distance
const ZOOM_PER_SECOND = 1.6; // e-folds of the view distance
const ORBIT_PER_SECOND = 2.2; // radians

const DEAD_ZONE = 0.04;
export const SPEED_RANGE = { min: 0.1, max: 4 } as const;

export interface CameraMotion {
  /** Fractions of the view distance: right, up. */
  panRight: number;
  panUp: number;
  /** Positive moves toward the target. */
  dolly: number;
  /** Radians: positive swings the eye toward +azimuth / lifts it toward the pole. */
  orbitAzimuth: number;
  orbitPolar: number;
}

/** Remove drift near rest, then rescale so the first live value starts at 0 (smooth start). */
function deadZone(value: number): number {
  const magnitude = Math.abs(value);
  return magnitude <= DEAD_ZONE ? 0 : Math.sign(value) * ((magnitude - DEAD_ZONE) / (1 - DEAD_ZONE));
}

function sixAxes(axes: SpaceMouseAxes): Record<AxisName, number> {
  const [tx, ty, tz] = axes.translation;
  const [rx, ry, rz] = axes.rotation;
  return { tx, ty, tz, rx, ry, rz };
}

/** @pure */
export function mapAxes(axes: SpaceMouseAxes, settings: SpaceMouseSettings): Record<AxisName, number> {
  const raw = sixAxes(axes);
  const shaped = {} as Record<AxisName, number>;
  for (const name of AXIS_NAMES) shaped[name] = deadZone(raw[name]) * (settings.invert[name] ? -1 : 1);
  if (!settings.dominantAxis) return shaped;
  const strongest = AXIS_NAMES.reduce((best, name) => (Math.abs(shaped[name]) > Math.abs(shaped[best]) ? name : best), AXIS_NAMES[0]);
  return Object.fromEntries(AXIS_NAMES.map((name) => [name, name === strongest ? shaped[name] : 0])) as Record<AxisName, number>;
}

/** Camera motion for `seconds` of the device being held at `axes`. @pure */
export function cameraMotion(axes: SpaceMouseAxes, settings: SpaceMouseSettings, seconds: number): CameraMotion {
  const a = mapAxes(axes, settings);
  const pan = PAN_PER_SECOND * settings.panSpeed * seconds;
  const orbit = ORBIT_PER_SECOND * settings.orbitSpeed * seconds;
  return {
    panRight: a.tx * pan,
    // z is negative when the cap is pulled up.
    panUp: -a.tz * pan,
    // y is negative when the cap is pushed away from the user.
    dolly: -a.ty * ZOOM_PER_SECOND * settings.zoomSpeed * seconds,
    orbitAzimuth: -a.rz * orbit,
    orbitPolar: a.rx * orbit,
  };
}

export function isIdle(motion: CameraMotion): boolean {
  return Object.values(motion).every((value) => value === 0);
}

const clampSpeed = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, value)) : fallback;

/** Settings from untrusted stored JSON; anything malformed falls back to the default. @pure */
export function sanitizeSettings(stored: unknown): SpaceMouseSettings {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_SETTINGS;
  const record = stored as Record<string, unknown>;
  const storedInvert = typeof record.invert === 'object' && record.invert !== null ? (record.invert as Record<string, unknown>) : {};
  const invert = Object.fromEntries(AXIS_NAMES.map((name) => [name, storedInvert[name] === true])) as Record<AxisName, boolean>;
  return {
    invert,
    panSpeed: clampSpeed(record.panSpeed, 1),
    zoomSpeed: clampSpeed(record.zoomSpeed, 1),
    orbitSpeed: clampSpeed(record.orbitSpeed, 1),
    dominantAxis: record.dominantAxis === true,
  };
}
