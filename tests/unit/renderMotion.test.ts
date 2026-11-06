import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { documentAtPose, eulerDegOf, matFromQuaternion } from '@core/geometry/bodyPose';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { sliderCrank } from './sliderCrankFixture';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

const LENGTH_MM = 1000;
const START_DEG = 10;

/** Point-mass-like pendulum (L = 1 m) released at rest 10 deg from the vertical, swinging about +Y. */
function pendulum(): CadDocument {
  const a = (START_DEG * Math.PI) / 180;
  return execute(createEmptyDocument(), 'build_project', {
    actions: [
      { command: 'set_units', params: { units: 'mm' } },
      { command: 'add_sphere', params: { radius: 10, position: [LENGTH_MM * Math.sin(a), 0, -LENGTH_MM * Math.cos(a)] }, as: 'bob' },
      { command: 'add_rigid_body', params: { id: 'pend', entityIds: ['$bob'] } },
      { command: 'add_body_joint', params: { id: 'pivot', kind: 'revolute', child: 'pend', anchor: [0, 0, 0], axis: [0, 1, 0] } },
    ],
  }).document;
}

interface Frames {
  svg: string;
  frames: { time: number; bodies: Record<string, { position: number[]; rotationDeg: number[] }> }[];
  trace?: Record<string, number[][]>;
}

describe('render_motion', () => {
  it('draws the pendulum bob on the other side at half a period, with one labelled frame per time', () => {
    const doc = pendulum();
    const theta = (START_DEG * Math.PI) / 180;
    const period = 2 * Math.PI * Math.sqrt(LENGTH_MM / 1000 / 9.81) * (1 + theta ** 2 / 16);
    const before = JSON.stringify(doc);
    const result = execute(doc, 'render_motion', {
      times: [0, period / 2],
      sampleRate: 400,
      view: 'front',
      trace: 'pend',
      width: 200,
      height: 160,
    });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const data = result.data as Frames;
    expect(data.frames).toHaveLength(2);
    const [start, half] = data.frames;
    const bob = (frame: typeof start): { position: number[]; rotationDeg: number[] } =>
      frame?.bodies['pend'] ?? { position: [], rotationDeg: [] };
    expect(bob(start).position[0]).toBeCloseTo(LENGTH_MM * Math.sin(theta), 3);
    expect(bob(half).position[0] ?? 0).toBeCloseTo(-LENGTH_MM * Math.sin(theta), -1);
    expect(bob(half).position[2] ?? 0).toBeCloseTo(-LENGTH_MM * Math.cos(theta), -1);
    expect(Math.abs((bob(half).rotationDeg[1] ?? 0) - 2 * START_DEG)).toBeLessThan(1.5);
    expect(data.svg.match(/t = [\d.]+ s/g)).toHaveLength(2);
    expect(data.svg).toContain('t = 0 s');
    expect(data.svg).not.toMatch(/entit(y|ies)<\/text>/);
    expect(data.svg).toContain('<polyline');
    expect(data.svg).toContain('trace: pend');
    expect(data.trace?.['pend']?.length ?? 0).toBeGreaterThan(100);
    expect(result.summary).toMatch(/^render_motion: 2 frame\(s\)/);
  });

  it('defaults to 4 evenly spaced frames including start and end, laid out on a grid', () => {
    const data = execute(pendulum(), 'render_motion', { duration: 1, width: 100, height: 80 }).data as Frames & {
      width: number;
      height: number;
    };
    expect(data.frames.map((f) => f.time)).toEqual([0, expect.closeTo(0.333, 1), expect.closeTo(0.667, 1), expect.closeTo(1, 2)]);
    expect(data.svg.match(/t = [\d.]+ s/g)).toHaveLength(4);
    expect(data.width).toBe(400);
    const grid = execute(pendulum(), 'render_motion', { frames: 6, duration: 1, width: 100, height: 80 }).data as typeof data;
    expect(grid.frames).toHaveLength(6);
    expect(grid.width).toBe(400);
    expect(grid.height).toBe(2 * (80 + 22));
  });

  it('moves a slider-crank: the crank turns and the piston travels along X', () => {
    const { doc, bodies } = sliderCrank({ crankRpm: 600 });
    const motor = execute(doc, 'add_motor', { joint: 'crank_j', kind: 'speed', rpm: 600, maxTorque: 1e5 }).document;
    const data = execute(motor, 'render_motion', { frames: 3, duration: 0.05, trace: bodies.piston, view: 'top', width: 200, height: 160 })
      .data as Frames;
    const at = (k: number, id: string): { position: number[]; rotationDeg: number[] } =>
      data.frames[k]?.bodies[id] ?? { position: [], rotationDeg: [] };
    expect(Math.abs(at(2, bodies.crank).rotationDeg[2] ?? 0)).toBeGreaterThan(90);
    expect(Math.abs((at(2, bodies.piston).position[0] ?? 0) - (at(0, bodies.piston).position[0] ?? 0))).toBeGreaterThan(5);
    expect(Math.abs((at(2, bodies.piston).position[1] ?? 0) - (at(0, bodies.piston).position[1] ?? 0))).toBeLessThan(1e-2);
  });

  it('fails as a no-op: no bodies, unknown trace body, late time, bad direction, no engine', () => {
    const empty = createEmptyDocument();
    expect(execute(empty, 'render_motion', {}).summary).toMatch(/no rigid bodies.*no-op/);
    const doc = pendulum();
    for (const [params, message] of [
      [{ trace: 'ghost' }, /unknown rigid body id.*ghost/],
      [{ times: [0, 9], duration: 2 }, /exceed the duration/],
      [{ direction: [0, 0, 0] }, /direction/],
      [{ trace: ['pend', 'pend', 'pend', 'pend', 'pend'] }, /at most 4/],
    ] as const) {
      const result = execute(doc, 'render_motion', params);
      expect(result.summary).toMatch(message);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.data).toBeUndefined();
    }
    setPhysicsEngine(null);
    try {
      expect(execute(doc, 'render_motion', { frames: 2 }).summary).toMatch(/simulation did not run.*no physics engine/);
    } finally {
      setPhysicsEngine(null);
    }
  });
});

describe('bodyPose', () => {
  it('rotates member entities about the start centre of mass and translates them with it', () => {
    const doc = pendulum();
    const bobId = doc.dynamics?.bodies['pend']?.entityIds[0] ?? '';
    const start = doc.entities[bobId]?.position ?? [0, 0, 0];
    const quarter = [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as const;
    const moved = documentAtPose(doc, { pend: { start: [start[0], start[1], start[2]], position: [5, 0, 0], orientation: quarter } });
    expect(doc.entities[bobId]?.position).toEqual(start);
    expect(moved.entities[bobId]?.position[0]).toBeCloseTo(5, 9);
    expect(moved.entities[bobId]?.rotation[2]).toBeCloseTo(Math.PI / 2, 9);
    expect(eulerDegOf(quarter)).toEqual([0, 0, 90]);
    expect(matFromQuaternion([0, 0, 0, 0])).toHaveLength(9);
    expect(documentAtPose(doc, { ghost: { start: [0, 0, 0], position: [1, 1, 1], orientation: [1, 0, 0, 0] } }).entities).toEqual(
      doc.entities,
    );
  });
});

describe('render_motion material class shading (VIS-M8h)', () => {
  beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
  it('draws the highlight of a class default on every frame, like render_view', () => {
    const doc = pendulum();
    const params = { frames: 2, duration: 0.2, view: 'front', width: 120, height: 100 };
    const ctx = (table: boolean): ExecutionContext => ({
      ...defaultContext(),
      properties: () => (table ? { defaultMaterialClass: 'concrete' } : {}),
    });
    const first = execute(doc, 'render_motion', params, ctx(false));
    expect(first.summary).toMatch(/^render_motion: 2/);
    const plain = (first.data as Frames).svg;
    const shaded = (execute(doc, 'render_motion', params, ctx(true)).data as Frames).svg;
    expect(shaded).not.toBe(plain);
    expect((execute(doc, 'render_motion', params, ctx(true)).data as Frames).svg).toBe(shaded);
  });
});

describe('render_motion exact instants (VC-MOV-03)', () => {
  beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
  const validation = resolve(process.cwd(), 'docs/physics/22-motion-video/validation');
  const plan = JSON.parse(readFileSync(resolve(validation, 'plans/mov_render_motion_instants.plan.json'), 'utf8')) as {
    command: string;
    params: Record<string, unknown>;
  }[];
  const render = plan[plan.length - 1] ?? { command: '', params: {} };
  const expected = (
    JSON.parse(readFileSync(resolve(validation, 'expected_results.json'), 'utf8')) as {
      cases: { id: string; value: number[]; baseline: number[] }[];
    }
  ).cases.find((c) => c.id === 'VC-MOV-03');
  const mechanism = (): CadDocument =>
    execute(createEmptyDocument(), 'build_project', {
      actions: plan.slice(0, -1).map((s) => ({ command: s.command, params: s.params, ...('as' in s ? { as: s.as } : {}) })),
    }).document;

  it('reports the requested instants, not the nearest recorded sample', () => {
    expect(render.command).toBe('render_motion');
    const data = execute(mechanism(), 'render_motion', render.params).data as Frames;
    expect(expected?.baseline).toEqual([0.01218, 0.03132]);
    data.frames.forEach((frame, k) => expect(Math.abs(frame.time - (expected?.value[k] ?? NaN))).toBeLessThan(1e-12));
  });

  it('places the piston on the closed-form slider-crank position between recorded samples', () => {
    const crank = 50;
    const rod = 200;
    const pistonX = (t: number): number => crank * Math.cos(100 * t) + Math.sqrt(rod ** 2 - (crank * Math.sin(100 * t)) ** 2);
    const times = [0.0114, 0.0314];
    const coarse = execute(mechanism(), 'render_motion', { ...render.params, sampleRate: 600 }).data as Frames;
    coarse.frames.forEach((frame, k) => {
      const t = times[k] ?? 0;
      expect(Math.abs((frame.bodies['piston']?.position[0] ?? 0) - pistonX(t))).toBeLessThan(0.3);
    });
    expect(Math.abs(pistonX(0.0114) - pistonX(0.01218))).toBeGreaterThan(1);
    const fine = execute(mechanism(), 'render_motion', { ...render.params, sampleRate: 50000 }).data as Frames;
    fine.frames.forEach((frame, k) => {
      expect(Math.abs((frame.bodies['piston']?.position[0] ?? 0) - pistonX(times[k] ?? 0))).toBeLessThan(0.01);
    });
  });

  it('is pure and keeps the dot of a traced body on the interpolated position', () => {
    const doc = mechanism();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'render_motion', { ...render.params, trace: 'piston' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.affected).toEqual([]);
    expect((result.data as Frames).svg).toContain('<circle');
  });

  it('puts the trace dot on the interpolated position, not on the nearest recorded sample', () => {
    const dotX = (time: number): number => {
      const svg = (
        execute(mechanism(), 'render_motion', { ...render.params, times: [time], sampleRate: 100, trace: 'piston' }).data as Frames
      ).svg;
      return Number(/<circle cx="([-0-9.]+)" cy="[-0-9.]+" r="4.5"/.exec(svg)?.[1] ?? NaN);
    };
    expect(Math.abs(dotX(0.0114) - dotX(0.01))).toBeGreaterThan(0.5);
  });

  it('refuses a time past the duration as before', () => {
    const result = execute(mechanism(), 'render_motion', { ...render.params, times: [0.0114, 0.5] });
    expect(result.summary).toMatch(/exceed the duration/);
    expect(result.data).toBeUndefined();
  });
});
