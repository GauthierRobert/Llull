import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { documentAtPose, eulerDegOf, matFromQuaternion } from '@core/geometry/bodyPose';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { sliderCrank } from './sliderCrankFixture';

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
