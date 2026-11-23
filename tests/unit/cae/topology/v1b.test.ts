/** TOP-V1b: displacement constraints for min_volume (objective, job rows, report, persistence) and massG of the solid. */
import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { FeTopologyArtifact, TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { buildTopologyArtifact, buildTopologyJob } from '@cae/index';
import { fieldBytes } from '@cae/topology/artifact';
import { topologyInputHash } from '@cae/topology/hash';
import { artifactStore, code, contextWith, data, jobOf, mbbModel, solveAndRecord, studyOf, type Model } from './support';

type Params = Record<string, unknown>;

const tip = (model: Model, extra: Params = {}): Params => ({
  target: { entityId: model.entityId, pointsNear: [[0, 20, 0]] },
  component: 'uy',
  maxDisplacement: 0.5,
  ...extra,
});
const withConstraints = (model: Model, constraints: Params[], doc: CadDocument = model.doc): ReturnType<typeof execute> =>
  execute(doc, 'set_topology_objective', {
    studyId: model.studyId,
    objective: { kind: 'min_volume', maxCompliance: 250, displacementConstraints: constraints },
  });
const study = (doc: CadDocument, model: Model): TopologyStudy => studyOf(doc, model.analysisId, model.studyId);

describe('displacement constraints of min_volume', () => {
  const model = mbbModel();

  it('stores the constraints with a default label, reports them as rules and builds the solver rows (grid dofs, analysis units)', () => {
    const before = JSON.stringify(model.doc);
    const result = withConstraints(model, [tip(model)]);
    expect(JSON.stringify(model.doc)).toBe(before);
    expect(result.affected).toEqual([model.studyId]);
    expect(result.summary).toContain('1 displacement constraint(s) (uy-1)');
    const objective = study(result.document, model).objective;
    expect(objective).toMatchObject({ kind: 'min_volume', maxCompliance: 250 });
    expect(objective.kind === 'min_volume' && objective.displacementConstraints).toEqual([
      { label: 'uy-1', target: { entityId: model.entityId, pointsNear: [[0, 20, 0]] }, component: 'uy', maxDisplacement: 0.5 },
    ]);
    expect(study(result.document, model).settings.optimizer).toBe('mma');
    const rules = data<{ rules: string[] }>(execute(result.document, 'topology_report', { studyId: model.studyId })).rules;
    expect(rules[0]).toContain("displacement constraint 'uy-1': |mean uy| of");
    expect(rules[0]).toContain('every load case');
    const job = jobOf({ ...model, doc: result.document });
    // node (0, 20) of the 60 x 20 grid = 61 * 20, y component of the 2-dof node
    expect(job.objective).toEqual({
      kind: 'min_volume',
      maxCompliance: 250,
      displacementConstraints: [{ label: 'uy-1', loadCase: 'LC1', dofs: [2 * 61 * 20 + 1], maxDisplacement: 0.5 }],
    });
  });

  it('a constraint on one named load case and a face target (mean over its nodes) keep the label', () => {
    const result = withConstraints(model, [
      tip(model, { label: 'left-ux', component: 'ux', loadCase: 'LC1', target: { entityId: model.entityId, facesNear: [[0, 10, 0.5]] } }),
    ]);
    const rows = jobOf({ ...model, doc: result.document }).objective;
    const [row] = rows.kind === 'min_volume' ? (rows.displacementConstraints ?? []) : [];
    expect(row).toMatchObject({ label: 'left-ux', loadCase: 'LC1' });
    expect(row?.dofs).toHaveLength(21);
    expect(row?.dofs.every((dof) => dof % 2 === 0)).toBe(true);
  });

  it('create_topology_study takes the constraints; the input hash moves with them (a recorded result goes stale)', () => {
    const made = execute(model.doc, 'create_topology_study', {
      analysisId: model.analysisId,
      name: 'stiff tip',
      designDomain: [model.entityId],
      dimension: 2,
      voxel: 2,
      volumeFraction: 0.5,
      objective: { kind: 'min_volume', maxCompliance: 300, displacementConstraints: [tip(model, { label: 'tip' })] },
    });
    expect(made.rejected).not.toBe(true);
    expect(made.summary).toContain('1 displacement constraint(s)');
    const created = studyOf(made.document, model.analysisId, made.affected[0] ?? '');
    const looser = withConstraints(model, [tip(model, { maxDisplacement: 0.6 })]);
    const tighter = withConstraints(model, [tip(model, { maxDisplacement: 0.4 })]);
    const [a, b] = [looser, tighter].map((r) => topologyInputHash(r.document, study(r.document, model)));
    expect(a).not.toBe(b);
    expect(topologyInputHash(made.document, created)).toHaveLength(64);
  });

  it('refuses a bad limit, a target without a point, an entity outside the domain and a duplicate label (unchanged document)', () => {
    const outsider = { ...tip(model), target: { entityId: 'nope', pointsNear: [[0, 0, 0]] } };
    for (const [constraints, text] of [
      [[tip(model, { maxDisplacement: 0 })], 'maxDisplacement 0 must be > 0'],
      [[tip(model, { target: { entityId: model.entityId } })], 'at least one of facesNear'],
      [[outsider], 'not in the design domain'],
      [[tip(model, { label: 'a' }), tip(model, { label: 'a' })], "duplicate displacement constraint label 'a'"],
    ] as const) {
      const result = withConstraints(model, [...constraints]);
      expect(code(result)).toBe('TOP_SETUP_INVALID');
      expect(result.summary).toContain(text);
      expect(result.document).toBe(model.doc);
    }
    const create = execute(model.doc, 'create_topology_study', {
      analysisId: model.analysisId,
      name: 'x',
      designDomain: [model.entityId],
      dimension: 2,
      voxel: 2,
      volumeFraction: 0.5,
      objective: { kind: 'min_volume', maxCompliance: 300, displacementConstraints: [tip(model, { maxDisplacement: -1 })] },
    });
    expect(code(create)).toBe('TOP_SETUP_INVALID');
  });

  it('the job refuses an unknown load case, a component normal to the 2D plane and a target that maps to no node', () => {
    const jobCode = (constraint: Params): string | undefined => {
      const doc = withConstraints(model, [constraint]).document;
      const built = buildTopologyJob(doc, study(doc, model));
      return built.ok ? undefined : `${built.code}: ${built.message}`;
    };
    expect(jobCode(tip(model, { loadCase: 'LC9' }))).toMatch(/^TOP_SETUP_INVALID: displacement constraint 'uy-1': load case 'LC9'/);
    expect(jobCode(tip(model, { component: 'uz' }))).toMatch(/^TOP_TARGET_UNMAPPED: .*normal of the 2D grid plane/);
    expect(jobCode(tip(model, { target: { entityId: model.entityId, pointsNear: [[900, 900, 0]] } }))).toMatch(/^TOP_TARGET_UNMAPPED/);
  });

  it('persists, loads a study written before the constraints, and rejects malformed constraints on load', () => {
    const set = withConstraints(model, [tip(model, { loadCase: 'LC1' })]).document;
    expect(study(deserializeDocument(serializeDocument(set)), model)).toEqual(study(set, model));
    const edit = (doc: CadDocument, change: (objective: Record<string, unknown>) => void): Error | null => {
      const envelope = JSON.parse(serializeDocument(doc)) as {
        document: { analysis: { cases: Record<string, { topology: Record<string, { objective: Record<string, unknown> }> }> } };
      };
      change(envelope.document.analysis.cases[model.analysisId]?.topology[model.studyId]?.objective ?? {});
      try {
        deserializeDocument(JSON.stringify(envelope));
        return null;
      } catch (error) {
        return error as Error;
      }
    };
    // a min_volume study of the earlier format has no displacementConstraints key
    const legacy = execute(model.doc, 'set_topology_objective', {
      studyId: model.studyId,
      objective: { kind: 'min_volume', maxCompliance: 250 },
    }).document;
    expect(study(legacy, model).objective).not.toHaveProperty('displacementConstraints');
    expect(edit(legacy, () => undefined)).toBeNull();
    expect(study(deserializeDocument(serializeDocument(legacy)), model).objective).toEqual(study(legacy, model).objective);
    for (const mutate of [
      (o: Record<string, unknown>) => (o['displacementConstraints'] = 'x'),
      (o: Record<string, unknown>) => (o['displacementConstraints'] = [{}]),
      (o: Record<string, unknown>) =>
        (o['displacementConstraints'] = [{ label: 'a', component: 'uw', maxDisplacement: 1, target: { entityId: 'e' } }]),
      (o: Record<string, unknown>) =>
        (o['displacementConstraints'] = [{ label: 'a', component: 'ux', maxDisplacement: -1, target: { entityId: 'e' } }]),
    ])
      expect(edit(set, mutate)?.message).toMatch(/displacementConstraints/);
    expect(edit(model.doc, (o) => (o['displacementConstraints'] = []))?.message).toMatch(/displacementConstraints/);
  });

  it('a displacement row of the solver is kept with its label in the summary and fails check_topology when unsatisfied', () => {
    const doc = withConstraints(model, [tip(model, { label: 'tip' })]).document;
    const job = jobOf({ ...model, doc });
    const field = Float32Array.from({ length: 1200 }, (_, n) => (n % 60 < 36 ? 1 : 0));
    const constraints = [
      { name: 'compliance', value: 200, limit: 250, satisfied: true },
      { name: 'displacement', label: 'tip', value: 0.9, limit: 0.5, satisfied: false },
    ] as const;
    const artifact = buildTopologyArtifact(
      job,
      fieldBytes(field),
      {
        compliance: 200,
        perLoadCase: { LC1: 200 },
        iterations: 3,
        status: 'converged',
        history: [],
        device: 'cpu',
        deterministic: true,
        version: 't',
        optimizer: 'mma',
        constraints,
      },
      'topopt',
    ) as FeTopologyArtifact;
    const store = artifactStore();
    const ctx = contextWith(store.port);
    const recorded = execute(doc, 'record_topology_result', { studyId: model.studyId, fieldHash: store.put(artifact) }, ctx);
    expect(recorded.rejected).not.toBe(true);
    expect(study(recorded.document, model).result?.constraints).toEqual(constraints);
    const report = data<{ result: { constraints: unknown[] } }>(
      execute(recorded.document, 'topology_report', { studyId: model.studyId }, ctx),
    );
    expect(report.result.constraints).toEqual(constraints);
    const check = data<{ items: Array<{ code: string; message: string }> }>(
      execute(recorded.document, 'check_topology', { studyId: model.studyId }, ctx),
    );
    expect(check.items.find((item) => item.code === 'TOP_CONSTRAINT_VIOLATED')?.message).toContain("displacement 'tip' 0.9");
  });
});

describe('massG', () => {
  const model = mbbModel();
  const solved = solveAndRecord(model);

  it('is the thresholded volume times the material density (g per cubic document unit), in the summary, the report and the record text', () => {
    const summary = study(solved.doc, model).result;
    const density = solved.doc.materials[solved.doc.entities[model.entityId]?.materialId ?? '']?.density ?? 0;
    expect(density).toBeGreaterThan(0);
    expect(summary?.massG).toBeCloseTo((summary?.thresholdedVolume ?? 0) * density, 9);
    expect(summary?.massG).toBeGreaterThan(0);
    expect(solved.result.summary).toMatch(/solid volume [\d.e+-]+ mm\^3 \([\d.e+-]+ g\)/);
    const report = execute(solved.doc, 'topology_report', { studyId: model.studyId }, contextWith(solved.store.port));
    expect(data<{ result: { massG: number } }>(report).result.massG).toBe(summary?.massG);
    expect(report.summary).toContain(' g)');
  });

  it('a record written before massG stays solved, and a material without density gives no massG', () => {
    const ctx = contextWith(solved.store.port);
    const record = study(solved.doc, model).result;
    const { massG, ...older } = record ?? ({} as NonNullable<typeof record>);
    void massG;
    const analysisCase = solved.doc.analysis?.cases[model.analysisId];
    if (analysisCase === undefined || record === undefined) throw new Error('no case');
    const aged: CadDocument = {
      ...solved.doc,
      analysis: {
        ...(solved.doc.analysis as NonNullable<CadDocument['analysis']>),
        cases: {
          ...solved.doc.analysis?.cases,
          [model.analysisId]: {
            ...analysisCase,
            topology: { ...analysisCase.topology, [model.studyId]: { ...study(solved.doc, model), result: older } },
          },
        },
      },
    };
    expect(data<{ state: string }>(execute(aged, 'topology_report', { studyId: model.studyId }, ctx)).state).toBe('solved');
    const materialId = solved.doc.entities[model.entityId]?.materialId ?? '';
    const material = solved.doc.materials[materialId];
    if (material === undefined) throw new Error('no material');
    const light: CadDocument = { ...solved.doc, materials: { ...solved.doc.materials, [materialId]: { ...material, density: 0 } } };
    const report = data<{ state: string; result: Record<string, unknown> }>(
      execute(light, 'topology_report', { studyId: model.studyId }, ctx),
    );
    expect(report.state).toBe('solved');
    expect(report.result).not.toHaveProperty('massG');
  });
});
