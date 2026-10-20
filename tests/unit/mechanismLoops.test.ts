/** SC-F4: closed kinematic loops solved on the loop-closure equations; refusal when the loop cannot close. */
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

interface Study {
  steps: { sweepValue: number; resolvedJoints: Record<string, number>; instancePositions: Record<string, Vec3>; loopClosed?: boolean }[];
}

interface FourBar {
  doc: CadDocument;
  crankJoint: string;
  rockerJoint: string;
  rocker: string;
  /** Rocker angle (rad) at the rest pose. */
  rockerRest: number;
  lengths: { a: number; b: number; c: number; d: number };
}

/** Planar four-bar: ground pivots O2 = (0,0) and O4 = (d,0); crank a, coupler b, rocker c; rest pose at crank angle 0. */
function fourBar(a: number, b: number, c: number, d: number): FourBar {
  const x = (b * b - c * c + d * d - 2 * a * d + a * a) / (2 * (d - a)) + a;
  const pinX = x;
  const pinY = Math.sqrt(b * b - (pinX - a) ** 2);
  const ground = instanceAt(createEmptyDocument(), [0, 0, 0]);
  const crank = instanceAt(ground.doc, [a, 0, 0]);
  const coupler = instanceAt(crank.doc, [pinX, pinY, 0]);
  const rocker = instanceAt(coupler.doc, [d, 0, 0]);
  const hinge = (doc: CadDocument, from: string, to: string, pivot: Vec3, passive: boolean): { doc: CadDocument; id: string } => {
    const added = execute(doc, 'add_joint', {
      kind: 'revolute',
      a: { instanceId: from },
      b: { instanceId: to },
      axis: 'z',
      pivot,
      passive,
    });
    expect(added.affected).toHaveLength(1);
    return { doc: added.document, id: added.affected[0] ?? '' };
  };
  const j1 = hinge(rocker.doc, ground.id, crank.id, [0, 0, 0], false);
  const j2 = hinge(j1.doc, crank.id, coupler.id, [a, 0, 0], true);
  const j3 = hinge(j2.doc, coupler.id, rocker.id, [pinX, pinY, 0], true);
  const j4 = hinge(j3.doc, ground.id, rocker.id, [d, 0, 0], true);
  return {
    doc: j4.doc,
    crankJoint: j1.id,
    rockerJoint: j4.id,
    rocker: rocker.id,
    rockerRest: Math.atan2(pinY, pinX - d),
    lengths: { a, b, c, d },
  };
}

/** Freudenstein: rocker angle psi (from the ground line) for crank angle phi, on the branch that contains `rest`. */
function freudenstein({ a, b, c, d }: FourBar['lengths'], phi: number, rest: number): number {
  const k3 = (a * a - b * b + c * c + d * d) / (2 * a * c);
  const p = d / a - Math.cos(phi);
  const q = -Math.sin(phi);
  const r = (d / c) * Math.cos(phi) - k3;
  const half = Math.acos(r / Math.hypot(p, q));
  const candidates = [Math.atan2(q, p) + half, Math.atan2(q, p) - half];
  return candidates.reduce((best, psi) => (Math.abs(psi - rest) < Math.abs(best - rest) ? psi : best));
}

describe('closed loops', () => {
  it('four-bar linkage matches the Freudenstein relation over a crank sweep (< 1e-8 rad)', () => {
    const bar = fourBar(2, 4, 3.5, 5);
    const study = execute(bar.doc, 'motion_study', { mode: 'joint', target: bar.crankJoint, start: 0, end: 2.4, steps: 13 }).data as Study;
    expect(study.steps).toHaveLength(13);
    for (const step of study.steps) {
      const expected = freudenstein(bar.lengths, step.sweepValue, bar.rockerRest) - bar.rockerRest;
      expect(step.loopClosed).toBe(true);
      expect(step.resolvedJoints[bar.rockerJoint]).toBeCloseTo(expected, 8);
    }
  });

  it('a single evaluate_motion poses the whole chain: rocker origin turns about its ground pivot', () => {
    const bar = fourBar(2, 4, 3.5, 5);
    const posed = execute(bar.doc, 'set_joint_value', { id: bar.crankJoint, value: 0.5 }).document;
    const result = execute(posed, 'evaluate_motion', {});
    const data = result.data as { loop: { closed: boolean; loops: number }; instanceRotations: Record<string, Vec3> };
    expect(data.loop).toMatchObject({ closed: true, loops: 1 });
    expect(result.summary).toContain('loop closed');
    const expected = freudenstein(bar.lengths, 0.5, bar.rockerRest) - bar.rockerRest;
    expect(data.instanceRotations[bar.rocker]?.[2]).toBeCloseTo(expected, 8);
  });

  it('refuses when the loop cannot close (crank past the reach of coupler + rocker) and bake_motion leaves the document unchanged', () => {
    const bar = fourBar(2, 2, 2, 5);
    const limit = Math.acos((25 + 4 - 16) / 20);
    const open = execute(bar.doc, 'set_joint_value', { id: bar.crankJoint, value: limit + 0.1 }).document;
    const evaluated = execute(open, 'evaluate_motion', {});
    expect((evaluated.data as { loop: { closed: boolean } }).loop.closed).toBe(false);
    expect(evaluated.summary).toContain('cannot close');
    const baked = execute(open, 'bake_motion', {});
    expect(baked.affected).toEqual([]);
    expect(baked.document).toBe(open);
    expect(baked.summary).toContain('refused');
    const closed = execute(bar.doc, 'set_joint_value', { id: bar.crankJoint, value: limit - 0.1 }).document;
    expect(execute(closed, 'bake_motion', {}).affected.length).toBeGreaterThan(0);
  });

  it('drive_joint_to stops where the loop stops closing (acos(13/20))', () => {
    const bar = fourBar(2, 2, 2, 5);
    const driven = execute(bar.doc, 'drive_joint_to', { jointId: bar.crankJoint, target: 3, tolerance: 1e-5, samples: 40 });
    const data = driven.data as { reached: number; stopped: boolean; reason: string };
    expect(data.stopped).toBe(true);
    expect(data.reason).toBe('loop_open');
    expect(data.reached).toBeCloseTo(Math.acos(13 / 20), 4);
    expect(data.reached).toBeLessThanOrEqual(Math.acos(13 / 20) + 1e-9);
    expect(driven.document.joints[bar.crankJoint]).toMatchObject({ kind: 'revolute', angle: data.reached });
  });

  it('slider-crank matches x = r cosθ + sqrt(l² − r² sin²θ)', () => {
    const [r, l] = [2, 5];
    const ground = instanceAt(createEmptyDocument(), [0, 0, 0]);
    const crank = instanceAt(ground.doc, [r, 0, 0]);
    const rod = instanceAt(crank.doc, [r + l, 0, 0]);
    const slider = instanceAt(rod.doc, [r + l, 0, 0]);
    const add = (doc: CadDocument, params: Record<string, unknown>): { doc: CadDocument; id: string } => {
      const added = execute(doc, 'add_joint', { axis: 'z', ...params });
      expect(added.affected).toHaveLength(1);
      return { doc: added.document, id: added.affected[0] ?? '' };
    };
    const j1 = add(slider.doc, { kind: 'revolute', a: { instanceId: ground.id }, b: { instanceId: crank.id }, pivot: [0, 0, 0] });
    const j2 = add(j1.doc, { kind: 'revolute', a: { instanceId: crank.id }, b: { instanceId: rod.id }, pivot: [r, 0, 0], passive: true });
    const j3 = add(j2.doc, {
      kind: 'revolute',
      a: { instanceId: rod.id },
      b: { instanceId: slider.id },
      pivot: [r + l, 0, 0],
      passive: true,
    });
    const j4 = add(j3.doc, {
      kind: 'prismatic',
      a: { instanceId: ground.id },
      b: { instanceId: slider.id },
      axis: 'x',
      pivot: [r + l, 0, 0],
      passive: true,
    });
    const study = execute(j4.doc, 'motion_study', { mode: 'joint', target: j1.id, start: 0, end: 2 * Math.PI, steps: 25 }).data as Study;
    for (const step of study.steps) {
      const theta = step.sweepValue;
      const expected = r * Math.cos(theta) + Math.sqrt(l * l - (r * Math.sin(theta)) ** 2);
      expect(step.loopClosed).toBe(true);
      expect(step.instancePositions[slider.id]?.[0]).toBeCloseTo(expected, 8);
      expect(step.instancePositions[slider.id]?.[1]).toBeCloseTo(0, 8);
    }
  });

  it('reports a loop without passive joints instead of guessing, and rejects solutions outside joint limits', () => {
    const bar = fourBar(2, 4, 3.5, 5);
    const frozen = {
      ...bar.doc,
      joints: Object.fromEntries(Object.entries(bar.doc.joints).map(([id, joint]) => [id, { ...joint, passive: false }])),
    };
    const stuck = execute({ ...frozen, joints: { ...frozen.joints } } as CadDocument, 'set_joint_value', {
      id: bar.crankJoint,
      value: 0.5,
    });
    const report = (execute(stuck.document, 'evaluate_motion', {}).data as { loop: { closed: boolean; message: string } }).loop;
    expect(report.closed).toBe(false);
    expect(report.message).toContain('mark a joint passive');
    const tight = { ...bar.doc, joints: { ...bar.doc.joints } };
    const rockerJoint = tight.joints[bar.rockerJoint];
    if (rockerJoint) tight.joints[bar.rockerJoint] = { ...rockerJoint, limits: [{ min: -0.001, max: 0.001 }] };
    const posed = execute(tight, 'set_joint_value', { id: bar.crankJoint, value: 0.5 }).document;
    const limited = (execute(posed, 'evaluate_motion', {}).data as { loop: { closed: boolean; message: string } }).loop;
    expect(limited.closed).toBe(false);
    expect(limited.message).toContain('limits');
  });
});
