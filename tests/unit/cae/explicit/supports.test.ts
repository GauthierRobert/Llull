/** Symmetry supports and imposed motions of an explicit job (RS-8, PHY-19 TECHNICAL_SPEC §13.10). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { buildExplicitJob, type ExplicitJob } from '@cae/index';
import { explicitErrors } from '@cae/explicit/model';
import { barModel, code, must } from './support';

const jobOf = (doc: CadDocument, analysisId: string): ExplicitJob => {
  const built = buildExplicitJob(doc, analysisId, null);
  if (!built.ok) throw new Error(built.message);
  return built.job;
};
const refusal = (doc: CadDocument, analysisId: string): string | null => {
  const built = buildExplicitJob(doc, analysisId, null);
  return built.ok ? null : built.code;
};
const heldNodes = (flags: readonly number[], axis: number): number[] =>
  flags.flatMap((value, k) => (value === 1 && k % 3 === axis ? [Math.floor(k / 3)] : []));

describe('symmetry supports in the explicit job', () => {
  const bar = barModel({ size: 5 });
  const symmetry = (doc: CadDocument, entityId: string, target: Record<string, unknown>): CadDocument =>
    must(doc, 'add_fea_constraint', { analysisId: bar.analysisId, name: 'sym', kind: 'symmetry', target: { entityId, ...target } })
      .document;

  it('holds the translation normal to the plane on a solid part, purely', () => {
    const doc = symmetry(bar.doc, bar.barId, { facesNear: [[0, 5, 100]] });
    const before = structuredClone(doc);
    const job = jobOf(doc, bar.analysisId);
    expect(doc).toEqual(before);
    const onPlane = job.mesh.nodes.flatMap((value, k) => (k % 3 === 0 && value === 0 ? [Math.floor(k / 3)] : []));
    expect(heldNodes(job.fixed, 0)).toEqual(onPlane);
    expect(heldNodes(job.fixed, 1)).toEqual([]);
    expect(heldNodes(job.fixed, 2)).toEqual([]);
    expect(job.fixedRotation).toEqual([]);
  });

  it('also holds the two in-plane rotations of shell nodes', () => {
    const plate = must(bar.doc, 'add_box', { size: [50, 50, 2], position: [-20, -20, -10], anchor: 'min' });
    const plateId = plate.affected[0] ?? '';
    let doc = must(plate.document, 'assign_material', { materialName: 'steel_like', entityIds: [plateId] }).document;
    doc = must(doc, 'set_part_idealization', { analysisId: bar.analysisId, entityId: plateId }).document;
    doc = must(doc, 'set_explicit_shell', { analysisId: bar.analysisId, entityId: plateId, shell: true }).document;
    const job = jobOf(symmetry(doc, plateId, { facesNear: [[-20, 5, -9]] }), bar.analysisId);
    const edge = heldNodes(job.fixed, 0);
    expect(edge.length).toBeGreaterThan(1);
    expect(edge.every((node) => job.mesh.nodes[3 * node] === -20)).toBe(true);
    expect(heldNodes(job.fixedRotation, 0)).toEqual([]);
    expect(heldNodes(job.fixedRotation, 1)).toEqual(edge);
    expect(heldNodes(job.fixedRotation, 2)).toEqual(edge);
  });

  it('refuses a symmetry support without one axis-aligned plane', () => {
    expect(refusal(symmetry(bar.doc, bar.barId, { pointsNear: [[0, 0, 0]] }), bar.analysisId)).toBe('EXP_CONSTRAINT_UNSUPPORTED');
    expect(
      refusal(
        symmetry(bar.doc, bar.barId, {
          facesNear: [
            [0, 5, 100],
            [5, 0, 100],
          ],
        }),
        bar.analysisId,
      ),
    ).toBe('EXP_CONSTRAINT_UNSUPPORTED');
  });
});

describe('add_imposed_motion / delete_imposed_motion', () => {
  const bar = barModel({ size: 5 });
  const params = {
    analysisId: bar.analysisId,
    name: 'pull',
    target: { entityId: bar.barId, facesNear: [[5, 5, 0]] },
    dof: 'z',
    curve: [
      [0, 0],
      [1e-5, -10],
    ],
    unit: 'm/s',
  };

  it('stores the curve in the case units, purely, keeps it across controls and passes the face nodes to the job', () => {
    const before = structuredClone(bar.doc);
    const added = must(bar.doc, 'add_imposed_motion', params);
    expect(bar.doc).toEqual(before);
    const motionId = added.affected[1] ?? '';
    const motion = added.document.analysis?.cases[bar.analysisId]?.explicit?.imposedMotions?.[motionId];
    expect(motion).toMatchObject({
      kind: 'velocity',
      dof: 'z',
      curve: [
        [0, 0],
        [1e-5, -10_000],
      ],
    });
    const controls = must(added.document, 'set_explicit_controls', {
      analysisId: bar.analysisId,
      endTime: { value: 1e-4, unit: 's' },
      historyInterval: { value: 1e-6, unit: 's' },
      mesh: { kind: 'structured_hex', size: 5 },
    });
    expect(explicitErrors(JSON.parse(JSON.stringify(controls.document)) as Record<string, unknown>)).toEqual([]);
    const job = jobOf(controls.document, bar.analysisId);
    const bottom = job.mesh.nodes.flatMap((value, k) => (k % 3 === 2 && value === 0 ? [Math.floor(k / 3)] : []));
    expect(job.imposedMotions).toEqual([
      {
        name: 'pull',
        nodes: bottom,
        dof: 2,
        kind: 'velocity',
        curve: [
          [0, 0],
          [1e-5, -10_000],
        ],
      },
    ]);
    const displaced = must(bar.doc, 'add_imposed_motion', {
      ...params,
      kind: 'displacement',
      curve: [
        [0, 0],
        [1e-4, 0.5],
      ],
      unit: 'mm',
    });
    const stored = Object.values(displaced.document.analysis?.cases[bar.analysisId]?.explicit?.imposedMotions ?? {})[0];
    expect(stored).toMatchObject({
      kind: 'displacement',
      curve: [
        [0, 0],
        [1e-4, 0.5],
      ],
    });
    const removed = must(added.document, 'delete_imposed_motion', { analysisId: bar.analysisId, motionId });
    expect(removed.document.analysis?.cases[bar.analysisId]?.explicit?.imposedMotions).toEqual({});
  });

  it('counts as an excitation: a case with only an imposed motion builds', () => {
    const still = must(bar.doc, 'set_initial_velocity', {
      analysisId: bar.analysisId,
      entityId: bar.barId,
      velocity: { vector: [0, 0, 0], unit: 'mm/s' },
    });
    expect(refusal(still.document, bar.analysisId)).toBe('EXP_NO_EXCITATION');
    const pulled = must(still.document, 'add_imposed_motion', params).document;
    expect(jobOf(pulled, bar.analysisId).imposedMotions).toHaveLength(1);
  });

  it('refuses bad curves, units and targets, unknown ids, missing controls and a dof driven twice', () => {
    const run = (overrides: Record<string, unknown>): string | undefined =>
      code(execute(bar.doc, 'add_imposed_motion', { ...params, ...overrides }));
    expect(run({ curve: [] })).toBe('EXP_CURVE_INVALID');
    expect(
      run({
        curve: [
          [1, 0],
          [1, 2],
        ],
      }),
    ).toBe('EXP_CURVE_INVALID');
    expect(run({ unit: 'kg' })).toBe('EXP_PARAM_INVALID');
    expect(run({ kind: 'displacement', unit: 'm/s' })).toBe('EXP_PARAM_INVALID');
    expect(run({ target: { entityId: bar.barId } })).toBe('EXP_PARAM_INVALID');
    expect(run({ target: { entityId: 'nope', facesNear: [[0, 0, 0]] } })).toBe('EXP_TARGET_NOT_IN_CASE');
    expect(code(execute(bar.doc, 'delete_imposed_motion', { analysisId: bar.analysisId, motionId: 'im-0.0' }))).toBe(
      'EXP_IMPOSED_MOTION_NOT_FOUND',
    );
    const fresh = must(bar.doc, 'create_analysis', { name: 'b', analysisType: 'explicit_dynamics' });
    expect(code(execute(fresh.document, 'add_imposed_motion', { ...params, analysisId: fresh.affected[0] }))).toBe('EXP_CONTROLS_MISSING');
    expect(code(execute(fresh.document, 'delete_imposed_motion', { analysisId: fresh.affected[0], motionId: 'x' }))).toBe(
      'EXP_CONTROLS_MISSING',
    );
    const twice = must(must(bar.doc, 'add_imposed_motion', params).document, 'add_imposed_motion', { ...params, name: 'again' }).document;
    expect(refusal(twice, bar.analysisId)).toBe('EXP_CONSTRAINT_UNSUPPORTED');
  });
});
