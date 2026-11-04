// Pure maths of the walk / fly navigation (UI-only, +Z up, WORLD coordinates in document units): look angles, key mapping, speed scaling and
// the per-frame step. Yaw 0 faces +Y and grows toward +X (as the orbit azimuth); pitch 0 is level, positive looks up.

export type NavigationMode = 'orbit' | 'walk' | 'fly';
export type Vec3 = readonly [number, number, number];

/** Looking straight up/down would flip the horizon: the pitch stops just short of the poles. */
export const MAX_PITCH = Math.PI / 2 - 0.02;
/** Radians of turn per pixel of pointer movement. */
export const LOOK_SENSITIVITY = 0.0022;
/** Walk eye height above the floor, in millimetres. */
export const EYE_HEIGHT_MM = 1600;
/** Holding Shift multiplies the speed. */
export const BOOST_FACTOR = 3;
/** Walk/fly speed: the model's diagonal crossed in this many seconds. */
const SECONDS_TO_CROSS_MODEL = 12;
const MIN_SPEED = 0.05;

export interface LookAngles {
  readonly yaw: number;
  readonly pitch: number;
}

export interface MoveInput {
  /** -1 back, +1 forward. */
  readonly forward: number;
  /** -1 left, +1 right. */
  readonly strafe: number;
  /** -1 down, +1 up (fly only). */
  readonly rise: number;
  readonly boost: boolean;
}

export const NO_INPUT: MoveInput = { forward: 0, strafe: 0, rise: 0, boost: false };

export function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH, Math.max(-MAX_PITCH, pitch));
}

/** Pointer movement in pixels (right/down positive) turns the view; the pitch is clamped, the yaw wraps to [-pi, pi]. */
export function applyMouseLook(angles: LookAngles, dx: number, dy: number, sensitivity = LOOK_SENSITIVITY): LookAngles {
  const yaw = angles.yaw + dx * sensitivity;
  const wrapped = yaw - Math.PI * 2 * Math.round(yaw / (Math.PI * 2));
  return { yaw: wrapped, pitch: clampPitch(angles.pitch - dy * sensitivity) };
}

export function lookDirection({ yaw, pitch }: LookAngles): [number, number, number] {
  const level = Math.cos(pitch);
  return [Math.sin(yaw) * level, Math.cos(yaw) * level, Math.sin(pitch)];
}

/** Angles of a world direction (not necessarily unit); a zero vector faces +Y level. */
export function anglesOfDirection(direction: Vec3): LookAngles {
  const [x, y, z] = direction;
  const length = Math.hypot(x, y, z);
  if (length === 0) return { yaw: 0, pitch: 0 };
  return { yaw: Math.atan2(x, y), pitch: clampPitch(Math.asin(z / length)) };
}

/** Units per second: the model diagonal in ~12 s, so a chair and a plant both feel walkable; `fallbackSpeed` for an empty document. */
export function navigationSpeed(modelDiagonal: number | null, fallbackSpeed: number): number {
  if (modelDiagonal === null || !Number.isFinite(modelDiagonal) || modelDiagonal <= 0) return fallbackSpeed;
  return Math.max(modelDiagonal / SECONDS_TO_CROSS_MODEL, MIN_SPEED);
}

/** Keys held (KeyboardEvent.code) -> movement intent. Opposing keys cancel. */
export function inputFromKeys(held: ReadonlySet<string>): MoveInput {
  const axis = (positive: readonly string[], negative: readonly string[]): number =>
    (positive.some((code) => held.has(code)) ? 1 : 0) - (negative.some((code) => held.has(code)) ? 1 : 0);
  return {
    forward: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
    strafe: axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']),
    rise: axis(['KeyE', 'Space'], ['KeyQ', 'KeyC']),
    boost: held.has('ShiftLeft') || held.has('ShiftRight'),
  };
}

export const NAVIGATION_KEY_CODES: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyC',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);

export interface StepOptions {
  readonly mode: 'walk' | 'fly';
  /** Units per second before the boost. */
  readonly speed: number;
  /** Walk: the eye's world Z (floor + eye height). Ignored in fly. */
  readonly eyeZ: number;
}

/** Eye position after `dt` seconds. Walk stays level at `eyeZ`; fly moves along the view for forward/back and along world Z for rise. */
export function stepNavigation(
  position: Vec3,
  angles: LookAngles,
  input: MoveInput,
  dt: number,
  options: StepOptions,
): [number, number, number] {
  const sinYaw = Math.sin(angles.yaw);
  const cosYaw = Math.cos(angles.yaw);
  const forward: Vec3 = options.mode === 'fly' ? lookDirection(angles) : [sinYaw, cosYaw, 0];
  const rise = options.mode === 'fly' ? input.rise : 0;
  const wish: [number, number, number] = [
    forward[0] * input.forward + cosYaw * input.strafe,
    forward[1] * input.forward - sinYaw * input.strafe,
    forward[2] * input.forward + rise,
  ];
  const length = Math.hypot(...wish);
  const distance = options.speed * (input.boost ? BOOST_FACTOR : 1) * Math.max(dt, 0);
  const scale = length > 1 ? distance / length : distance;
  const next: [number, number, number] = [position[0] + wish[0] * scale, position[1] + wish[1] * scale, position[2] + wish[2] * scale];
  if (options.mode === 'walk') next[2] = options.eyeZ;
  return next;
}
