// Pure maths of the walk / fly navigation (UI-only, +Z up, WORLD coordinates in document units): look angles, key mapping, speed scaling and
// the per-frame step. Yaw 0 faces +Y and grows toward +X (as the orbit azimuth); pitch 0 is level, positive looks up.

export type NavigationMode = 'orbit' | 'walk' | 'fly';
export type Vec3 = readonly [number, number, number];

/** Looking straight up/down would flip the horizon: the pitch stops just short of the poles. */
export const MAX_PITCH = Math.PI / 2 - 0.02;
/** Radians of turn per pixel of pointer movement. */
const LOOK_SENSITIVITY = 0.0022;
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

/** Wish direction (length at most 1): walk stays level, fly follows the view and rises along world Z. */
function wishVector(angles: LookAngles, input: MoveInput, mode: 'walk' | 'fly'): [number, number, number] {
  const sinYaw = Math.sin(angles.yaw);
  const cosYaw = Math.cos(angles.yaw);
  const forward: Vec3 = mode === 'fly' ? lookDirection(angles) : [sinYaw, cosYaw, 0];
  const rise = mode === 'fly' ? input.rise : 0;
  const wish: [number, number, number] = [
    forward[0] * input.forward + cosYaw * input.strafe,
    forward[1] * input.forward - sinYaw * input.strafe,
    forward[2] * input.forward + rise,
  ];
  const length = Math.hypot(...wish);
  if (length > 1) return [wish[0] / length, wish[1] / length, wish[2] / length];
  return wish;
}

/** A frame time that is not a finite number of seconds moves nothing. */
function safeDt(dt: number): number {
  return Number.isFinite(dt) ? Math.max(dt, 0) : 0;
}

function travelDistance(speed: number, input: MoveInput, dt: number): number {
  const distance = speed * (input.boost ? BOOST_FACTOR : 1) * safeDt(dt);
  return Number.isFinite(distance) ? distance : 0;
}

/** Fly eye position after `dt` seconds: along the view for forward/back, along world Z for rise (walk is `stepWalk`). */
export function stepNavigation(position: Vec3, angles: LookAngles, input: MoveInput, dt: number, speed: number): [number, number, number] {
  const wish = wishVector(angles, input, 'fly');
  const distance = travelDistance(speed, input, dt);
  return [position[0] + wish[0] * distance, position[1] + wish[1] * distance, position[2] + wish[2] * distance];
}

export interface WallHit {
  readonly distance: number;
  /** Horizontal unit normal of the surface, facing the ray origin. */
  readonly normal: readonly [number, number];
}

/** What the walker can touch (the scene probe; the maths never sees three.js). Document units, WORLD space, +Z up. */
export interface WalkWorld {
  /** Highest walkable surface at or below `fromZ` under (x, y); null when there is none. */
  floorBelow(x: number, y: number, fromZ: number): number | null;
  /** Nearest blocking surface along the horizontal ray within `maxDistance`. */
  wallAhead(origin: Vec3, dirX: number, dirY: number, maxDistance: number): WallHit | null;
  /** Lowest surface above `fromZ` under (x, y) within `maxDistance` (a ceiling, seen from below); its z, or null. */
  ceilingAbove(x: number, y: number, fromZ: number, maxDistance: number): number | null;
}

export interface WalkBody {
  /** Soles of the feet; the eye is `feet[2] + eyeHeight`. */
  readonly feet: Vec3;
  readonly velocityZ: number;
  readonly grounded: boolean;
}

export interface WalkOptions {
  readonly speed: number;
  readonly eyeHeight: number;
  /** Horizontal capsule radius. */
  readonly radius: number;
  /** Highest riser walked onto (stairs); a taller surface is a wall. */
  readonly stepHeight: number;
  /** Units per second squared, positive. */
  readonly gravity: number;
  /** Fall speed cap, units per second. */
  readonly terminalSpeed: number;
  /** Lowest floor the walker can reach when the scene has nothing below the feet: the ground plane z = 0, or the scene's lowest point when
   *  that is lower. A missing hit never raises the feet above where they are. */
  readonly baseFloor: number;
}

/** Wall probes cross at most this fraction of the radius per sub-step, so a boosted frame cannot jump a thin wall. */
const SUBSTEP_RADIUS_FRACTION = 0.75;
const MAX_SUBSTEPS = 16;
const FAN_ANGLES: readonly number[] = [0, Math.PI / 5, -Math.PI / 5];
const SKIN = 1e-6;
/** Probe height above the step height: risers up to the step height are not walls, anything taller is (no blind band above it). */
const KNEE_MARGIN = 1e-3;

function blockedBy(world: WalkWorld, feet: Vec3, move: readonly [number, number], options: WalkOptions): WallHit | null {
  const length = Math.hypot(move[0], move[1]);
  if (length === 0) return null;
  const baseAngle = Math.atan2(move[1], move[0]);
  const heights = [options.stepHeight + KNEE_MARGIN, options.eyeHeight * 0.6];
  let nearest: WallHit | null = null;
  for (const height of heights) {
    const origin: Vec3 = [feet[0], feet[1], feet[2] + height];
    for (const offset of FAN_ANGLES) {
      const dirX = Math.cos(baseAngle + offset);
      const dirY = Math.sin(baseAngle + offset);
      const hit = world.wallAhead(origin, dirX, dirY, options.radius + length);
      if (hit === null) continue;
      const advance = move[0] * dirX + move[1] * dirY;
      if (advance <= Math.max(hit.distance - options.radius, 0) + SKIN) continue;
      if (nearest === null || hit.distance < nearest.distance) nearest = hit;
    }
  }
  return nearest;
}

/** One horizontal sub-move: slides along the first wall hit, re-probes the slid move and stops when it is still blocked. */
function slideMove(world: WalkWorld, feet: Vec3, wish: readonly [number, number], options: WalkOptions): [number, number] {
  let move: [number, number] = [wish[0], wish[1]];
  for (let pass = 0; pass < 2; pass += 1) {
    const hit = blockedBy(world, feet, move, options);
    if (hit === null) return move;
    const into = move[0] * hit.normal[0] + move[1] * hit.normal[1];
    if (into >= 0) return move;
    move = [move[0] - hit.normal[0] * into, move[1] - hit.normal[1] * into];
  }
  return blockedBy(world, feet, move, options) === null ? move : [0, 0];
}

function settleVertically(world: WalkWorld, body: WalkBody, feet: Vec3, dt: number, options: WalkOptions): WalkBody {
  const found = world.floorBelow(feet[0], feet[1], feet[2] + options.stepHeight);
  const floor = found ?? Math.min(options.baseFloor, feet[2]);
  if (body.grounded && feet[2] - floor <= options.stepHeight) return { feet: [feet[0], feet[1], floor], velocityZ: 0, grounded: true };
  const velocityZ = Math.max(body.velocityZ - options.gravity * dt, -options.terminalSpeed);
  const z = feet[2] + velocityZ * dt;
  if (z <= floor) return { feet: [feet[0], feet[1], floor], velocityZ: 0, grounded: true };
  return { feet: [feet[0], feet[1], z], velocityZ, grounded: false };
}

/** Walk step: floor following (up to `stepHeight`, snaps down stairs), gravity when no floor is within reach, a ray fan against walls with
 *  sliding. Fixed sub-steps keep the wall test from tunnelling at boost speed. */
/** Free height above `floorZ` at (x, y): the distance to the ceiling, or Infinity when none is within the walker's height. */
function headroom(world: WalkWorld, x: number, y: number, floorZ: number, options: WalkOptions): number {
  const ceiling = world.ceilingAbove(x, y, floorZ + options.stepHeight, options.eyeHeight - options.stepHeight + options.radius);
  return ceiling === null ? Number.POSITIVE_INFINITY : ceiling - floorZ;
}

export function stepWalk(
  body: WalkBody,
  angles: LookAngles,
  input: MoveInput,
  dt: number,
  options: WalkOptions,
  world: WalkWorld,
): WalkBody {
  const wish = wishVector(angles, input, 'walk');
  const distance = travelDistance(options.speed, input, dt);
  const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(distance / (options.radius * SUBSTEP_RADIUS_FRACTION))));
  const each = distance / substeps;
  let current = body;
  for (let index = 0; index < substeps; index += 1) {
    const move = slideMove(world, current.feet, [wish[0] * each, wish[1] * each], options);
    const feet: Vec3 = [current.feet[0] + move[0], current.feet[1] + move[1], current.feet[2]];
    const next = settleVertically(world, current, feet, safeDt(dt) / substeps, options);
    // Refuse a move (or a step up) that leaves less than the walker's height under a ceiling, unless it is no worse than where they stand.
    const room = headroom(world, next.feet[0], next.feet[1], next.feet[2], options);
    const blocked = room < options.eyeHeight && room < headroom(world, current.feet[0], current.feet[1], current.feet[2], options);
    current = blocked ? settleVertically(world, current, current.feet, safeDt(dt) / substeps, options) : next;
  }
  return current;
}

/** A walker put down at the eye position: on the floor found below it (or the base floor). */
export function dropOntoFloor(eye: Vec3, world: WalkWorld, baseFloor: number): WalkBody {
  const found = world.floorBelow(eye[0], eye[1], eye[2]);
  return { feet: [eye[0], eye[1], found ?? Math.min(baseFloor, eye[2])], velocityZ: 0, grounded: true };
}

/** True when the camera is not where the walk last put it (a goto, view preset or fit moved it): the walker must be re-seeded there. */
export function cameraMovedExternally(lastWritten: Vec3 | null, current: Vec3, epsilon: number): boolean {
  if (lastWritten === null) return true;
  return Math.hypot(current[0] - lastWritten[0], current[1] - lastWritten[1], current[2] - lastWritten[2]) > epsilon;
}

/** The scene's lowest point: the walker's floor when nothing is below, so a scene entirely below z = 0 is not walked UP to z = 0. */
export function walkBaseFloor(sceneMinZ: number | null): number {
  return sceneMinZ === null || !Number.isFinite(sceneMinZ) ? 0 : Math.min(0, sceneMinZ);
}
