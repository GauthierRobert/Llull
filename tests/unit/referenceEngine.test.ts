/**
 * VC-FPR-24: check_prototype on the reference single-cylinder engine (validation/README §4) built CLI-style from its plan.
 * Heavy gate (about 33 min measured once on this machine for the plan plus the sub-checks; not yet profiled per check): runs only with LLULL_HEAVY_GATES=1. The plan
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
    const result = execute(doc, 'check_prototype', {});
    const data = result.data as Data;
    const rows = data.checks.map((check) => [check.check, check.status, check.items.map((item) => `${item.code}:${item.status}`)]);
    expect(data.verdict, JSON.stringify(rows)).toBe('ready_for_review');
    const byName = Object.fromEntries(data.checks.map((check) => [check.check, check]));
    expect(byName['mechanism']?.items[0]).toMatchObject({ code: 'FPR_MECH_OK', status: 'pass' });
    expect(byName['motion_clearance']?.items.every((item) => item.status === 'pass' || item.status === 'info')).toBe(true);
    // Manifold has no exact cylinder faces: joint realisation is not_run here (realised on the native OCCT kernel, VC-FPR-09)
    const assembly = byName['assembly']?.items ?? [];
    expect(assembly.filter((item) => item.status !== 'pass' && item.status !== 'info').map((item) => item.code)).toEqual(
      assembly.filter((item) => item.status === 'not_run').map(() => 'FPR_KERNEL_UNSUPPORTED'),
    );
    const dynamics = byName['dynamics']?.items ?? [];
    expect(dynamics.filter((item) => item.status === 'fail')).toEqual([]);
    const reference = dynamics.find((item) => item.code === 'FPR_REFERENCE_MATCH');
    expect(reference?.status).toBe('info');
    expect(reference?.accuracy?.['simulated']?.origin).toBe('calibrated');
    expect(dynamics.find((item) => item.code === 'FPR_TIMESTEP_SENSITIVE' && item.accuracy !== undefined)?.status).toBe('pass');
    expect(data.ownerSummary).toMatch(/^Ready for review\./);
    expect(data.ownerSummary).toMatch(/calibrated \(matched by construction, not validation evidence\)/);
  }, 3_600_000);
});
