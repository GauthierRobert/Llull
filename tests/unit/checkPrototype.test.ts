/** PHY-21 M4: check_prototype (aggregate verdict, stop rules, dispositions joined per spec 11 Q5) and set_review_disposition (VC-FPR-22). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { prototypeProblems } from '@core/commands/persistence/prototypeValidation';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

interface Item {
  code: string;
  status: string;
  findingKey: string;
  ids: string[];
  disposition?: { status: string; stale: boolean; by: string };
  note?: string;
}
interface Check {
  check: string;
  status: string;
  items: Item[];
  inputsHash: string;
}
interface Data {
  verdict: string;
  ownerSummary: string;
  checks: Check[];
  staleDispositions: string[];
  durationS: number | null;
  reviewRequired: boolean;
}

const ctxOf = (): ExecutionContext => ({ ...defaultContext(), kernel });

function step(doc: CadDocument, command: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, command, params, ctxOf());
  expect(result.rejected, `${command}: ${result.summary}`).toBeUndefined();
  return { doc: result.document, id: result.affected[0] ?? '' };
}

/** Arm 100 x 10 x 10 mm spinning about Z at 60 rpm; a fixed obstacle at y = obstacleY, grounded unless `floating`. */
function armScene(obstacleY: number, floating = false): { doc: CadDocument; arm: string; obstacle: string } {
  const arm = step(createEmptyDocument(), 'add_box', { size: [100, 10, 10], position: [50, 0, 0] });
  const obstacle = step(arm.doc, 'add_box', { size: [10, 20, 10], position: [0, obstacleY, 0] });
  let doc = step(obstacle.doc, 'add_rigid_body', { id: 'arm_body', entityIds: [arm.id], massKg: 1 }).doc;
  doc = step(doc, 'add_body_joint', {
    id: 'arm_j',
    kind: 'revolute',
    child: 'arm_body',
    anchor: [0, 0, 0],
    axis: [0, 0, 1],
    initialRpm: 60,
  }).doc;
  if (!floating) doc = step(doc, 'set_part_grounded', { ids: [obstacle.id], grounded: true }).doc;
  return { doc, arm: arm.id, obstacle: obstacle.id };
}

const run = (doc: CadDocument, params: Record<string, unknown> = {}): { data: Data; summary: string; document: CadDocument } => {
  const result = execute(doc, 'check_prototype', { durationS: 0.5, crankAxis: 'arm_j', ...params }, ctxOf());
  return { data: result.data as Data, summary: result.summary, document: result.document };
};
const checkOf = (data: Data, name: string): Check => {
  const found = data.checks.find((check) => check.check === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

describe('check_prototype', () => {
  it('a clean mechanism is ready for review, with the four checks, an owner summary and reviewRequired; it is pure', () => {
    const { doc } = armScene(150);
    const before = JSON.stringify(doc);
    const { data, summary, document } = run(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(document).toBe(doc);
    expect(data.checks.map((check) => check.check)).toEqual(['assembly', 'mechanism', 'motion_clearance', 'dynamics']);
    expect(data.verdict).toBe('ready_for_review');
    expect(checkOf(data, 'mechanism').items[0]).toMatchObject({ code: 'FPR_MECH_OK', status: 'pass' });
    expect(checkOf(data, 'motion_clearance').status).toBe('pass');
    expect(data.reviewRequired).toBe(true);
    expect(data.durationS).toBe(0.5);
    expect(data.ownerSummary).toMatch(/^Ready for review\. Checked 2 part\(s\), a mechanism with 1 degree\(s\) of freedom/);
    expect(data.ownerSummary).toMatch(/closest approach in motion/);
    expect(data.ownerSummary).toMatch(/Computed by llull, not approved — needs a qualified engineer\.$/);
    expect(summary).toMatch(/^check_prototype: ready_for_review — assembly /);
  });

  it('a collision in motion blocks the verdict; an accepted disposition is joined but never turns the fail into a pass (VC-FPR-22, Q5)', () => {
    const { doc } = armScene(95);
    const first = run(doc).data;
    expect(first.verdict).toBe('blocked');
    const motion = checkOf(first, 'motion_clearance');
    const hit = motion.items.find((item) => item.code === 'FPR_MOTION_INTERFERENCE');
    if (hit === undefined) throw new Error('no interference');
    expect(hit.status).toBe('fail');
    const accepted = step(doc, 'set_review_disposition', {
      findingKey: hit.findingKey,
      status: 'accepted',
      comment: 'known, the stop is moved in rev B',
      inputsHash: motion.inputsHash,
    }).doc;
    const second = run(accepted).data;
    const joined = checkOf(second, 'motion_clearance').items.find((item) => item.findingKey === hit.findingKey);
    expect(joined?.status).toBe('fail');
    expect(joined?.disposition).toMatchObject({ status: 'accepted', stale: false, by: 'agent' });
    // recording the disposition does not change the check's hash
    expect(checkOf(second, 'motion_clearance').inputsHash).toBe(motion.inputsHash);
    expect(second.verdict).toBe('blocked');
    expect(second.ownerSummary).toMatch(/1 accepted, still fails/);
    expect(second.staleDispositions).toEqual([]);
    // the model changes: the disposition is kept and flagged stale
    const moved = step(accepted, 'set_dynamics_solver', { loopTimeConstantSteps: 4 }).doc;
    const third = run(moved).data;
    expect(checkOf(third, 'motion_clearance').items.find((item) => item.findingKey === hit.findingKey)?.disposition?.stale).toBe(true);
    expect(third.staleDispositions).toEqual([hit.findingKey]);
    expect(third.ownerSummary).toMatch(/1 stale disposition/);
  });

  it('a floating part stops before the motion checks (not_run with the reason)', () => {
    const { doc, obstacle } = armScene(150, true);
    const { data } = run(doc);
    expect(data.verdict).toBe('blocked');
    expect(checkOf(data, 'assembly').items.some((item) => item.code === 'FPR_PART_FLOATING' && item.ids.includes(obstacle))).toBe(true);
    for (const name of ['motion_clearance', 'dynamics']) {
      const skipped = checkOf(data, name);
      expect(skipped.status).toBe('not_run');
      expect(skipped.items[0]).toMatchObject({ code: 'FPR_CHECK_SKIPPED', status: 'not_run' });
      expect(skipped.items[0]?.note).toMatch(/FPR_PART_FLOATING/);
    }
    expect(data.durationS).toBeNull();
    expect(data.ownerSummary).toMatch(/not run: clearance in motion, dynamics and realism/);
  });

  it('a document without parts is blocked and nothing reads as a pass', () => {
    const { data } = run(createEmptyDocument(), { crankAxis: undefined });
    expect(data.verdict).toBe('blocked');
    expect(checkOf(data, 'assembly').status).toBe('not_run');
    expect(checkOf(data, 'mechanism').items[0]?.code).toBe('FPR_MECH_NONE');
    expect(checkOf(data, 'motion_clearance').items[0]?.code).toBe('FPR_NO_MOTION');
    expect(checkOf(data, 'dynamics').status).toBe('not_run');
  });

  it('without a kernel execute refuses it; invalid params are rejected', () => {
    expect(execute(createEmptyDocument(), 'check_prototype', {}, { ...defaultContext(), kernel: null }).rejected).toBe(true);
    expect(execute(createEmptyDocument(), 'check_prototype', { cycles: 0 }, ctxOf()).summary).toMatch(/invalid params/);
  });
});

describe('set_review_disposition', () => {
  const key = 'assembly:FPR_PAIR_HARD:box-1.1,box-2.1';
  const set = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> =>
    execute(doc, 'set_review_disposition', { findingKey: key, inputsHash: 'h1', ...params }, ctxOf());

  it('records, updates and clears a disposition by finding key; it is pure and survives load validation', () => {
    const doc = createEmptyDocument();
    const before = JSON.stringify(doc);
    const first = set(doc, { status: 'relevant', comment: ' move the boss ' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(first.affected).toEqual(['box-1.1', 'box-2.1']);
    expect(first.document.prototype?.dispositions?.[key]).toEqual({
      findingKey: key,
      status: 'relevant',
      comment: 'move the boss',
      inputsHash: 'h1',
      by: 'agent',
    });
    expect(prototypeProblems(first.document.prototype)).toEqual([]);
    const accepted = set(first.document, { status: 'accepted', comment: 'ok' });
    expect(accepted.summary).toMatch(/Recorded only: an accepted fail still reads "fail \(accepted\)"/);
    const cleared = set(accepted.document, { status: 'not_reviewed' });
    expect(cleared.document.prototype?.dispositions).toEqual({});
    expect(cleared.summary).toMatch(/Cleared the disposition/);
  });

  it('refuses a malformed key, an empty hash, an unchanged disposition and clearing nothing', () => {
    const doc = createEmptyDocument();
    expect(set(doc, { findingKey: 'nope', status: 'relevant' }).affected).toEqual([]);
    expect(set(doc, { findingKey: 'thermal:FPR_X:a', status: 'relevant' }).summary).toMatch(/is not a finding key/);
    expect(set(doc, { status: 'relevant', inputsHash: ' ' }).summary).toMatch(/inputsHash must be/);
    expect(set(doc, { status: 'not_reviewed' }).summary).toMatch(/has no disposition to clear/);
    const once = set(doc, { status: 'irrelevant', comment: 'c' }).document;
    expect(set(once, { status: 'irrelevant', comment: 'c' }).summary).toMatch(/already irrelevant/);
    expect(execute(doc, 'set_review_disposition', { findingKey: key, status: 'maybe', inputsHash: 'h' }).summary).toMatch(/invalid params/);
  });

  it('load validation reports malformed dispositions', () => {
    const base = { intents: {}, grounded: [] };
    const good = { findingKey: key, status: 'accepted', comment: '', inputsHash: 'h', by: 'human' };
    expect(prototypeProblems({ ...base, dispositions: { [key]: good } })).toEqual([]);
    expect(prototypeProblems({ ...base, dispositions: 'x' })[0]).toMatch(/dispositions must be an object/);
    expect(prototypeProblems({ ...base, dispositions: { [key]: { ...good, findingKey: 'other' } } })[0]).toMatch(/whose findingKey/);
    expect(prototypeProblems({ ...base, dispositions: { 'x:y:z': { ...good, findingKey: 'x:y:z' } } })[0]).toMatch(/must read/);
    expect(prototypeProblems({ ...base, dispositions: { [key]: { ...good, status: 'maybe' } } })[0]).toMatch(/status must be/);
    expect(prototypeProblems({ ...base, dispositions: { [key]: { ...good, comment: 1 } } })[0]).toMatch(/comment must be/);
    expect(prototypeProblems({ ...base, dispositions: { [key]: { ...good, inputsHash: '' } } })[0]).toMatch(/inputsHash/);
    expect(prototypeProblems({ ...base, dispositions: { [key]: { ...good, by: 'bot' } } })[0]).toMatch(/by must be/);
    expect(prototypeProblems({ ...base, dispositions: JSON.parse('{"__proto__": {}}') as object })[0]).toMatch(/reserved/);
  });
});
