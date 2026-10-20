/**
 * VC-FPR-24: check_prototype on the reference single-cylinder engine (validation/README §4) built CLI-style from its plan.
 * Heavy gate (runtime recorded in TECHNICAL_SPEC 12): runs only with LLULL_HEAVY_GATES=1. The plan
 * itself is replayed on every run by the golden corpus (dynamics_reference_engine).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { runPlan } from '../golden/runPlan';
import { referenceEnginePlan } from '../golden/referenceEnginePlan';

const HEAVY = process.env['LLULL_HEAVY_GATES'] === '1';

interface Item {
  code: string;
  status: string;
  note?: string;
  unverified?: boolean;
  values?: Record<string, number>;
  accuracy?: Record<string, { origin: string }>;
}
interface Data {
  verdict: string;
  ownerSummary: string;
  checks: { check: string; status: string; items: Item[] }[];
}

let previous: GeometryKernel | null;
let doc: CadDocument;
beforeAll(async () => {
  if (!HEAVY) return;
  previous = getGeometryKernel();
  setGeometryKernel(await createManifoldKernel());
  setPhysicsEngine(await createMujocoPhysics());
  const built = runPlan(referenceEnginePlan);
  expect(built.failedSteps).toEqual([]);
  doc = built.document;
}, 120_000);
afterAll(() => {
  if (!HEAVY) return;
  setGeometryKernel(previous);
  setPhysicsEngine(null);
});

describe.skipIf(!HEAVY)('reference engine (VC-FPR-24)', () => {
  it('check_prototype: ready_for_review, one DOF, no collision over the cycle, every value with an accuracy origin', () => {
    const started = Date.now();
    const result = execute(doc, 'check_prototype', {});
    const data = result.data as Data;
    const rows = data.checks.map((check) => [check.check, check.status, check.items.map((item) => `${item.code}:${item.status}`)]);
    console.warn(`check_prototype ${((Date.now() - started) / 1000).toFixed(0)} s: ${JSON.stringify(rows)}`);
    expect(data.verdict, JSON.stringify(rows)).toBe('ready_for_review');
    const byName = Object.fromEntries(data.checks.map((check) => [check.check, check]));
    // one DOF: crank + propeller coordinates minus the rod loop minus the gear coupling
    expect(byName['mechanism']?.items[0]).toMatchObject({ code: 'FPR_MECH_OK', status: 'pass', values: { dof: 1 } });
    expect(byName['motion_clearance']?.items.every((item) => item.status === 'pass' || item.status === 'info')).toBe(true);
    // Manifold has no exact cylinder faces: the joints are realised from a cylinder fit on the tessellation (pass, unverified, "approximate");
    // the exact faces of the native kernel are covered by server/tests/occtCheckAssembly.test.ts (VC-FPR-09). Nothing is not_run.
    const assembly = byName['assembly']?.items ?? [];
    const realised = assembly.filter((item) => item.code.startsWith('FPR_JOINT_'));
    expect(realised.map((item) => [item.code, item.status])).toEqual(
      ['crank_j', 'rod_j', 'prop_j'].map(() => ['FPR_JOINT_REALISED', 'pass']),
    );
    expect(realised.every((item) => item.unverified === true && /approximate/.test(item.note ?? ''))).toBe(true);
    expect(assembly.filter((item) => item.status !== 'pass' && item.status !== 'info')).toEqual([]);
    const dynamics = byName['dynamics']?.items ?? [];
    expect(dynamics.filter((item) => item.status === 'fail' || item.status === 'not_run')).toEqual([]);
    // two open findings, both declared: (1) the planar slider-crank repeats the out-of-plane position of the wrist pin (reactions along z are
    // indeterminate); (2) check_dynamics compares the final instantaneous state of a fast periodic motion at 1.44e-5 s and 1e-5 s, a
    // phase-sensitive metric (the engine convergence itself is the passing check_timestep_convergence item, with accuracy)
    expect(dynamics.filter((item) => item.status === 'warn').map((item) => item.code)).toEqual([
      'FPR_REDUNDANT_CONSTRAINT',
      'FPR_TIMESTEP_SENSITIVE',
    ]);
    const reference = dynamics.find((item) => item.code === 'FPR_REFERENCE_MATCH');
    expect(reference?.status).toBe('info');
    expect(reference?.accuracy?.['simulated']?.origin).toBe('calibrated');
    expect(dynamics.find((item) => item.code === 'FPR_TIMESTEP_SENSITIVE' && item.accuracy !== undefined)?.status).toBe('pass');
    expect(data.ownerSummary).toMatch(/^Ready for review\./);
    expect(data.ownerSummary).toMatch(/calibrated \(matched by construction, not validation evidence\)/);
  }, 3_600_000);
});
