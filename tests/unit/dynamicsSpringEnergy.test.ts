/** Joint springs, the energy balance, directional unsteady warnings and render_motion grid clipping. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { speedTrend, trendWarning } from '@core/dynamics/speedTrend';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { sliderCrank } from './sliderCrankFixture';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

const build = (actions: readonly Record<string, unknown>[]): CadDocument =>
  execute(createEmptyDocument(), 'build_project', { actions }).document;

const simulate = (doc: CadDocument, params: Record<string, unknown>): SimulationData => {
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as SimulationData;
};

/** Mean spacing of the upward crossings of `level` (linear interpolation between samples). */
function period(times: readonly number[], values: readonly number[], level = (Math.max(...values) + Math.min(...values)) / 2): number {
  const up: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const [a, b] = [(values[i - 1] ?? 0) - level, (values[i] ?? 0) - level];
    if (a < 0 && b >= 0) up.push((times[i - 1] ?? 0) + ((times[i] ?? 0) - (times[i - 1] ?? 0)) * (-a / (b - a)));
  }
  expect(up.length).toBeGreaterThan(3);
  return ((up[up.length - 1] ?? 0) - (up[0] ?? 0)) / (up.length - 1);
}

const sphereBob = (extra: Record<string, unknown>): Record<string, unknown>[] => [
  { command: 'set_units', params: { units: 'mm' } },
  { command: 'add_sphere', params: { radius: 10, position: [0, 0, -1000] }, as: 'bob' },
  { command: 'add_rigid_body', params: { id: 'pend', entityIds: ['$bob'], massKg: 1 } },
  { command: 'add_body_joint', params: { id: 'pivot', kind: 'revolute', child: 'pend', anchor: [0, 0, 0], axis: [0, 1, 0], ...extra } },
];

describe('joint springs (add_body_joint stiffness / springReference)', () => {
  it('a mass on a prismatic spring oscillates with T = 2π·sqrt(m/k) within 0.5 %', () => {
    const [mass, k, reference] = [2, 800, -0.05];
    const doc = build([
      { command: 'add_box', params: { size: [50, 50, 50], position: [0, 0, 0] }, as: 'b' },
      { command: 'add_rigid_body', params: { id: 'm', entityIds: ['$b'], massKg: mass } },
      {
        command: 'add_body_joint',
        params: {
          id: 'slide',
          kind: 'prismatic',
          child: 'm',
          anchor: [0, 0, 0],
          axis: [1, 0, 0],
          stiffness: k,
          springReference: reference,
        },
      },
    ]);
    expect(doc.dynamics?.joints['slide']).toMatchObject({ stiffness: k, springReference: reference });
    const data = simulate(doc, { duration: 2, sampleRate: 2000, detail: 'series' });
    const expected = 2 * Math.PI * Math.sqrt(mass / k);
    const measured = period(data.series?.times ?? [], data.series?.jointPosition['slide'] ?? [], reference);
    expect(Math.abs(measured - expected) / expected).toBeLessThan(0.005);
    // spring energy: starts at rest, 1/2 k x^2 with x = 0.05 m is converted to kinetic energy and back
    expect(data.energy?.maxDeviationFraction ?? 1).toBeLessThan(0.005);
    expect(Math.max(...(data.series?.energy?.kinetic ?? [0]))).toBeCloseTo(0.5 * k * 0.05 ** 2, 2);
  });

  it('a torsional spring adds to gravity: T = 2π·sqrt(I / (kθ + m·g·L))', () => {
    const kTheta = 12;
    const inertia = 1 * 1 ** 2 + 0.4 * 1 * 0.01 ** 2;
    const expected = 2 * Math.PI * Math.sqrt(inertia / (kTheta + 1 * 9.81 * 1));
    const a = (3 * Math.PI) / 180;
    const doc = build(tilted(a, kTheta));
    const data = simulate(doc, { duration: 8, sampleRate: 1000, detail: 'series' });
    const measured = period(data.series?.times ?? [], data.series?.jointPosition['pivot'] ?? []);
    expect(Math.abs(measured - expected) / expected).toBeLessThan(0.005);
  });

  it('a spring-only torsional oscillator (no gravity) swings at T = 2π·sqrt(I / kθ)', () => {
    const doc = build([
      { command: 'set_gravity', params: { gravity: [0, 0, 0] } },
      { command: 'add_cylinder', params: { radius: 100, height: 20, axis: [0, 1, 0], position: [0, 0, 0] }, as: 'd' },
      { command: 'add_rigid_body', params: { id: 'disc', entityIds: ['$d'], massKg: 4 } },
      {
        command: 'add_body_joint',
        params: { id: 'j', kind: 'revolute', child: 'disc', anchor: [0, 0, 0], axis: [0, 1, 0], stiffness: 3, springReference: -0.2 },
      },
    ]);
    const inertia = 0.5 * 4 * 0.1 ** 2;
    const expected = 2 * Math.PI * Math.sqrt(inertia / 3);
    const data = simulate(doc, { duration: 3, sampleRate: 2000, detail: 'series' });
    expect(Math.abs(period(data.series?.times ?? [], data.series?.jointPosition['j'] ?? [], -0.2) - expected) / expected).toBeLessThan(
      0.005,
    );
  });

  it('refuses a spring where it cannot work, and never mutates the document', () => {
    const doc = build(sphereBob({}).slice(0, 3));
    const before = JSON.stringify(doc);
    const base = { id: 'x', child: 'pend', anchor: [0, 0, 0], axis: [0, 1, 0] };
    for (const [params, why] of [
      [{ ...base, kind: 'spherical', stiffness: 1 }, /spherical joint has no spring/],
      [{ ...base, kind: 'revolute', springReference: 0.3 }, /springReference needs a stiffness/],
    ] as const) {
      const result = execute(doc, 'add_body_joint', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
      expect(result.summary).toMatch(why);
    }
    expect(execute(doc, 'add_body_joint', { ...base, kind: 'revolute', stiffness: -1 }).affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('describes the spring in the summary and a joint without stiffness stores none', () => {
    const doc = build(sphereBob({}).slice(0, 3));
    const spring = execute(doc, 'add_body_joint', {
      id: 's',
      kind: 'revolute',
      child: 'pend',
      anchor: [0, 0, 0],
      axis: [0, 1, 0],
      stiffness: 5,
    });
    expect(spring.summary).toMatch(/spring 5 N·m\/rad relaxed at 0 rad/);
    const plain = execute(doc, 'add_body_joint', { id: 'p', kind: 'revolute', child: 'pend', anchor: [0, 0, 0], axis: [0, 1, 0] });
    expect(plain.document.dynamics?.joints['p']).not.toHaveProperty('stiffness');
  });
});

describe('spring data on load and on loop joints', () => {
  it('validates stiffness / springReference on load', () => {
    const { doc } = sliderCrank();
    const dynamics = JSON.parse(JSON.stringify(doc.dynamics)) as Record<string, unknown>;
    const joints = dynamics['joints'] as Record<string, Record<string, unknown>>;
    const problems = (joint: string, patch: Record<string, unknown>): string[] =>
      dynamicsProblems({ ...dynamics, joints: { ...joints, [joint]: { ...joints[joint], ...patch } } });
    expect(problems('crank_j', { stiffness: 2, springReference: 0.1 })).toEqual([]);
    expect(problems('crank_j', { stiffness: -2 })[0]).toMatch(/stiffness must be >= 0/);
    expect(problems('crank_j', { springReference: 'x' })[0]).toMatch(/springReference finite/);
    expect(problems('wrist_j', { stiffness: 2 })[0]).toMatch(/no spring/);
  });

  it('simulate_motion refuses a spring on a joint that closes a loop', () => {
    const { doc } = sliderCrank();
    const wrist = doc.dynamics?.joints['wrist_j'];
    if (doc.dynamics === undefined || wrist === undefined) throw new Error('fixture');
    const springy = { ...doc, dynamics: { ...doc.dynamics, joints: { ...doc.dynamics.joints, wrist_j: { ...wrist, stiffness: 5 } } } };
    const result = execute(springy, 'simulate_motion', { duration: 0.01 });
    expect(result.data).toBeUndefined();
    expect(result.summary).toMatch(/joint 'wrist_j' has a spring but closes a loop/);
  });
});

/** The pendulum bob displaced by `angle` about +Y (small), with a torsional spring relaxed at the vertical. */
function tilted(angle: number, stiffness: number): Record<string, unknown>[] {
  return [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_sphere', params: { radius: 10, position: [1000 * Math.sin(angle), 0, -1000 * Math.cos(angle)] }, as: 'bob' },
    { command: 'add_rigid_body', params: { id: 'pend', entityIds: ['$bob'], massKg: 1 } },
    {
      command: 'add_body_joint',
      params: { id: 'pivot', kind: 'revolute', child: 'pend', anchor: [0, 0, 0], axis: [0, 1, 0], stiffness, springReference: -angle },
    },
  ];
}

describe('energy balance (simulate_motion energy: true)', () => {
  it('an undamped pendulum keeps its total mechanical energy within 0.5 %', () => {
    const a = (30 * Math.PI) / 180;
    const doc = build([
      { command: 'set_units', params: { units: 'mm' } },
      { command: 'add_sphere', params: { radius: 10, position: [1000 * Math.sin(a), 0, -1000 * Math.cos(a)] }, as: 'bob' },
      { command: 'add_rigid_body', params: { id: 'pend', entityIds: ['$bob'], massKg: 1 } },
      { command: 'add_body_joint', params: { id: 'pivot', kind: 'revolute', child: 'pend', anchor: [0, 0, 0], axis: [0, 1, 0] } },
    ]);
    const result = execute(doc, 'simulate_motion', { duration: 6, energy: true, detail: 'series' });
    const data = result.data as SimulationData;
    expect(data.energy?.maxDeviationFraction ?? 1).toBeLessThan(0.005);
    expect(data.energy?.dissipatedJ).toBe(0);
    // released at rest: peak kinetic energy = m·g·L·(1 - cos 30 deg)
    const peak = Math.max(...(data.series?.energy?.kinetic ?? [0]));
    expect(Math.abs(peak - 9.81 * 1 * (1 - Math.cos(a))) / peak).toBeLessThan(0.01);
    expect(result.summary).toMatch(/Energy: total .* dissipated by damping and friction 0 J/);
    // default: no energy block
    expect((execute(doc, 'simulate_motion', { duration: 1 }).data as SimulationData).energy).toBeUndefined();
  });

  it('a damped flywheel loses kinetic energy as 1/2·I·w(t)^2 and the loss equals the dissipated energy', () => {
    const [mass, radius, damping, rpm] = [8, 0.2, 0.5, 600];
    const inertia = 0.5 * mass * radius ** 2;
    const doc = build([
      { command: 'add_cylinder', params: { radius: radius * 1000, height: 30, axis: [0, 1, 0], position: [0, 0, 0] }, as: 'd' },
      { command: 'add_rigid_body', params: { id: 'fly', entityIds: ['$d'], massKg: mass } },
      {
        command: 'add_body_joint',
        params: { id: 'j', kind: 'revolute', child: 'fly', anchor: [0, 0, 0], axis: [0, 1, 0], damping, initialRpm: rpm },
      },
    ]);
    const data = simulate(doc, { duration: 5, sampleRate: 200, detail: 'series', energy: true });
    const w0 = (rpm * 2 * Math.PI) / 60;
    const { times = [], energy } = data.series ?? {};
    const kinetic = energy?.kinetic ?? [];
    times.forEach((t, i) => {
      const analytic = 0.5 * inertia * (w0 * Math.exp((-damping * t) / inertia)) ** 2;
      expect(Math.abs((kinetic[i] ?? 0) - analytic) / (0.5 * inertia * w0 ** 2)).toBeLessThan(0.002);
    });
    const lost = 0.5 * inertia * w0 ** 2 - (kinetic[kinetic.length - 1] ?? 0);
    expect(Math.abs((data.energy?.dissipatedJ ?? 0) - lost) / lost).toBeLessThan(0.005);
    expect(data.energy?.finalTotalJ ?? 0).toBeLessThan(data.energy?.initialTotalJ ?? 0);
  });

  it('plot_simulation draws an energy panel', () => {
    const doc = build(sphereBob({ damping: 0.05 }));
    const result = execute(doc, 'plot_simulation', { quantities: ['energy'], duration: 2 });
    const panels = (result.data as { panels: { title: string; unit: string; series: { label: string }[] }[] }).panels;
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ title: 'Mechanical energy', unit: 'J' });
    expect(panels[0]?.series.map((s) => s.label)).toEqual(['kinetic', 'potential', 'total', 'dissipated']);
  });
});

describe('unsteady joint warnings say which way the speed goes', () => {
  const flywheel = (damping: number): CadDocument =>
    build([
      { command: 'add_cylinder', params: { radius: 100, height: 30, axis: [0, 1, 0], position: [0, 0, 0] }, as: 'd' },
      { command: 'add_rigid_body', params: { id: 'fly', entityIds: ['$d'], massKg: 8 } },
      {
        command: 'add_body_joint',
        params: { id: 'j', kind: 'revolute', child: 'fly', anchor: [0, 0, 0], axis: [0, 1, 0], damping, initialRpm: 600 },
      },
    ]);

  it('a decelerating flywheel is "still decelerating", never "accelerating"', () => {
    const warnings = simulate(flywheel(0.2), { duration: 2 }).warnings.join(' | ');
    expect(warnings).toMatch(/joint 'j' is still decelerating/);
    expect(warnings).not.toMatch(/accelerating/);
  });

  it('a decaying pendulum is "amplitude still decaying"', () => {
    const a = (10 * Math.PI) / 180;
    const doc = build([
      { command: 'set_units', params: { units: 'mm' } },
      {
        command: 'add_box',
        params: { size: [20, 20, 500], position: [250 * Math.sin(a), 0, -250 * Math.cos(a)], rotation: [0, a, 0] },
        as: 'bar',
      },
      { command: 'add_rigid_body', params: { id: 'pb', entityIds: ['$bar'], density: 7850 } },
      { command: 'add_body_joint', params: { id: 'jp', kind: 'revolute', child: 'pb', anchor: [0, 0, 0], axis: [0, 1, 0], damping: 0.05 } },
    ]);
    const warnings = simulate(doc, { duration: 6 }).warnings.join(' | ');
    expect(warnings).not.toMatch(/accelerating/);
    expect(warnings).toMatch(/joint 'jp' oscillates with an amplitude still decaying \(speed peak [\d.]+ % lower/);
  });

  it('trend classification and wording', () => {
    const grow = Array.from({ length: 100 }, (_, i) => i);
    const fall = grow.map((v) => 100 - v);
    const decay = grow.map((i) => Math.exp(-i / 40) * Math.cos(i / 3));
    const grown = grow.map((i) => Math.exp(i / 40) * Math.cos(i / 3));
    expect(speedTrend(grow).kind).toBe('accelerating');
    expect(speedTrend(fall).kind).toBe('decelerating');
    expect(speedTrend(decay).kind).toBe('amplitude_decaying');
    expect(speedTrend(grown).kind).toBe('amplitude_growing');
    expect(speedTrend(grow.map(() => 5)).kind).toBe('changing');
    expect(speedTrend(grow.map(() => 0)).kind).toBe('changing');
    expect(speedTrend(grow.map((i) => Math.cos(i / 8))).kind).toBe('oscillating');
    expect(speedTrend(grow.map((i) => Math.cos(i / 40) - 0.2)).kind).toBe('oscillating');
    expect(speedTrend([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]).kind).toBe('accelerating');
    expect(trendWarning('a', speedTrend(grow))).toMatch(/still accelerating/);
    expect(trendWarning('a', speedTrend(fall))).toMatch(/still decelerating at the end \(speed [\d.]+ % lower/);
    expect(trendWarning('a', speedTrend(grown))).toMatch(/growing amplitude/);
    expect(trendWarning('a', speedTrend(grow.map(() => 5)))).toMatch(/not yet steady \(speed changing by 0\.00 %/);
    expect(trendWarning('a', speedTrend(grow.map((i) => Math.cos(i / 8))))).toMatch(/oscillating and not yet periodic/);
  });
});

describe('render_motion grid', () => {
  it('clips every frame to its own cell so empty cells of the grid stay blank', () => {
    const doc = build(sphereBob({}));
    const svg = (execute(doc, 'render_motion', { frames: 5, duration: 1, width: 200, height: 160 }).data as { svg: string }).svg;
    expect(svg).toContain('<clipPath id="motion-cell"><rect width="200" height="160"/></clipPath>');
    const cells = svg.match(/<g transform="translate\([\d.]+, [\d.]+\)" clip-path="url\(#motion-cell\)">/g) ?? [];
    expect(cells).toHaveLength(5);
    // 5 frames on 4 columns: the third and fourth cells of the second row are empty (no group of their own)
    expect(svg).not.toMatch(/translate\(400, 182\)|translate\(600, 182\)/);
  });
});
