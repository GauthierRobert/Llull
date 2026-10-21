/**
 * HALO "how it works" film: every frame is the HALO v2 document moved by registered commands
 * (move_entities / rotate_entity / add_box / add_sphere) and drawn by render_view. The script only
 * computes the poses; llull builds and renders each frame. Bundled and run by `render.sh`.
 *
 *   node renderFrames.cjs <doc.llull.json> <outDir> [firstFrame] [lastFrame]
 */
import fs from 'node:fs';
import path from 'node:path';
import '../../../server/src/plugins';
import { installGeometryKernel } from '../../../server/src/geometryKernel';
import { readDocumentFile } from '../../../server/src/documentFile';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';

type V3 = [number, number, number];
type M3 = [V3, V3, V3];

const FPS = 24;
const W = 1280;
const H = 720;

// ---- small rotation algebra (three.js Euler XYZ: R = Rx · Ry · Rz) ------------------------------
const mul = (a: M3, b: M3): M3 =>
  [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!)) as M3;
const apply = (m: M3, v: V3): V3 => [0, 1, 2].map((i) => m[i]![0] * v[0] + m[i]![1] * v[1] + m[i]![2] * v[2]) as V3;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const rx = (t: number): M3 => [
  [1, 0, 0],
  [0, Math.cos(t), -Math.sin(t)],
  [0, Math.sin(t), Math.cos(t)],
];
const ry = (t: number): M3 => [
  [Math.cos(t), 0, Math.sin(t)],
  [0, 1, 0],
  [-Math.sin(t), 0, Math.cos(t)],
];
const rz = (t: number): M3 => [
  [Math.cos(t), -Math.sin(t), 0],
  [Math.sin(t), Math.cos(t), 0],
  [0, 0, 1],
];
const euler = (e: V3): M3 => mul(mul(rx(e[0]), ry(e[1])), rz(e[2]));
function toEuler(m: M3): V3 {
  const y = Math.asin(Math.max(-1, Math.min(1, m[0][2])));
  if (Math.abs(m[0][2]) < 0.9999999) return [Math.atan2(-m[1][2], m[2][2]), y, Math.atan2(-m[0][1], m[0][0])];
  return [Math.atan2(m[2][1], m[1][1]), y, 0];
}
/** Rotation by `t` about the unit axis `a` (Rodrigues). */
function axisAngle(a: V3, t: number): M3 {
  const [x, y, z] = a;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = 1 - c;
  return [
    [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
  ];
}

// ---- easing + keyframes -------------------------------------------------------------------------
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const ease = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Scene boundaries in seconds (keep in step with the captions in render.sh). */
const T = { intro: 0, inside: 5, hover: 12, transition: 20, cruise: 27, landing: 34, outro: 42, end: 47 } as const;
const FRAMES = Math.round(T.end * FPS);

// ---- the document: which instance is what -------------------------------------------------------
interface Part {
  id: string;
  component: string;
  position: V3;
  rotation: V3;
}

function partsOf(doc: CadDocument): Part[] {
  const parts: Part[] = [];
  for (const entity of Object.values(doc.entities)) {
    if (entity.kind !== 'instance') continue;
    const record = entity as unknown as { id: string; componentId: string; position?: V3; rotation?: V3 };
    parts.push({
      id: record.id,
      component: record.componentId,
      position: record.position ?? [0, 0, 0],
      rotation: record.rotation ?? [0, 0, 0],
    });
  }
  return parts;
}

function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  const result = execute(doc, name, params);
  if (/rejected|failed/i.test(result.summary)) throw new Error(`${name}: ${result.summary}`);
  return result.document;
}

// ---- the flight: vehicle pose, rotor speed, flap deflection, explode, airflow ---------------------
/** Design-specific heights: v2 defaults, v3 via HALO_FOOT_Z=-95 HALO_HINGE_Z=-3 (render.sh sets them per design). */
const GROUND_Z = Number(process.env['HALO_FOOT_Z'] ?? -32); // the feet touch the ground here (footZ)

interface Pose {
  rotation: M3; // vehicle attitude
  origin: V3; // world position of the vehicle origin
  spinUpper: number; // rad
  spinLower: number;
  flapPitch: number; // flaps on the struts along y (pitch in cruise)
  explode: number; // 0..1
  flow: 'none' | 'hover' | 'cruise';
  flowLevel: number; // 0..1 particle density / speed
}

/** Rotor angle: integral of a speed profile (rad/frame), so spin-ups look continuous. */
function rotorSpeed(t: number): number {
  if (t < T.inside) return 0.05;
  if (t < T.hover) return 0.05 * (1 - ease((t - T.inside) / 1));
  if (t < T.landing + 6) return 0.42 * ease((t - T.hover) / 1.5);
  return 0.42 * (1 - ease((t - T.landing - 6) / 1.5)) + 0.03;
}
const spinTable: number[] = [];
{
  let angle = 0;
  for (let f = 0; f <= FRAMES; f += 1) {
    spinTable.push(angle);
    angle += rotorSpeed(f / FPS);
  }
}

const CRUISE_ALT = 900;
const CRUISE_V = 900; // mm per second on screen (a slowed-down view of 25 m/s)

function pose(f: number): Pose {
  const t = f / FPS;
  const spin = spinTable[f] ?? 0;
  let pitch = 0;
  let origin: V3 = [0, 0, 0];
  let flapPitch = 0;
  let flow: Pose['flow'] = 'none';
  let flowLevel = 0;
  const explode = t >= T.inside && t < T.hover ? ease((t - T.inside - 0.6) / 2) * (1 - ease((t - T.hover + 1.6) / 1.4)) : 0;

  // x travelled in cruise = integral of the speed profile (accelerate in transition, decelerate in landing)
  const speedAt = (s: number): number =>
    s < T.transition
      ? 0
      : s < T.cruise
        ? CRUISE_V * ease((s - T.transition) / (T.cruise - T.transition))
        : s < T.landing
          ? CRUISE_V
          : CRUISE_V * (1 - ease((s - T.landing) / 5));
  let x = 0;
  for (let s = T.transition; s < t; s += 1 / FPS) x += speedAt(s) / FPS;

  if (t >= T.hover && t < T.transition) {
    const climb = ease((t - T.hover - 1.5) / 5);
    origin = [0, 0, climb * CRUISE_ALT];
    flow = 'hover';
    flowLevel = ease((t - T.hover) / 1.5);
  } else if (t >= T.transition && t < T.cruise) {
    const u = (t - T.transition) / (T.cruise - T.transition);
    pitch = (Math.PI / 2) * ease(u * 1.4);
    flapPitch = 0.35 * Math.sin(Math.PI * clamp01(u * 1.4));
    origin = [x, 0, CRUISE_ALT];
    flow = u < 0.5 ? 'hover' : 'cruise';
    flowLevel = 1;
  } else if (t >= T.cruise && t < T.landing) {
    origin = [x, 0, CRUISE_ALT + 40 * Math.sin((t - T.cruise) * 1.3)];
    pitch = Math.PI / 2 - 0.03 * Math.sin((t - T.cruise) * 1.3);
    flapPitch = 0.06 * Math.sin((t - T.cruise) * 1.3);
    flow = 'cruise';
    flowLevel = 1;
  } else if (t >= T.landing && t < T.outro) {
    const u = (t - T.landing) / (T.outro - T.landing);
    pitch = (Math.PI / 2) * (1 - ease(u * 1.6));
    flapPitch = -0.35 * Math.sin(Math.PI * clamp01(u * 1.6));
    origin = [x, 0, CRUISE_ALT * (1 - ease((u - 0.45) / 0.5))];
    flow = u < 0.35 ? 'cruise' : 'hover';
    flowLevel = 1 - ease((u - 0.85) / 0.15);
  } else if (t >= T.outro) {
    origin = [x, 0, 0];
  }
  // pitch nose (+Z) towards +X: rotation about +Y
  return { rotation: ry(pitch), origin, spinUpper: spin, spinLower: -spin * 0.86, flapPitch, explode, flow, flowLevel };
}

/** Vertical explode offsets per component (inside scene): the pod shell slides off, rotors rise. */
const EXPLODE: Record<string, number> = { 'c-rotor-upper': 250, 'c-rotor-lower': 125, 'c-dome': 60, 'c-cam': 30 };

const HINGE: V3 = [0, 0, Number(process.env['HALO_HINGE_Z'] ?? -9)]; // flap hinge line height (strutTop - strutChord - 1)

function partTransform(part: Part, p: Pose): { position: V3; rotation: V3 } {
  let local: M3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let offset: V3 = [0, 0, 0];
  if (part.component === 'c-rotor-upper') local = rz(p.spinUpper);
  if (part.component === 'c-rotor-lower') local = rz(p.spinLower);
  if (part.component === 'c-flap') {
    const along = apply(euler(part.rotation), [1, 0, 0]); // hinge axis = the flap's radial direction
    const delta = p.flapPitch * along[1]; // pitch mixing: each flap deflects with the sine of its strut angle
    local = axisAngle(along, delta);
    offset = sub(HINGE, apply(local, HINGE));
  }
  offset = add(offset, [0, 0, (EXPLODE[part.component] ?? 0) * p.explode]);
  const rotation = mul(p.rotation, mul(local, euler(part.rotation)));
  const position = add(apply(p.rotation, add(apply(local, part.position), offset)), p.origin);
  return { position, rotation: toEuler(rotation) };
}

// ---- airflow particles (vehicle frame), deterministic ---------------------------------------------
const PARTICLES = 70;
const seed = (i: number, k: number): number => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function particles(f: number, p: Pose): V3[] {
  if (p.flow === 'none' || p.flowLevel <= 0.01) return [];
  const t = f / FPS;
  const out: V3[] = [];
  const count = Math.round(PARTICLES * p.flowLevel);
  for (let i = 0; i < count; i += 1) {
    const phase = (seed(i, 1) + t * 0.55) % 1; // 0 = far upstream, 1 = far downstream
    const angle = seed(i, 2) * Math.PI * 2;
    const radius = 50 + seed(i, 3) * 130;
    // contraction into the duct, constant through it, slight expansion behind (vehicle frame, flow along -Z)
    const z = lerp(520, -360, phase);
    const r = z > 180 ? radius * (1 + (z - 180) / 260) : z < 10 ? radius * (1 + (10 - z) / 900) : radius;
    const swirl = z < 10 ? 0 : 0.002 * (180 - z);
    out.push(add(apply(p.rotation, [r * Math.cos(angle + swirl), r * Math.sin(angle + swirl), z]), p.origin));
  }
  return out;
}

// ---- camera ---------------------------------------------------------------------------------------
interface Camera {
  direction: V3;
  target: V3;
  zoom: number;
}

function camera(f: number, p: Pose): Camera {
  const t = f / FPS;
  const centre = add(p.origin, apply(p.rotation, [0, 0, 120]));
  if (t < T.inside) {
    const a = -Math.PI / 4 + t * 0.35;
    return { direction: [Math.cos(a), Math.sin(a), 0.55], target: [0, 0, 130], zoom: 30 };
  }
  if (t < T.hover) {
    const a = -Math.PI / 4 + T.inside * 0.35 + (t - T.inside) * 0.12;
    return { direction: [Math.cos(a), Math.sin(a), 0.62], target: [0, 0, 160 + 70 * p.explode], zoom: lerp(30, 27, p.explode) };
  }
  const settle = ease((t - T.hover) / 1.5);
  const a0 = -Math.PI / 4 + T.inside * 0.35 + (T.hover - T.inside) * 0.12;
  const hoverDir: V3 = [Math.cos(a0), Math.sin(a0), 0.62];
  const flightDir: V3 = [0.35, -1, 0.3];
  const blend = ease((t - T.transition + 1) / 3) * (1 - ease((t - T.outro + 1) / 3));
  const direction = lerp3(lerp3(hoverDir, [0.6, -1, 0.35], settle), flightDir, blend);
  return { direction, target: centre, zoom: lerp(26, 16, blend) };
}

// ---- main -----------------------------------------------------------------------------------------
async function main(): Promise<void> {
  const [docPath, outDir, first, last] = process.argv.slice(2);
  if (docPath === undefined || outDir === undefined) throw new Error('usage: renderFrames <doc> <outDir> [first] [last]');
  await installGeometryKernel();
  fs.mkdirSync(outDir, { recursive: true });
  let base = readDocumentFile(docPath);
  // ground: a 1 m checker strip along the flight path (constant scene bounds = constant framing)
  for (let i = -2; i < 14; i += 1) {
    for (let j = -3; j < 3; j += 1) {
      base = run(base, 'add_box', {
        size: [1000, 1000, 6],
        position: [i * 1000 + 500, j * 1000 + 500, GROUND_Z - 3],
        color: (i + j) % 2 === 0 ? '#c3ccd6' : '#d3dbe3',
      });
    }
  }
  const parts = partsOf(base);
  const from = Number(first ?? 0);
  const to = Math.min(Number(last ?? FRAMES - 1), FRAMES - 1);
  for (let f = from; f <= to; f += 1) {
    const p = pose(f);
    let doc = base;
    for (const part of parts) {
      const target = partTransform(part, p);
      doc = run(doc, 'rotate_entity', { id: part.id, delta: sub(target.rotation, part.rotation) });
      doc = run(doc, 'move_entities', { ids: [part.id], delta: sub(target.position, part.position) });
    }
    for (const point of particles(f, p)) doc = run(doc, 'add_sphere', { radius: 4, position: point, color: '#1f8fff' });
    const cam = camera(f, p);
    const t = f / FPS;
    const cutaway = t >= T.inside + 0.3 && t < T.hover - 0.3;
    const azimuth = Math.atan2(cam.direction[1], cam.direction[0]);
    const cutIds = parts.filter((q) => ['c-ring', 'c-pod', 'c-dome'].includes(q.component)).map((q) => q.id);
    const result = execute(doc, 'render_view', {
      direction: cam.direction,
      target: cam.target,
      zoom: cam.zoom,
      width: W,
      height: H,
      hide2D: true,
      showAxes: false,
      showGrid: false,
      ...(cutaway
        ? {
            cut: {
              planes: [-1, 1].map((side) => ({
                normal: [Math.cos(azimuth + (side * Math.PI) / 4), Math.sin(azimuth + (side * Math.PI) / 4), 0],
                offset: 0,
              })),
              mode: 'intersection',
              entityIds: cutIds,
            },
          }
        : {}),
    });
    const svg = (result.data as { svg?: string } | undefined)?.svg ?? '';
    const match = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(svg);
    if (match?.[1] === undefined) throw new Error(`frame ${f}: no raster image in render_view output (${result.summary})`);
    fs.writeFileSync(path.join(outDir, `f${String(f).padStart(4, '0')}.png`), Buffer.from(match[1], 'base64'));
    if (f % 24 === 0) process.stderr.write(`frame ${f}/${FRAMES}\n`);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
