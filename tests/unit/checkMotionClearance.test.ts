import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Vec3 } from '@core/model/types';

interface Envelope {
  check: string;
  status: string;
  items: {
    code: string;
    status: string;
    ids: string[];
    findingKey: string;
    values: Record<string, number>;
    witness?: { pointsMm: number[][]; crankDeg?: number };
  }[];
  inputsHash: string;
}

function instance(doc: CadDocument, name: string, position: Vec3): { doc: CadDocument; id: string } {
  const box = execute(doc, 'add_box', { size: [1, 1, 1] });
  const created = execute(box.document, 'create_component', { name, entityIds: [box.affected[0]] }).document;
  // create_component also drops an instance at the origin; remove it so only the placed instance exists
  const strays = Object.values(created.entities).filter((entity) => entity.kind === 'instance' && doc.entities[entity.id] === undefined);
  const withComponent = execute(created, 'delete_entities', { ids: strays.map((entity) => entity.id) }).document;
  const componentId = Object.keys(withComponent.components).at(-1);
  const inserted = execute(withComponent, 'insert_instance', { componentId, position });
  return { doc: inserted.document, id: inserted.affected[0] ?? '' };
}

/** Pivot at the origin, arm 5 units along +X; `obstacleAt` puts a third part on the arm's circle. */
function sweepScene(kind: 'revolute' | 'prismatic', obstacleAt?: Vec3): { doc: CadDocument; arm: string; obstacle: string } {
  const pivot = instance(createEmptyDocument(), 'Pivot', [0, 0, 0]);
  const arm = instance(pivot.doc, 'Arm', [5, 0, 0]);
  const obstacle = instance(arm.doc, 'Obstacle', obstacleAt ?? [0, 0, 20]);
  const joint = execute(obstacle.doc, 'add_joint', { kind, a: { instanceId: pivot.id }, b: { instanceId: arm.id }, axis: 'z' });
  return { doc: joint.document, arm: arm.id, obstacle: obstacle.id };
}

const run = (doc: CadDocument, params: object = {}): { envelope: Envelope; summary: string; document: CadDocument; affected: string[] } => {
  const result = execute(doc, 'check_motion_clearance', params);
  return { envelope: result.data as Envelope, summary: result.summary, document: result.document, affected: result.affected };
};

describe('check_motion_clearance', () => {
  it('an obstacle on the arm circle gives a warn FPR_MOTION_INTERFERENCE with the first angle and a witness', () => {
    const { doc, arm, obstacle } = sweepScene('revolute', [0, 5, 0]);
    const { envelope, summary, affected } = run(doc, { steps: 37 });
    expect(envelope.check).toBe('motion_clearance');
    expect(envelope.status).toBe('warn');
    const hit = envelope.items.find((item) => item.code === 'FPR_MOTION_INTERFERENCE' && item.ids.includes(obstacle));
    expect(hit?.status).toBe('warn');
    expect(hit?.ids).toEqual([arm, obstacle].sort());
    expect(hit?.findingKey).toBe(`motion_clearance:FPR_MOTION_INTERFERENCE:${[arm, obstacle].sort().join(',')}`);
    expect(hit?.values['framesWithInterference']).toBeGreaterThan(0);
    expect(hit?.values['firstAtDeg']).toBeGreaterThan(0);
    expect(hit?.values['firstAtDeg']).toBeLessThanOrEqual(90);
    expect(hit?.witness?.crankDeg).toBe(hit?.values['firstAtDeg']);
    expect(hit?.witness?.pointsMm).toHaveLength(2);
    expect(summary).toContain('check_motion_clearance: warn');
    expect(affected).toEqual([]);
  });

  it('nothing in the way: pass FPR_MOTION_CLEAR with the steps checked (default 36)', () => {
    const { doc } = sweepScene('revolute');
    const { envelope } = run(doc);
    expect(envelope.status).toBe('pass');
    expect(envelope.items.map((item) => item.code)).toEqual(['FPR_MOTION_CLEAR']);
    expect(envelope.items[0]?.values).toEqual({ stepsChecked: 36, jointsSwept: 1 });
  });

  it('a prismatic joint has no travel limits: not_run FPR_MOTION_NO_LIMITS', () => {
    const { doc } = sweepScene('prismatic');
    const { envelope } = run(doc);
    expect(envelope.status).toBe('not_run');
    expect(envelope.items.map((item) => item.code)).toEqual(['FPR_MOTION_NO_LIMITS']);
  });

  it('no joints: not_run FPR_MOTION_NONE, unchanged document', () => {
    const doc = createEmptyDocument();
    const { envelope, document } = run(doc);
    expect(envelope.status).toBe('not_run');
    expect(envelope.items.map((item) => item.code)).toEqual(['FPR_MOTION_NONE']);
    expect(document).toBe(doc);
  });

  it('rejects steps outside 2..360 as invalid params', () => {
    const { doc } = sweepScene('revolute');
    for (const steps of [1, 361, 2.5]) {
      const result = execute(doc, 'check_motion_clearance', { steps });
      expect(result.summary).toContain('rejected');
      expect(result.data).toBeUndefined();
    }
  });

  it('is pure and deterministic', () => {
    const { doc } = sweepScene('revolute', [0, 5, 0]);
    const before = JSON.stringify(doc);
    const first = run(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(first.document).toBe(doc);
    expect(run(doc).envelope.inputsHash).toBe(first.envelope.inputsHash);
  });
});
