/** PHY-21 slice C: check_motion_clearance on a rotating arm and a slider-crank (VC-FPR-18/19), failure codes, purity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CheckItem, CheckResult } from '@core/model/checkResult';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExecutionContext } from '@core/commands/types';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { sliderCrank } from './sliderCrankFixture';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

interface Collision {
  kind: string;
  startTimeS: number;
  endTimeS: number;
  startCrankDeg: number | null;
  endCrankDeg: number | null;
  overlapVolumeMm3: number | null;
  penetrationEstimateMm: number | null;
}
interface PairData {
  a: string;
  b: string;
  minClearanceMm: number | null;
  timeS: number | null;
  crankDeg: number | null;
  status: string;
  collisions: Collision[];
}
type Data = CheckResult & {
  pairs: PairData[];
  minClearance: { mm: number; a: string; b: string; crankDeg: number | null } | null;
  samples: { simulated: number; evaluated: number; stride: number; resolutionS: number };
};

const ctxOf = (k: GeometryKernel | null = kernel): ExecutionContext => ({ ...defaultContext(), kernel: k });
const codes = (data: CheckResult): string[] => data.items.map((item) => item.code);
const itemOf = (data: CheckResult, code: string): CheckItem => {
  const found = data.items.find((entry) => entry.code === code);
  if (found === undefined) throw new Error(`no ${code} in ${codes(data).join(', ')}`);
  return found;
};

function step(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params, ctxOf());
  expect(result.rejected, `${command}: ${result.summary}`).toBeUndefined();
  return { doc: result.document, id: result.affected[0] ?? '' };
}

/** Arm 100 x 10 x 10 mm from the origin along +X, spinning about +Z at 60 rpm; an obstacle box fixed at [0, obstacleY, obstacleZ]. */
function armScene(options: { obstacleY?: number; obstacleZ?: number; rpm?: number } = {}): {
  doc: CadDocument;
  arm: string;
  obstacle: string;
} {
  const arm = step(createEmptyDocument(), 'add_box', { size: [100, 10, 10], position: [50, 0, 0] });
  const obstacle = step(arm.doc, 'add_box', { size: [10, 20, 10], position: [0, options.obstacleY ?? 95, options.obstacleZ ?? 0] });
  let doc = step(obstacle.doc, 'add_rigid_body', { id: 'arm_body', entityIds: [arm.id], massKg: 1 }).doc;
  doc = step(doc, 'add_body_joint', {
    id: 'arm_j',
    kind: 'revolute',
    child: 'arm_body',
    anchor: [0, 0, 0],
    axis: [0, 0, 1],
    initialRpm: options.rpm ?? 60,
  }).doc;
  return { doc, arm: arm.id, obstacle: obstacle.id };
}

const check = (doc: CadDocument, params: Record<string, unknown> = {}, context = ctxOf()): ReturnType<typeof execute> =>
  execute(doc, 'check_motion_clearance', { crankAxis: 'arm_j', duration: 0.5, sampleRate: 360, ...params }, context);

describe('check_motion_clearance on a rotating arm', () => {
  it('flags the obstacle at the analytic crank angle (VC-FPR-19)', () => {
    const { doc, arm, obstacle } = armScene();
    const before = JSON.stringify(doc);
    const result = check(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const data = result.data as Data;
    expect(data.check).toBe('motion_clearance');
    expect(data.status).toBe('fail');
    expect(data.reviewRequired).toBe(true);
    const item = itemOf(data, 'FPR_MOTION_INTERFERENCE');
    expect(item.status).toBe('fail');
    expect(item.ids).toEqual([arm, obstacle].sort());
    expect(item.values['maxOverlapVolumeMm3']).toBeGreaterThan(0);
    expect(item.witness?.crankDeg).toBeDefined();
    // the arm's leading edge meets the near corner (5, 85) of the obstacle: 85 cos t - 5 sin t = 5
    const analytic = (Math.acos(5 / Math.hypot(85, 5)) - Math.atan2(5, 85)) * (180 / Math.PI);
    const pair = data.pairs.find((entry) => entry.status === 'interference');
    const first = pair?.collisions[0];
    expect(first?.kind).toBe('interference');
    expect(Math.abs((first?.startCrankDeg ?? 0) - analytic)).toBeLessThan(1.5);
    expect(first?.endTimeS ?? 0).toBeGreaterThan(first?.startTimeS ?? 1);
    expect(first?.overlapVolumeMm3 ?? 0).toBeGreaterThan(0);
    expect(first?.penetrationEstimateMm ?? 0).toBeGreaterThan(0);
    expect(result.summary).toMatch(/^check_motion_clearance: fail — 1 pair/);
  });

  it('passes a clean mechanism and reports the minimum gap with its crank angle', () => {
    const { doc } = armScene({ obstacleY: 150 });
    const data = check(doc).data as Data;
    expect(data.status).toBe('pass');
    expect(data.items).toEqual([]);
    // the corner of the arm tip reaches 100.12 mm along the obstacle axis (at atan(20) = 87.1 deg); the obstacle starts at y = 140
    expect(data.minClearance?.mm).toBeCloseTo(139.99 - 100.12, 0);
    expect(Math.abs((data.minClearance?.crankDeg ?? 0) - 87.14)).toBeLessThan(8);
    expect(data.pairs).toHaveLength(1);
    expect(data.pairs[0]?.collisions).toEqual([]);
    expect(data.samples.stride).toBe(1);
    expect(data.samples.resolutionS).toBeGreaterThan(0);
  });

  it('warns when the gap is below clearanceMm and the run is otherwise clean', () => {
    const { doc } = armScene({ obstacleY: 150 });
    const data = check(doc, { clearanceMm: 60 }).data as Data;
    expect(data.status).toBe('warn');
    const low = itemOf(data, 'FPR_MOTION_CLEARANCE_LOW');
    expect(low.threshold?.value).toBe(60);
    expect(low.values['minDistanceMm']).toBeLessThan(60);
    expect(low.witness?.crankDeg).toBeDefined();
    expect((check(doc, { clearanceMm: 30 }).data as Data).status).toBe('pass');
  });

  it('honours allow_interference: the overlap becomes FPR_MOTION_ALLOWED (pass)', () => {
    const { doc, arm, obstacle } = armScene();
    const allowed = step(doc, 'allow_interference', { a: obstacle, b: arm, kind: 'overlap_by_design', reason: 'sacrificial stop' });
    const data = check(allowed.doc).data as Data;
    expect(codes(data)).toEqual(['FPR_MOTION_ALLOWED']);
    expect(itemOf(data, 'FPR_MOTION_ALLOWED').intent).toMatchObject({ id: allowed.id, kind: 'overlap_by_design' });
    expect(data.status).toBe('pass');
    expect(data.pairs[0]?.status).toBe('allowed');
  });

  it('treats contact without volume as touch (info), not an interference', () => {
    const { doc } = armScene({ obstacleY: 50, obstacleZ: 10 });
    const data = check(doc).data as Data;
    expect(codes(data)).toEqual(['FPR_MOTION_TOUCH']);
    expect(data.status).toBe('pass');
    expect(data.pairs[0]?.status).toBe('touch');
    expect(data.pairs[0]?.collisions[0]?.kind).toBe('touch');
  });

  it('reports interference as unverified when the kernel cannot compute the overlap volume', () => {
    const blind: GeometryKernel = {
      supports: (op) => kernel.supports(op),
      evaluate: (recipe) => kernel.evaluate(recipe),
      tessellate: (shape) => kernel.tessellate(shape),
      topology: (shape) => kernel.topology(shape),
      exportStep: (shapes) => kernel.exportStep(shapes),
    };
    const data = check(armScene().doc, {}, ctxOf(blind)).data as Data;
    const item = itemOf(data, 'FPR_MOTION_INTERFERENCE');
    expect(item.unverified).toBe(true);
    expect(data.unverified).toBe(true);
    expect(data.pairs[0]?.collisions[0]?.overlapVolumeMm3).toBeNull();
  });

  it('thins long runs with maxSamples and warns that a thin obstacle can be skipped', () => {
    const scene = armScene({ obstacleY: 150 });
    const needle = step(scene.doc, 'add_box', { size: [2, 2, 2], position: [0, -150, 0] });
    const data = check(needle.doc, { duration: 0.75, maxSamples: 4 }).data as Data;
    expect(data.samples.stride).toBeGreaterThan(1);
    expect(data.samples.evaluated).toBeLessThanOrEqual(5);
    expect(codes(data)).toContain('FPR_MOTION_UNDERSAMPLED');
    expect(data.status).toBe('warn');
    expect(data.unverified).toBe(true);
  });

  it('limits the check to pairs that include the focus ids, and pairs "all" adds static pairs', () => {
    const { doc, arm, obstacle } = armScene({ obstacleY: 150 });
    const extra = step(doc, 'add_box', { size: [10, 10, 10], position: [300, 300, 0] });
    expect((check(extra.doc).data as Data).pairs).toHaveLength(2);
    expect((check(extra.doc, { ids: [extra.id] }).data as Data).pairs.map((p) => [p.a, p.b])).toEqual([[arm, extra.id]]);
    expect((check(extra.doc, { ids: [obstacle] }).data as Data).pairs).toHaveLength(1);
    expect((check(extra.doc, { pairs: 'all' }).data as Data).pairs).toHaveLength(3);
  });

  it('is deterministic', () => {
    const { doc } = armScene();
    expect(JSON.stringify(check(doc).data)).toBe(JSON.stringify(check(doc).data));
  });
});

describe('check_motion_clearance on a slider-crank', () => {
  /** Wrist pin x at crank angle `deg` from TDC: r cos t + sqrt(l^2 - r^2 sin^2 t). */
  const wristX = (r: number, l: number, deg: number): number => {
    const t = (deg * Math.PI) / 180;
    return r * Math.cos(t) + Math.sqrt(l * l - r * r * Math.sin(t) ** 2);
  };
  const params = { crankAxis: 'crank_j', duration: 1, sampleRate: 360 };

  function mechanism(): { doc: CadDocument; rod: string; piston: string } {
    const built = sliderCrank({ crankRpm: 60, crankZMm: 20 });
    const entityOf = (body: string): string => built.doc.dynamics?.bodies[body]?.entityIds[0] ?? '';
    const [rod, piston] = [entityOf('rod'), entityOf('piston')];
    // the rod's end sits inside the piston: a declared weld, as in the real part
    const doc = step(built.doc, 'allow_interference', { a: rod, b: piston, kind: 'weld', reason: 'rod end pinned in the piston' }).doc;
    return { doc, rod, piston };
  }

  it('passes a clean slider-crank and reports the closest approach', () => {
    const data = execute(mechanism().doc, 'check_motion_clearance', params, ctxOf()).data as Data;
    expect(data.status).toBe('pass');
    expect(codes(data)).toEqual(['FPR_MOTION_ALLOWED']);
    expect(data.pairs).toHaveLength(3);
    expect(data.minClearance?.mm).toBeGreaterThan(4);
    expect(data.minClearance?.mm).toBeLessThan(6.5);
  });

  it('flags a deliberate obstacle in the piston path at the analytic crank angles', () => {
    const { doc, piston } = mechanism();
    const obstacle = step(doc, 'add_box', { size: [10, 40, 10], position: [90, 0, 13] });
    const data = execute(obstacle.doc, 'check_motion_clearance', params, ctxOf()).data as Data;
    expect(data.status).toBe('fail');
    const pair = data.pairs.find((entry) => entry.status === 'interference');
    expect([pair?.a, pair?.b].sort()).toEqual([piston, obstacle.id].sort());
    // contact while the piston's rear face (wrist pin - 15 mm) is below the obstacle's far face at x = 95
    let [lo, hi] = [90, 180];
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (wristX(49.2125, 150, mid) - 15 < 95) hi = mid;
      else lo = mid;
    }
    const first = pair?.collisions[0];
    expect(Math.abs((first?.startCrankDeg ?? 0) - hi)).toBeLessThan(2);
    expect(Math.abs((first?.endCrankDeg ?? 0) - (360 - hi))).toBeLessThan(2);
  });

  it('propagates the simulation refusal code (open loop)', () => {
    const open = sliderCrank({ crankRpm: 60, crankZMm: 20, wristGapMm: 1 });
    const result = execute(open.doc, 'check_motion_clearance', params, ctxOf());
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('FPR_LOOP_OPEN');
  });
});

describe('check_motion_clearance failures', () => {
  const rejected = (doc: CadDocument, code: string, extra: Record<string, unknown> = {}): void => {
    const result = check(doc, extra);
    expect(result.rejected, result.summary).toBe(true);
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain(code);
  };

  it('rejects a document without rigid bodies', () => {
    rejected(step(createEmptyDocument(), 'add_box', { size: [10, 10, 10] }).doc, 'FPR_NO_MOTION');
  });

  it('rejects a mechanism that does not move', () => {
    rejected(armScene({ rpm: 0 }).doc, 'FPR_NO_MOTION');
  });

  it('rejects unknown ids and a crankAxis that is not a revolute joint', () => {
    const { doc } = armScene();
    rejected(doc, 'FPR_UNKNOWN_ID', { ids: ['nope'] });
    rejected(doc, 'FPR_UNKNOWN_ID', { crankAxis: 'nope' });
  });

  it('is a no-op without a kernel, and zod rejects invalid params', () => {
    const { doc } = armScene();
    const none = check(doc, {}, ctxOf(null));
    expect(none.document).toBe(doc);
    expect(none.affected).toEqual([]);
    expect(none.data).toBeUndefined();
    const invalid = check(doc, { duration: -1 });
    expect(invalid.rejected).toBe(true);
    expect(invalid.summary).toContain('invalid params');
  });

  it('refuses more than 2000 pairs with FPR_BUDGET_EXCEEDED', () => {
    const { doc } = armScene({ obstacleY: 150 });
    const batch = Array.from({ length: 66 }, (_, k) => ({
      command: 'add_box',
      params: { size: [1, 1, 1], position: [1000 + 5 * k, 1000, 0] },
    }));
    rejected(execute(doc, 'build_project', { actions: batch }, ctxOf()).document, 'FPR_BUDGET_EXCEEDED', { pairs: 'all' });
  });

  it('reports not_run when no pair has a moving member', () => {
    const lone = step(createEmptyDocument(), 'add_box', { size: [10, 10, 10], position: [100, 0, 0] });
    const body = step(lone.doc, 'add_rigid_body', { id: 'b', entityIds: [lone.id], massKg: 1 });
    const joint = step(body.doc, 'add_body_joint', {
      id: 'arm_j',
      kind: 'revolute',
      child: 'b',
      anchor: [0, 0, 0],
      axis: [0, 0, 1],
      initialRpm: 60,
    });
    const data = check(joint.doc).data as Data;
    expect(data.pairs).toEqual([]);
    expect(codes(data)).toContain('FPR_NO_PAIRS');
    expect(data.status).toBe('not_run');
  });
});
