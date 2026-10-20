/** SC-F4: joint kinds beyond revolute / prismatic, limits, DOF values, cam followers. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Vec3 } from '@core/model/types';

function instanceAt(doc: CadDocument, position: Vec3): { doc: CadDocument; id: string } {
  const box = execute(doc, 'add_box', { size: [1, 1, 1] });
  const name = `part${Object.keys(box.document.components).length}`;
  const withComponent = execute(box.document, 'create_component', { name, entityIds: [box.affected[0]] }).document;
  const componentId = Object.keys(withComponent.components).at(-1);
  const instance = execute(withComponent, 'insert_instance', { componentId, position });
  return { doc: instance.document, id: instance.affected[0] ?? '' };
}

interface Motion {
  instancePositions: Record<string, Vec3>;
  instanceRotations: Record<string, Vec3>;
}

const close = (actual: readonly number[] | undefined, expected: readonly number[], digits = 9): void =>
  expected.forEach((value, i) => expect(actual?.[i]).toBeCloseTo(value, digits));

function pair(): { doc: CadDocument; ground: string; part: string } {
  const ground = instanceAt(createEmptyDocument(), [0, 0, 0]);
  const part = instanceAt(ground.doc, [10, 0, 0]);
  return { doc: part.doc, ground: ground.id, part: part.id };
}

function withJoint(params: Record<string, unknown>): { doc: CadDocument; part: string; joint: string } {
  const { doc, ground, part } = pair();
  const added = execute(doc, 'add_joint', { a: { instanceId: ground }, b: { instanceId: part }, axis: 'z', ...params });
  expect(added.affected).toHaveLength(1);
  return { doc: added.document, part, joint: added.affected[0] ?? '' };
}

const motionOf = (doc: CadDocument): Motion => execute(doc, 'evaluate_motion', {}).data as Motion;

describe('joint kinds', () => {
  it('rigid: b is welded to a and follows a moving parent', () => {
    const ground = instanceAt(createEmptyDocument(), [0, 0, 0]);
    const arm = instanceAt(ground.doc, [10, 0, 0]);
    const tool = instanceAt(arm.doc, [20, 0, 0]);
    const hinge = execute(tool.doc, 'add_joint', { kind: 'revolute', a: { instanceId: ground.id }, b: { instanceId: arm.id }, axis: 'z' });
    const weld = execute(hinge.document, 'add_joint', { kind: 'rigid', a: { instanceId: arm.id }, b: { instanceId: tool.id }, axis: 'z' });
    expect(weld.summary).toContain('0 DOF');
    const posed = execute(weld.document, 'set_joint_value', { id: hinge.affected[0], value: Math.PI / 2 }).document;
    close(motionOf(posed).instancePositions[tool.id], [0, 20, 0]);
    expect(execute(weld.document, 'set_joint_value', { id: weld.affected[0], value: 1 }).affected).toEqual([]);
  });

  it('cylindrical: rotates and slides on one axis (2 DOF)', () => {
    const { doc, part, joint } = withJoint({ kind: 'cylindrical', values: [Math.PI / 2, 3] });
    close(motionOf(doc).instancePositions[part], [0, 10, 3]);
    const slid = execute(doc, 'set_joint_value', { id: joint, value: 5, dof: 1 });
    expect(slid.summary).toContain('coordinate 1 set to 5');
    close(motionOf(slid.document).instancePositions[part], [0, 10, 5]);
  });

  it('pin_slot: the pin slides along the slot while the part turns about it', () => {
    const { doc, part } = withJoint({ kind: 'pin_slot', slotAxis: 'x', values: [Math.PI / 2, 4] });
    const motion = motionOf(doc);
    close(motion.instancePositions[part], [4, 10, 0]);
    close(motion.instanceRotations[part], [0, 0, Math.PI / 2]);
  });

  it('planar: two slides in the plane plus a rotation about its normal (3 DOF)', () => {
    const { doc, part } = withJoint({ kind: 'planar', values: [2, 3, Math.PI / 2] });
    close(motionOf(doc).instancePositions[part], [2, 13, 0]);
  });

  it('ball: three rotations about the pivot', () => {
    const { doc, part } = withJoint({ kind: 'ball', pivot: [0, 0, 0], values: [Math.PI / 2, 0, 0] });
    // the part at (10,0,0) lies on the x axis: a turn about x leaves it in place; a turn about z swings it
    close(motionOf(doc).instancePositions[part], [10, 0, 0]);
    const swung = withJoint({ kind: 'ball', values: [0, 0, Math.PI / 2] });
    close(motionOf(swung.doc).instancePositions[swung.part], [0, 10, 0]);
  });

  it('limits clamp set_joint_value and are reported in the summary', () => {
    const { doc, joint } = withJoint({ kind: 'cylindrical', limits: [{ min: -1, max: 1 }, { max: 2 }] });
    const rotated = execute(doc, 'set_joint_value', { id: joint, value: 5 });
    expect(rotated.summary).toContain('clamped from 5');
    const slid = execute(rotated.document, 'set_joint_value', { id: joint, value: -9, dof: 1 });
    expect(slid.summary).toContain('coordinate 1 set to -9');
    expect(execute(slid.document, 'set_joint_value', { id: joint, value: 9, dof: 1 }).summary).toContain('set to 2 (clamped');
  });

  it('refuses bad input without changing the document', () => {
    const { doc, ground, part } = pair();
    const base = { a: { instanceId: ground }, b: { instanceId: part }, axis: 'z' };
    for (const bad of [
      { kind: 'ball', values: [1, 2, 3, 4] },
      { kind: 'pin_slot' },
      { kind: 'cam' },
      { kind: 'cam', camJoint: 'nope', profileId: 'nope' },
      { kind: 'revolute', values: [Number.NaN] },
      { kind: 'planar', limits: [{}, {}, {}, {}] },
    ]) {
      const result = execute(doc, 'add_joint', { ...base, ...bad });
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
    const hinge = execute(doc, 'add_joint', { ...base, kind: 'revolute' });
    const noDof = execute(hinge.document, 'set_joint_value', { id: hinge.affected[0], value: 1, dof: 1 });
    expect(noDof.affected).toEqual([]);
    expect(noDof.summary).toContain('no settable coordinate 1');
    expect(execute(hinge.document, 'set_joint_value', { id: hinge.affected[0], value: 'nonsense +' }).affected).toEqual([]);
    expect(execute(hinge.document, 'set_joint_value', { id: 'missing', value: 1 }).affected).toEqual([]);
  });

  it('add_joint is pure and keeps the old signature working', () => {
    const { doc, ground, part } = pair();
    const before = JSON.stringify(doc);
    const added = execute(doc, 'add_joint', { kind: 'prismatic', a: { instanceId: ground }, b: { instanceId: part }, axis: 'x' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(added.document.jointOrder).toEqual(added.affected);
    expect(added.document.joints[added.affected[0] ?? '']).toMatchObject({ kind: 'prismatic', displacement: 0 });
  });
});

describe('cam follower', () => {
  const eccentric = (eccentricity: number, radius: number): { doc: CadDocument; follower: string; camJoint: string; profile: string } => {
    const ground = instanceAt(createEmptyDocument(), [0, 0, 0]);
    const cam = instanceAt(ground.doc, [0, 0, 0]);
    const follower = instanceAt(cam.doc, [radius + eccentricity, 0, 0]);
    const profile = execute(follower.doc, 'draw_arc', { center: [eccentricity, 0], radius });
    const hinge = execute(profile.document, 'add_joint', {
      kind: 'revolute',
      a: { instanceId: ground.id },
      b: { instanceId: cam.id },
      axis: 'z',
    });
    const lift = execute(hinge.document, 'add_joint', {
      kind: 'cam',
      a: { instanceId: ground.id },
      b: { instanceId: follower.id },
      axis: 'x',
      camJoint: hinge.affected[0],
      profileId: profile.affected[0],
    });
    expect(lift.affected).toHaveLength(1);
    return { doc: lift.document, follower: follower.id, camJoint: hinge.affected[0] ?? '', profile: profile.affected[0] ?? '' };
  };

  it('lift of an eccentric disc follows e cosθ + sqrt(R² − e² sin²θ) − (e + R)', () => {
    const [e, radius, rest] = [1, 3, 4];
    const { doc, follower, camJoint } = eccentric(e, radius);
    for (const theta of [0, 0.4, 1, 2, Math.PI, 4.5]) {
      const posed = execute(doc, 'set_joint_value', { id: camJoint, value: theta }).document;
      const lift = e * Math.cos(theta) + Math.sqrt(radius ** 2 - (e * Math.sin(theta)) ** 2) - (e + radius);
      close(motionOf(posed).instancePositions[follower], [rest + lift, 0, 0], 3);
    }
  });

  it('rejects a cam whose profile is missing, open or whose follower axis lies along the cam axis', () => {
    const { doc, follower, camJoint, profile } = eccentric(1, 3);
    const ground = Object.values(doc.joints)[0]?.a.instanceId ?? '';
    const base = { kind: 'cam', a: { instanceId: ground }, b: { instanceId: follower }, camJoint };
    expect(execute(doc, 'add_joint', { ...base, axis: 'x', profileId: 'ghost' }).summary).toContain('not found');
    expect(execute(doc, 'add_joint', { ...base, axis: 'z', profileId: profile }).summary).toContain('perpendicular');
    const line = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(execute(line.document, 'add_joint', { ...base, axis: 'x', profileId: line.affected[0] }).summary).toContain('closed polyline');
  });

  it('a cam cannot be set directly and a rectangle profile works', () => {
    const { doc, follower } = eccentric(1, 3);
    const camId = Object.values(doc.joints).find((joint) => joint.kind === 'cam')?.id ?? '';
    expect(execute(doc, 'set_joint_value', { id: camId, value: 1 }).affected).toEqual([]);
    const rect = execute(doc, 'draw_rectangle', { width: 4, height: 2 });
    const joints = Object.values(rect.document.joints);
    const hinge = joints.find((joint) => joint.kind === 'revolute');
    const ground = hinge?.a.instanceId ?? '';
    const lift = execute(rect.document, 'add_joint', {
      kind: 'cam',
      a: { instanceId: ground },
      b: { instanceId: follower },
      axis: 'x',
      camJoint: hinge?.id,
      profileId: rect.affected[0],
    });
    expect(lift.affected).toHaveLength(1);
  });
});
