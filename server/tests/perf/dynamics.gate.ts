/** PERF1 gate, rigid-body dynamics: `simulate_motion` on servo-driven arms and on closed-loop slider-cranks (budgets.ts `dynamics.*`). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { createNativeGeometryQueryEngine } from '../../src/native/geometryQueryEngine';
import { nativeBinaryPath } from '../../src/native/nativeBinary';
import { requireTool } from '../../../tests/requireTool';
import { expectWithinBudget, reportMeasurements } from './harness';

let context: ExecutionContext;

beforeAll(async () => {
  context = { ...defaultContext(), kernel: await createManifoldKernel(), physics: await createMujocoPhysics() };
});

afterAll(() => console.warn(reportMeasurements()));

function builder(): { must: (name: string, params: Record<string, unknown>) => string; doc: () => CadDocument } {
  let doc = createEmptyDocument();
  const must = (name: string, params: Record<string, unknown>): string => {
    const result = execute(doc, name, params, context);
    if (result.rejected === true) throw new Error(`${name}: ${result.summary}`);
    doc = result.document;
    return result.affected[0] ?? '';
  };
  must('set_units', { units: 'mm' });
  return { must, doc: () => doc };
}

/** `count` serial arms of four links on speed motors: 5 bodies, 4 joints and 4 governors each. */
function arms(count: number): CadDocument {
  const { must, doc } = builder();
  for (let arm = 0; arm < count; arm += 1) {
    const y = arm * 200;
    const pedestal = must('add_box', { size: [100, 100, 270], position: [0, y, 135] });
    must('add_rigid_body', { id: `base${arm}`, entityIds: [pedestal], fixed: true });
    let start = 0;
    [400, 300, 200, 150].forEach((length, link) => {
      const box = must('add_box', { size: [length, 40, 40], position: [start + length / 2, y, 300] });
      must('add_rigid_body', { id: `l${arm}_${link}`, entityIds: [box], massKg: 2 });
      must('add_body_joint', {
        id: `j${arm}_${link}`,
        kind: 'revolute',
        child: `l${arm}_${link}`,
        parent: link === 0 ? `base${arm}` : `l${arm}_${link - 1}`,
        anchor: [start, y, 300],
        axis: [0, 1, 0],
      });
      must('add_motor', { id: `m${arm}_${link}`, joint: `j${arm}_${link}`, kind: 'speed', rpm: 5 + link * 3, maxTorque: 200 });
      start += length;
    });
  }
  must('set_gravity', { gravity: [0, 0, -9.80665] });
  return doc();
}

/** `count` slider-cranks at 600 rpm: 3 bodies, 4 joints and one closed loop each. */
function sliderCranks(count: number): CadDocument {
  const { must, doc } = builder();
  const [radius, rod] = [49.2125, 150];
  const wrist = radius + rod;
  for (let crank = 0; crank < count; crank += 1) {
    const z = crank * 100;
    const disc = must('add_cylinder', { radius: 40, height: 20, axis: [0, 0, 1], position: [0, 0, z - 30] });
    const link = must('add_box', { size: [rod, 10, 10], position: [(radius + wrist) / 2, 0, z] });
    const piston = must('add_box', { size: [30, 30, 30], position: [wrist + 25, 0, z] });
    // A fixed liner beside each piston: a static part the moving ones pass close to.
    must('add_box', { size: [120, 60, 10], position: [wrist, 0, z + 25] });
    must('add_rigid_body', { entityIds: [disc], massKg: 15, id: `crank${crank}` });
    must('add_rigid_body', { entityIds: [link], massKg: 0.5, id: `rod${crank}` });
    must('add_rigid_body', { entityIds: [piston], massKg: 0.4, id: `piston${crank}` });
    must('add_body_joint', {
      id: `crank_j${crank}`,
      kind: 'revolute',
      child: `crank${crank}`,
      anchor: [0, 0, z],
      axis: [0, 0, 1],
      initialRpm: 600,
    });
    must('add_body_joint', {
      id: `rod_j${crank}`,
      kind: 'revolute',
      child: `rod${crank}`,
      parent: `crank${crank}`,
      anchor: [radius, 0, z],
      axis: [0, 0, 1],
    });
    must('add_body_joint', {
      id: `wrist_j${crank}`,
      kind: 'spherical',
      child: `piston${crank}`,
      parent: `rod${crank}`,
      anchor: [wrist, 0, z],
      axis: [0, 0, 1],
    });
    must('add_body_joint', { id: `slide_j${crank}`, kind: 'prismatic', child: `piston${crank}`, anchor: [wrist, 0, z], axis: [1, 0, 0] });
    must('add_motor', { id: `m${crank}`, joint: `crank_j${crank}`, kind: 'speed', rpm: 600, maxTorque: 200 });
  }
  return doc();
}

function simulate(doc: CadDocument, duration: number): { readonly milliseconds: number; readonly summary: string } {
  const started = performance.now();
  const result = execute(doc, 'simulate_motion', { duration }, context);
  return { milliseconds: performance.now() - started, summary: result.summary };
}

const compute = nativeBinaryPath('llull-compute');

describe.skipIf(requireTool('native:llull-compute', compute !== null))('motion clearance performance budget (PERF1)', () => {
  it('dynamics.clearance.cranks3: 63 part pairs over 361 samples of 3 slider-cranks, distances on the native engine', () => {
    const native = { ...context, geometryQueries: createNativeGeometryQueryEngine(compute ?? '') };
    const started = performance.now();
    const result = execute(sliderCranks(3), 'check_motion_clearance', { duration: 1 }, native);
    const elapsed = performance.now() - started;
    expect(result.summary).toContain('63 pair(s) over 361 samples');
    expectWithinBudget('dynamics.clearance.cranks3', elapsed);
  });
});

describe('motion clearance without the native engine (PERF1)', () => {
  it('dynamics.clearance.cranks3_ts: the same 63 part pairs over 361 samples on the TypeScript meshBvh', () => {
    const started = performance.now();
    const result = execute(sliderCranks(3), 'check_motion_clearance', { duration: 1 }, context);
    const elapsed = performance.now() - started;
    expect(result.summary).toContain('63 pair(s) over 361 samples');
    expectWithinBudget('dynamics.clearance.cranks3_ts', elapsed);
  });
});

describe('rigid-body dynamics performance budgets (PERF1)', () => {
  it('dynamics.simulate.servo_arms: 10 s of 10 four-link arms on speed motors', () => {
    const run = simulate(arms(10), 10);
    expect(run.summary).toContain('simulate_motion: 10 s');
    expectWithinBudget('dynamics.simulate.servo_arms', run.milliseconds);
  });

  it('dynamics.simulate.closed_loops: 2 s of 8 slider-cranks at 600 rpm', () => {
    const run = simulate(sliderCranks(8), 2);
    expect(run.summary).toContain('simulate_motion: 2 s');
    expectWithinBudget('dynamics.simulate.closed_loops', run.milliseconds);
  });
});
