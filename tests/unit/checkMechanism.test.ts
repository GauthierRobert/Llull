import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

interface Envelope {
  check: string;
  status: string;
  items: { code: string; status: string; ids: string[]; findingKey: string; values: Record<string, number> }[];
  inputsHash: string;
  reviewRequired: boolean;
}

function instance(doc: CadDocument, name: string): { doc: CadDocument; id: string } {
  const box = execute(doc, 'add_box', { size: [1, 1, 1] });
  const withComponent = execute(box.document, 'create_component', { name, entityIds: [box.affected[0]] }).document;
  const componentId = Object.keys(withComponent.components).at(-1);
  const inserted = execute(withComponent, 'insert_instance', { componentId });
  return { doc: inserted.document, id: inserted.affected[0] ?? '' };
}

function hinge(): { doc: CadDocument; jointId: string; a: string; b: string } {
  const a = instance(createEmptyDocument(), 'A');
  const b = instance(a.doc, 'B');
  const joint = execute(b.doc, 'add_joint', { kind: 'revolute', a: { instanceId: a.id }, b: { instanceId: b.id }, axis: 'z' });
  return { doc: joint.document, jointId: joint.affected[0] ?? '', a: a.id, b: b.id };
}

const check = (doc: CadDocument): { envelope: Envelope; summary: string; document: CadDocument; affected: string[] } => {
  const result = execute(doc, 'check_mechanism', {});
  return { envelope: result.data as Envelope, summary: result.summary, document: result.document, affected: result.affected };
};

function dynamicsDoc(withMotor: boolean, secondJoint: boolean): CadDocument {
  const actions = [
    { command: 'add_box', as: 'base', params: { size: [10, 10, 10] } },
    { command: 'add_box', as: 'link', params: { size: [10, 10, 10], position: [20, 0, 0] } },
    { command: 'add_rigid_body', params: { id: 'frame', entityIds: ['$base'], fixed: true } },
    { command: 'add_rigid_body', params: { id: 'arm', entityIds: ['$link'] } },
    {
      command: 'add_body_joint',
      params: { id: 'j1', kind: 'revolute', child: 'arm', parent: 'frame', anchor: [0, 0, 0], axis: [0, 1, 0] },
    },
    ...(secondJoint
      ? [
          {
            command: 'add_body_joint',
            params: { id: 'j2', kind: 'revolute', child: 'arm', parent: 'frame', anchor: [0, 0, 5], axis: [0, 1, 0] },
          },
        ]
      : []),
    ...(withMotor ? [{ command: 'add_motor', params: { joint: 'j1', kind: 'speed', rpm: 60, maxTorque: 10 } }] : []),
  ];
  return execute(createEmptyDocument(), 'build_project', { actions }).document;
}

describe('check_mechanism', () => {
  it('a single hinge has mobility 1 and no drive: warn FPR_MECH_UNDERCONSTRAINED with the counts', () => {
    const { doc, jointId } = hinge();
    const { envelope, summary, affected } = check(doc);
    expect(envelope.check).toBe('mechanism');
    expect(envelope.status).toBe('warn');
    expect(envelope.reviewRequired).toBe(true);
    expect(envelope.items).toHaveLength(1);
    const [item] = envelope.items;
    expect(item?.code).toBe('FPR_MECH_UNDERCONSTRAINED');
    expect(item?.ids).toEqual([jointId]);
    expect(item?.findingKey).toBe(`mechanism:FPR_MECH_UNDERCONSTRAINED:${jointId}`);
    expect(item?.values).toEqual({ mobility: 1, bodies: 2, joints: 1, drives: 0 });
    expect(summary).toContain('check_mechanism: warn');
    expect(affected).toEqual([]);
  });

  it('a drive relation couples two hinges: mobility 1, driven by the relation, so FPR_MECH_OK', () => {
    const { doc, jointId, b } = hinge();
    const c = instance(doc, 'C');
    const second = execute(c.doc, 'add_joint', { kind: 'revolute', a: { instanceId: b }, b: { instanceId: c.id }, axis: 'z' });
    const coupled = execute(second.document, 'add_drive_relation', { driver: jointId, driven: second.affected[0], ratio: 2 });
    const { envelope } = check(coupled.document);
    expect(envelope.items.map((item) => item.code)).toEqual(['FPR_MECH_OK']);
    expect(envelope.items[0]?.values).toEqual({ mobility: 1, bodies: 3, joints: 2, drives: 1 });
    expect(envelope.status).toBe('pass');
  });

  it('a motor-driven dynamics hinge is FPR_MECH_OK', () => {
    const { envelope } = check(dynamicsDoc(true, false));
    expect(envelope.items.map((item) => [item.code, item.status])).toEqual([['FPR_MECH_OK', 'pass']]);
    expect(envelope.items[0]?.values).toEqual({ mobility: 1, bodies: 2, joints: 1, drives: 1 });
  });

  it('a body pinned twice to the ground is over-constrained: fail FPR_MECH_LOCKED', () => {
    const { envelope } = check(dynamicsDoc(false, true));
    expect(envelope.status).toBe('fail');
    expect(envelope.items[0]?.code).toBe('FPR_MECH_LOCKED');
    expect(envelope.items[0]?.values['mobility']).toBe(-4);
    expect(envelope.items[0]?.ids).toEqual(['j1', 'j2']);
  });

  it('kinematic and dynamics models are each reported', () => {
    const { doc } = hinge();
    const both = { ...dynamicsDoc(true, false), joints: doc.joints, jointOrder: doc.jointOrder };
    expect(check(both).envelope.items.map((item) => item.code)).toEqual(['FPR_MECH_UNDERCONSTRAINED', 'FPR_MECH_OK']);
  });

  it('no joints: not_run FPR_MECH_NONE, unchanged document', () => {
    const doc = createEmptyDocument();
    const { envelope, document } = check(doc);
    expect(envelope.status).toBe('not_run');
    expect(envelope.items.map((item) => item.code)).toEqual(['FPR_MECH_NONE']);
    expect(document).toBe(doc);
  });

  it('dynamics model without joints is not a mechanism either', () => {
    const doc = dynamicsDoc(false, false);
    const empty = { ...doc, dynamics: { ...doc.dynamics!, joints: {} } };
    expect(check(empty).envelope.status).toBe('not_run');
  });

  it('is pure and deterministic', () => {
    const { doc } = hinge();
    const before = JSON.stringify(doc);
    const first = check(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(first.document).toBe(doc);
    expect(check(doc).envelope.inputsHash).toBe(first.envelope.inputsHash);
  });
});
