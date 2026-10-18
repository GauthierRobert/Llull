/**
 * ENG-3: the speed governor is gain-scheduled on the measured constrained effective inertia, so it holds its speed with the default solver
 * whatever the carried inertia over-states or under-states: light cranks under heavy links, a free bearing under a gear, a motor on a
 * joint whose parent moves. Fixed gains from the locked inertia diverged (or were far too soft) in each of these.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

type Action = { command: string; params: Record<string, unknown>; as?: string };
type Data = SimulationData & { loops?: { tier: string; residualM: number } };

const RPM = 954.929658551;
const PACK_PLAN = 'docs/physics/10-rigid-body-dynamics/validation/plans/rbd_slider_crank.plan.json';

function simulate(actions: readonly Action[], params: Record<string, unknown>): Data {
  const doc: CadDocument = execute(createEmptyDocument(), 'build_project', { actions }).document;
  const result = execute(doc, 'simulate_motion', params);
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as Data;
}

/** The pack-10 slider-crank (default solver, no simulation step) with the given masses and motor. */
function sliderActions(masses: { crank: number; rod: number; piston: number }, motorJoint = 'j_crank', rpm = RPM): Action[] {
  const plan = JSON.parse(readFileSync(path.resolve(__dirname, '../..', PACK_PLAN), 'utf8')) as Action[];
  return plan
    .filter((action) => !['set_dynamics_solver', 'inspect_dynamics', 'simulate_motion'].includes(action.command))
    .map((action) => {
      if (action.command === 'add_rigid_body')
        return { ...action, params: { ...action.params, massKg: masses[action.params['id'] as keyof typeof masses] } };
      if (action.command === 'add_motor') return { ...action, params: { ...action.params, joint: motorJoint, rpm } };
      return action;
    });
}

const peak = (data: Data, joint: string): number => Math.max(...(data.series?.jointVelocity[joint] ?? [0]).map(Math.abs));

describe('slider-crank governor with the default solver', () => {
  it.each([
    ['1 kg crank, 0.5 kg rod, 0.5 kg piston', { crank: 1, rod: 0.5, piston: 0.5 }],
    ['0.1 kg crank', { crank: 0.1, rod: 0.5, piston: 0.5 }],
    ['0.01 kg crank, 2 kg rod and piston', { crank: 0.01, rod: 2, piston: 2 }],
    ['1 g crank, 5 kg rod, 2 kg piston', { crank: 0.001, rod: 5, piston: 2 }],
  ])('%s holds the target speed with loop tier pass', (_label, masses) => {
    const data = simulate(sliderActions(masses), { duration: 0.2, detail: 'series', sampleRate: 5000 });
    expect(data.loops?.tier).toBe('pass');
    expect(Math.abs((data.joints['j_crank']?.finalRpm ?? 0) / RPM - 1)).toBeLessThan(1e-3);
    expect(peak(data, 'j_crank')).toBeLessThanOrEqual(1.05 * RPM * ((2 * Math.PI) / 60));
  });

  it('a motor on the crank pin (the rod turns relative to a moving crank) tracks its target with loop tier pass', () => {
    const data = simulate(sliderActions({ crank: 0.01, rod: 2, piston: 2 }, 'j_crankpin', -RPM), {
      duration: 0.2,
      detail: 'series',
      sampleRate: 5000,
    });
    expect(data.loops?.tier).toBe('pass');
    expect(Math.abs((data.joints['j_crankpin']?.finalRpm ?? 0) / -RPM - 1)).toBeLessThan(1e-3);
    const pin = data.series?.jointVelocity['j_crankpin'] ?? [];
    const times = data.series?.times ?? [];
    const settled = pin.filter((_, k) => (times[k] ?? 0) >= 0.05);
    expect(settled.length).toBeGreaterThan(100);
    for (const speed of settled) expect(Math.abs(Math.abs(speed) / 100 - 1)).toBeLessThan(0.01);
  });
});

/** An arm governed at 60 rpm that drives a free disk through its bearing and, through a -1 gear, a wheel: the locked inertia over-states it. */
function gearedFreeDisk(diskKg: number): Action[] {
  return [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [50, 8, 8], position: [25, 0, 0], anchor: 'center' }, as: 'arm' },
    { command: 'add_box', params: { size: [200, 200, 10], position: [50, 0, 0], anchor: 'center' }, as: 'disk' },
    { command: 'add_box', params: { size: [20, 20, 20], position: [300, 0, 0], anchor: 'center' }, as: 'w' },
    { command: 'add_rigid_body', params: { entityIds: ['$arm'], id: 'arm', massKg: 0.05 } },
    { command: 'add_rigid_body', params: { entityIds: ['$disk'], id: 'disk', massKg: diskKg } },
    { command: 'add_rigid_body', params: { entityIds: ['$w'], id: 'w', massKg: 0.1 } },
    { command: 'add_body_joint', params: { kind: 'revolute', child: 'arm', anchor: [0, 0, 0], axis: [0, 0, 1], id: 'jArm' } },
    {
      command: 'add_body_joint',
      params: { kind: 'revolute', child: 'disk', parent: 'arm', anchor: [50, 0, 0], axis: [0, 0, 1], id: 'jDisk' },
    },
    { command: 'add_body_joint', params: { kind: 'revolute', child: 'w', anchor: [300, 0, 0], axis: [0, 0, 1], id: 'jW' } },
    { command: 'add_gear_coupling', params: { driver: 'jArm', driven: 'jW', ratio: -1, id: 'g' } },
    { command: 'add_motor', params: { joint: 'jArm', kind: 'speed', rpm: 60, maxTorque: 1000, id: 'drive' } },
    { command: 'set_gravity', params: { gravity: [0, 0, 0] } },
  ];
}

describe('governor of a geared arm carrying a free disk (locked inertia over-states the driven one)', () => {
  it.each([5, 1.5])('disk of %s kg: arm at 60 rpm within 1e-3, wheel at -60 rpm', (diskKg) => {
    const data = simulate(gearedFreeDisk(diskKg), { duration: 1 });
    expect(Math.abs((data.joints['jArm']?.finalRpm ?? 0) / 60 - 1)).toBeLessThan(1e-3);
    expect(Math.abs((data.joints['jW']?.finalRpm ?? 0) / -60 - 1)).toBeLessThan(1e-3);
  });
});

/** A light 1 kg disk on a joint with dry friction (the friction row sticks the joint rigid: it must not enter the measured inertia). */
function frictionDisk(frictionNm: number, rpm: number, maxTorque: number, initialVelocity = 0): Action[] {
  return [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [100, 100, 10], position: [0, 0, 0], anchor: 'center' }, as: 'd' },
    { command: 'add_rigid_body', params: { entityIds: ['$d'], id: 'd', massKg: 1 } },
    {
      command: 'add_body_joint',
      params: { kind: 'revolute', child: 'd', anchor: [0, 0, 0], axis: [0, 0, 1], id: 'j', friction: frictionNm, initialVelocity },
    },
    { command: 'add_motor', params: { joint: 'j', kind: 'speed', rpm, maxTorque, id: 'm' } },
    { command: 'set_gravity', params: { gravity: [0, 0, 0] } },
  ];
}

describe('governor of a joint with dry friction', () => {
  it('spin-up from rest through the stuck state: peak speed at most 1.01 x the 600 rpm target, settles on it', () => {
    const data = simulate(frictionDisk(5, 600, 1e6), { duration: 0.5, detail: 'series', sampleRate: 1000 });
    expect(peak(data, 'j')).toBeLessThanOrEqual(1.01 * 600 * ((2 * Math.PI) / 60));
    expect(Math.abs((data.joints['j']?.finalRpm ?? 0) / 600 - 1)).toBeLessThan(1e-3);
  });

  it('stick to slip reversal: spinning at +10 rad/s commanded to -60 rpm passes through rest and settles on the target without ringing', () => {
    const data = simulate(frictionDisk(5, -60, 1e6, 10), { duration: 0.5, detail: 'series', sampleRate: 1000 });
    expect(peak(data, 'j')).toBeLessThanOrEqual(1.01 * 10);
    expect(Math.abs((data.joints['j']?.finalRpm ?? 0) / -60 - 1)).toBeLessThan(1e-3);
  });
});
