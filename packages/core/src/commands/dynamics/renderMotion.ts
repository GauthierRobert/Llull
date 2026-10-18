/** Looking at a simulated pose without a screen (render_motion): runs simulate_motion and draws the mechanism at chosen times. */

import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { failer, report } from '../noop';
import { escapeXml } from '../../lib/escapeXml';
import { clamp } from '../../lib/clamp';
import type { Vec3 } from '../../model/vectors';
import { documentAtPose, eulerDegOf, type BodyPoseAt } from '../../dynamics/bodyPose';
import type { SimulationData } from '../../dynamics/simulationReport';
import { boundsOfPoints, mergeBounds, type Bounds } from '../../geometry/bounds';
import { computeSceneSnapshot } from '../inspect/scene';
import type { ViewName } from '../render/camera';
import { makeProjector } from '../render/camera';
import { renderDocument } from '../render/scene';
import { resolveRenderOptions } from '../render/options';
import { extractSvgInner, r2, svgDocument } from '../render/svg';
import { dynamicsOf } from './bodies';
import { simulateMotion } from './simulate';

const MAX_FRAMES = 12;
const DEFAULT_FRAMES = 4;
const MAX_COLUMNS = 4;
const TRACE_COLORS = ['#ffd24a', '#4ad8ff', '#ff6fa8', '#8dff6f'] as const;
const LABEL_HEIGHT = 22;
const CELL_CLIP = 'motion-cell';

const formatTime = (time: number): string => `t = ${+time.toFixed(3)} s`;
const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const roundVec = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

type PosesData = NonNullable<SimulationData['poses']>;

/** Index of the sample closest to `time`. */
function nearestSample(times: readonly number[], time: number): number {
  let best = 0;
  for (let i = 1; i < times.length; i++) if (Math.abs((times[i] ?? 0) - time) < Math.abs((times[best] ?? 0) - time)) best = i;
  return best;
}

/** `count` times evenly spaced from 0 to `duration`, both ends included (one frame = the start). */
const evenTimes = (count: number, duration: number): number[] =>
  Array.from({ length: count }, (_, i) => (count === 1 ? 0 : (duration * i) / (count - 1)));

/** Every body's pose at sample `index`. */
function posesAt(poses: PosesData, index: number): Record<string, BodyPoseAt> {
  const result: Record<string, BodyPoseAt> = {};
  for (const [id, track] of Object.entries(poses.bodies)) {
    const start = track.position[0];
    const position = track.position[index];
    const orientation = track.orientation[index];
    if (start !== undefined && position !== undefined && orientation !== undefined) result[id] = { start, position, orientation };
  }
  return result;
}

/**
 * @affects nothing — read-only; returns data { svg, width, height, view, duration, samples, frames[{ time, bodies{ id: { position, rotationDeg } } }], trace? }
 * @invariant frames are clipped to their cell (empty grid cells stay blank); the input document is never changed: frames render a copy whose rigid-body member entities are moved to the simulated pose
 * @failure no physics engine, no rigid bodies, simulation refused or failed, times outside 0..duration, unknown trace body id, invalid camera -> no-op with the reason
 */
export const renderMotion = defineCommand({
  name: 'render_motion',
  annotations: { readOnly: true },
  description:
    'SEE a simulated mechanism: runs the physics simulation (same engine and parameters as simulate_motion / plot_simulation) and renders ' +
    'the rigid bodies at chosen instants as a grid of frames, each labelled "t = 0.25 s", so crank rotation, piston travel or a pendulum swing ' +
    'can be checked without a screen. Pick instants with `times` (seconds, at most 12) or `frames` (N evenly spaced instants from 0 to ' +
    'the duration, both included; default 4). Every frame uses the same camera, so motion reads directly. `trace` draws the centre-of-mass ' +
    'path of the named rigid bodies (e.g. the coupler or the end-effector) over all samples, with a dot at the current position. ' +
    'Camera as render_view: `view` or `direction`. Returns data.svg (the grid), data.width/height, and data.frames[{ time, bodies{ bodyId: ' +
    '{ position (centre of mass, document units), rotationDeg (Euler XYZ degrees from the start pose) } } }] to read numbers. Frames show ' +
    "the nearest recorded sample (data.frames[].time is that sample's time). With the CLI, `llull render_motion … --save m.png` rasterizes " +
    'data.svg. Read-only; needs the physics engine like simulate_motion.',
  params: z.object({
    times: z
      .array(z.number().min(0))
      .min(1)
      .max(MAX_FRAMES)
      .optional()
      .describe('Instants to draw, in seconds from the start (1 to 12 values, each within 0..duration). Overrides `frames`.'),
    frames: z
      .number()
      .int()
      .min(1)
      .max(MAX_FRAMES)
      .optional()
      .describe(
        'Number of evenly spaced instants from 0 to the duration, both included (1..12). Default 4. Ignored when `times` is given.',
      ),
    trace: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('Rigid body id (or ids, at most 4) whose centre-of-mass path is drawn across all samples, e.g. the coupler or the piston.'),
    view: z
      .enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'])
      .optional()
      .describe(
        'Camera as render_view: "iso" (default), "top", "bottom", "front", "back", "left", "right". Planar mechanisms read best face-on.',
      ),
    direction: vec3('Custom viewing direction [x, y, z] from the scene toward the camera (Z-up); overrides `view`.').optional(),
    width: z.number().optional().describe('Width of ONE frame in pixels, clamped to [64, 2000]. Default 420.'),
    height: z.number().optional().describe('Height of ONE frame in pixels, clamped to [64, 2000]. Default 320.'),
    duration: z.number().positive().max(600).optional().describe('Simulated seconds. Default: the largest of `times`, else 5.'),
    timestep: z.number().min(1e-5).max(0.01).optional().describe('Integration step in seconds; default as simulate_motion.'),
    sampleRate: z
      .number()
      .positive()
      .optional()
      .describe(
        'Recorded samples per second (the frames and the trace snap to these). Default as simulate_motion; raise it for a smoother trace.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, 'render_motion');
    const dynamics = dynamicsOf(doc);
    if (Object.keys(dynamics.bodies).length === 0) return fail('the document has no rigid bodies (add_rigid_body); nothing to draw');
    const traced = params.trace === undefined ? [] : typeof params.trace === 'string' ? [params.trace] : params.trace;
    const unknown = traced.filter((id) => dynamics.bodies[id] === undefined);
    if (unknown.length > 0) return fail(`unknown rigid body id(s) in trace: ${unknown.join(', ')}`);
    if (traced.length > TRACE_COLORS.length) return fail(`trace names ${traced.length} bodies; at most ${TRACE_COLORS.length}`);
    const resolved = resolveRenderOptions(doc, { direction: params.direction });
    if ('error' in resolved) return fail(resolved.error);
    const duration = params.duration ?? (params.times !== undefined ? Math.max(1e-3, ...params.times) : 5);
    const late = (params.times ?? []).filter((time) => time > duration + 1e-9);
    if (late.length > 0) return fail(`times ${late.join(', ')} exceed the duration ${duration} s`);
    const run = simulateMotion.run(
      doc,
      {
        duration,
        detail: 'poses',
        ...(params.timestep !== undefined ? { timestep: params.timestep } : {}),
        ...(params.sampleRate !== undefined ? { sampleRate: params.sampleRate } : {}),
      },
      ctx,
    );
    const sim = run.data as SimulationData | undefined;
    if (sim === undefined) return fail(run.summary.replace(/^simulate_motion:\s*/, 'the simulation did not run — '));
    const poses = sim.poses;
    if (poses === undefined || poses.times.length === 0) return fail('the simulation recorded no poses');

    const wanted = params.times ?? evenTimes(params.frames ?? DEFAULT_FRAMES, duration);
    const indices = wanted.map((time) => nearestSample(poses.times, time));
    const frameDocs = indices.map((index) => documentAtPose(doc, posesAt(poses, index)));
    const paths = traced.map((id) => (poses.bodies[id]?.position ?? []) as Vec3[]);
    const pathBounds = paths.filter((path) => path.length > 0).map((path) => boundsOfPoints(path));
    const sceneBounds = frameDocs.flatMap((frameDoc) => computeSceneSnapshot(frameDoc).bounds ?? []);
    const all: Bounds[] = [...sceneBounds, ...pathBounds];
    const frame = all.length === 0 ? null : all.reduce(mergeBounds);

    const width = clamp(Math.round(params.width ?? 420), 64, 2000);
    const height = clamp(Math.round(params.height ?? 320), 64, 2000);
    const view: ViewName = resolved.options.direction ? 'custom' : (params.view ?? 'iso');
    const columns = Math.min(wanted.length, MAX_COLUMNS);
    const rows = Math.ceil(wanted.length / columns);
    const cellHeight = height + LABEL_HEIGHT;
    const layers: string[] = [];
    const frames = indices.map((index, k) => {
      const frameDoc = frameDocs[k] ?? doc;
      const data = renderDocument(frameDoc, view, width, height, { ...resolved.options, frame, background: null, caption: false });
      const x = (k % columns) * width;
      const y = Math.floor(k / columns) * cellHeight;
      const time = poses.times[index] ?? 0;
      const project = makeProjector(data.camera, data.orthoHalf, width, height);
      const overlay = paths.flatMap((path, p) => {
        const color = TRACE_COLORS[p % TRACE_COLORS.length] ?? '#ffd24a';
        const screen = path.map((point) => project(point));
        const here = screen[index];
        const line =
          screen.length < 2
            ? ''
            : `<polyline points="${screen.map((s) => `${r2(s[0])},${r2(s[1])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.9"/>`;
        const dot =
          here === undefined
            ? ''
            : `<circle cx="${r2(here[0])}" cy="${r2(here[1])}" r="4.5" fill="${color}" stroke="#101020" stroke-width="1.5"/>`;
        return [line, dot];
      });
      layers.push(
        `  <g transform="translate(${x}, ${y + LABEL_HEIGHT})" clip-path="url(#${CELL_CLIP})"><rect width="${width}" height="${height}" fill="none" stroke="#3a3a5a"/>${extractSvgInner(data.svg)}${overlay.join('')}</g>`,
        `  <text x="${x + 8}" y="${y + 16}" font-family="monospace" font-size="14" fill="#e8e8f4">${escapeXml(formatTime(time))}</text>`,
      );
      return {
        time: round(time),
        bodies: Object.fromEntries(
          Object.entries(posesAt(poses, index)).map(([id, pose]) => [
            id,
            { position: roundVec(pose.position), rotationDeg: eulerDegOf(pose.orientation) },
          ]),
        ),
      };
    });
    const legend = traced.map(
      (id, p) =>
        `  <text x="${width * columns - 8}" y="${16 + 16 * p}" text-anchor="end" font-family="monospace" font-size="12" fill="${TRACE_COLORS[p % TRACE_COLORS.length] ?? '#ffd24a'}">trace: ${escapeXml(id)}</text>`,
    );
    const totalWidth = width * columns;
    const totalHeight = cellHeight * rows;
    // each frame is clipped to its own cell: the scene's ground grid extends past the frame and would otherwise draw into the cells below
    const clip = `  <defs><clipPath id="${CELL_CLIP}"><rect width="${width}" height="${height}"/></clipPath></defs>`;
    const svg = svgDocument(totalWidth, totalHeight, [clip, ...layers, ...legend]);
    const times = frames.map((f) => formatTime(f.time).slice(4));
    return report(
      doc,
      `render_motion: ${frames.length} frame(s) of ${Object.keys(frames[0]?.bodies ?? {}).length} body/bodies at ${times.join(', ')} (${view} view, ${sim.samples} samples over ${duration} s)` +
        `${traced.length > 0 ? `; trace of ${traced.join(', ')}` : ''}. Save the image with --save m.png (rasterizes data.svg).`,
      {
        svg,
        width: totalWidth,
        height: totalHeight,
        view,
        duration,
        samples: sim.samples,
        frames,
        ...(traced.length > 0 ? { trace: Object.fromEntries(traced.map((id, p) => [id, (paths[p] ?? []).map(roundVec)])) } : {}),
      },
    );
  },
});
