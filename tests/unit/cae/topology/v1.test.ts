/**
 * TOP-V1 (TECHNICAL_SPEC 15): set_topology_objective (min_volume), set_topology_settings optimizer / projection / manufacturing (extrusion, minimum
 * member rule), the job they produce (pressure and gravity loads, effective radius, grid axis of the extrusion, objective), the report rules and the
 * V1 summary fields (optimizer, objective, constraints) with TOP_CONSTRAINT_VIOLATED in check_topology.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeTopologyArtifact, TopologyStudy } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { buildTopologyArtifact, buildTopologyJob, type TopologyJob } from '@cae/index';
import { fieldBytes } from '@cae/topology/artifact';
import { topologyInputHash, topologySettingsHash } from '@cae/topology/hash';
import { pressureLoad } from '@cae/topology/loads';
import { artifactStore, code, contextWith, data, jobOf, mbbModel, solveAndRecord, studyOf, type Model } from './support';

type Params = Record<string, unknown>;

const settings = (model: Model, params: Params): ReturnType<typeof execute> =>
  execute(model.doc, 'set_topology_settings', { studyId: model.studyId, ...params });
const objective = (doc: CadDocument, studyId: string, params: Params): ReturnType<typeof execute> =>
  execute(doc, 'set_topology_objective', { studyId, objective: params });
const study = (doc: CadDocument, model: Model): TopologyStudy => studyOf(doc, model.analysisId, model.studyId);
const sum = (values: ArrayLike<number>): number => Array.from(values).reduce((total, value) => total + value, 0);

/** A new static analysis on the MBB plate with the given supports and loads, and a 2D study over it. */
function analysisOn(
  base: Model,
  setup: { constraints?: Params[]; loads?: Params[]; study?: Params },
): { doc: CadDocument; studyId: string } {
  let doc = base.doc;
  const created = execute(doc, 'create_analysis', { name: 'v1', analysisType: 'static' });
  doc = created.document;
  const analysisId = created.affected[0] ?? '';
  doc = execute(doc, 'set_part_idealization', { analysisId, entityId: base.entityId, idealization: 'solid' }).document;
  for (const constraint of setup.constraints ?? [])
    doc = execute(doc, 'add_fea_constraint', { analysisId, name: 'c', ...constraint }).document;
  for (const load of setup.loads ?? []) doc = execute(doc, 'add_fea_load', { analysisId, name: 'l', ...load }).document;
  const made = execute(doc, 'create_topology_study', {
    analysisId,
    name: 's',
    designDomain: [base.entityId],
    dimension: 2,
    voxel: 1,
    volumeFraction: 0.5,
    ...setup.study,
  });
  return { doc: made.document, studyId: made.affected[0] ?? '' };
}

const okJob = (doc: CadDocument, studyId: string): TopologyJob => {
  const analysisId = Object.keys(doc.analysis?.cases ?? {}).find((id) => doc.analysis?.cases[id]?.topology?.[studyId] !== undefined) ?? '';
  const result = buildTopologyJob(doc, studyOf(doc, analysisId, studyId));
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.job;
};

describe('set_topology_objective', () => {
  const model = mbbModel();

  it('switches to min_volume, sets optimizer mma and reads back in the job; a solved study becomes stale', () => {
    const before = JSON.stringify(model.doc);
    const result = objective(model.doc, model.studyId, { kind: 'min_volume', maxCompliance: 250 });
    expect(JSON.stringify(model.doc)).toBe(before);
    expect(result.affected).toEqual([model.studyId]);
    const changed = study(result.document, model);
    expect(changed.objective).toEqual({ kind: 'min_volume', maxCompliance: 250, unit: 'N*mm', loadCaseWeights: {} });
    expect(changed.settings.optimizer).toBe('mma');
    expect(result.summary).toContain('switched to mma');
    const job = okJob(result.document, model.studyId);
    expect(job.objective).toEqual({ kind: 'min_volume', maxCompliance: 250 });
    expect(job.settings.optimizer).toBe('mma');
    // back to min_compliance with weights; the optimizer stays mma
    const back = objective(result.document, model.studyId, { kind: 'min_compliance', loadCaseWeights: { LC1: 2 } });
    expect(study(back.document, model).objective).toEqual({ kind: 'min_compliance', loadCaseWeights: { LC1: 2 } });
    expect(study(back.document, model).settings.optimizer).toBe('mma');
    expect(okJob(back.document, model.studyId).objective).toEqual({ kind: 'min_compliance' });
    const solved = solveAndRecord(model);
    const stale = objective(solved.doc, model.studyId, { kind: 'min_volume', maxCompliance: 250 });
    expect(stale.summary).toContain('now stale');
    expect(
      data<{ state: string }>(execute(stale.document, 'topology_report', { studyId: model.studyId }, contextWith(solved.store.port))).state,
    ).toBe('stale');
  });

  it.each([
    ['an unknown study', 'ts-0.0', { kind: 'min_volume', maxCompliance: 1 }, 'TOP_STUDY_NOT_FOUND'],
    ['maxCompliance 0', undefined, { kind: 'min_volume', maxCompliance: 0 }, 'TOP_SETUP_INVALID'],
    ['a weight 0', undefined, { kind: 'min_volume', maxCompliance: 1, loadCaseWeights: { LC1: 0 } }, 'TOP_SETUP_INVALID'],
    ['the unchanged objective', undefined, { kind: 'min_compliance' }, 'TOP_SETUP_INVALID'],
  ])('refuses %s', (_name, studyId, params, expected) => {
    const result = objective(model.doc, studyId ?? model.studyId, params);
    expect(code(result)).toBe(expected);
    expect(result.document).toBe(model.doc);
  });

  it('create_topology_study takes a min_volume objective and sets mma; the job refuses oc on it', () => {
    const params = {
      analysisId: model.analysisId,
      name: 'light',
      designDomain: [model.entityId],
      dimension: 2,
      voxel: 2,
      volumeFraction: 0.5,
    };
    const made = execute(model.doc, 'create_topology_study', { ...params, objective: { kind: 'min_volume', maxCompliance: 300 } });
    const created = studyOf(made.document, model.analysisId, made.affected[0] ?? '');
    expect(created.objective).toMatchObject({ kind: 'min_volume', maxCompliance: 300, unit: 'N*mm' });
    expect(created.settings.optimizer).toBe('mma');
    expect(made.summary).toContain('min_volume');
    expect(code(execute(model.doc, 'create_topology_study', { ...params, objective: { kind: 'min_volume', maxCompliance: -1 } }))).toBe(
      'TOP_SETUP_INVALID',
    );
    const forced = execute(made.document, 'set_topology_settings', { studyId: created.id, optimizer: 'oc' });
    expect(code(forced)).toBe('TOP_OPTIMIZER_MISMATCH');
    const job = buildTopologyJob(made.document, { ...created, settings: { ...created.settings, optimizer: 'oc' } });
    expect(job).toMatchObject({ ok: false, code: 'TOP_OPTIMIZER_MISMATCH' });
  });
});

describe('set_topology_settings V1: optimizer, projection, manufacturing', () => {
  const model = mbbModel();

  it('accepts mma and a projection on the density filter, hashes the projection and clears it with null', () => {
    const result = settings(model, { optimizer: 'mma', filter: { kind: 'density' }, projection: { beta: 8 } });
    expect(result.affected).toEqual([model.studyId]);
    const changed = study(result.document, model);
    expect(changed.settings.optimizer).toBe('mma');
    expect(changed.settings.projection?.beta).toEqual({ value: 8, source: 'set_topology_settings', defaulted: false });
    expect(changed.settings.projection?.eta).toMatchObject({ value: 0.5, defaulted: true });
    expect(changed.settings.projection?.betaStart).toMatchObject({ value: 1, defaulted: true });
    expect(changed.settings.projection?.betaEvery).toMatchObject({ value: 50, defaulted: true });
    expect(result.summary).toContain('projection beta 1 -> 8');
    const plain = study(settings(model, { filter: { kind: 'density' } }).document, model);
    expect(topologySettingsHash(changed.settings)).not.toBe(topologySettingsHash({ ...plain.settings, optimizer: 'mma' }));
    const withoutProjection = { ...changed.settings };
    delete withoutProjection.projection;
    expect(topologySettingsHash(withoutProjection)).toBe(topologySettingsHash({ ...plain.settings, optimizer: 'mma' }));
    const job = okJob(result.document, model.studyId);
    expect(job.settings.projection).toEqual({ beta: 8, eta: 0.5, betaStart: 1, betaEvery: 50 });
    const cleared = execute(result.document, 'set_topology_settings', { studyId: model.studyId, projection: null });
    expect(study(cleared.document, model).settings.projection).toBeUndefined();
    expect(okJob(cleared.document, model.studyId).settings).not.toHaveProperty('projection');
    const defaults = execute(cleared.document, 'set_topology_settings', { studyId: model.studyId, projection: {} });
    expect(study(defaults.document, model).settings.projection?.beta).toMatchObject({ value: 16, defaulted: true });
  });

  it('sets the extrusion axis and the minimum member rule, which raises the effective filter radius', () => {
    const result = settings(model, { manufacturing: { symmetry: [], extrusion: { axis: 'y' }, minMemberSize: 4 } });
    const changed = study(result.document, model);
    expect(changed.manufacturing).toEqual({ symmetry: [], extrusion: { axis: 'y' }, minMemberSize: 4 });
    expect(result.summary).toContain('extrusion along y');
    expect(result.summary).toContain('min member 4 mm');
    const job = okJob(result.document, model.studyId);
    expect(job.settings.extrusion).toBe('y');
    expect(job.settings.filter.radiusVoxels).toBe(2);
    expect(job.settings.minMemberRule).toEqual({ minMemberSize: 4, radiusVoxels: 2, raised: true });
    const wide = settings(model, { filter: { radius: 3 }, manufacturing: { symmetry: [], minMemberSize: 4 } });
    expect(okJob(wide.document, model.studyId).settings.minMemberRule).toEqual({ minMemberSize: 4, radiusVoxels: 3, raised: false });
    expect(okJob(wide.document, model.studyId).settings).not.toHaveProperty('extrusion');
    expect(jobOf(model).settings).not.toHaveProperty('minMemberRule');
  });

  it.each([
    ['a projection on the sensitivity filter', { projection: { beta: 8 } }, 'TOP_SETUP_INVALID'],
    ['projection.beta below 1', { filter: { kind: 'density' }, projection: { beta: 0.5 } }, 'TOP_SETUP_INVALID'],
    ['projection.eta 1', { filter: { kind: 'density' }, projection: { eta: 1 } }, 'TOP_SETUP_INVALID'],
    ['projection.betaStart above beta', { filter: { kind: 'density' }, projection: { beta: 4, betaStart: 8 } }, 'TOP_SETUP_INVALID'],
    ['projection.betaEvery 0', { filter: { kind: 'density' }, projection: { betaEvery: 0 } }, 'TOP_SETUP_INVALID'],
    ['an extrusion along the plane normal', { manufacturing: { symmetry: [], extrusion: { axis: 'z' } } }, 'TOP_SETUP_INVALID'],
    ['a minimum member size below 2 voxels', { manufacturing: { symmetry: [], minMemberSize: 1.5 } }, 'TOP_MEMBER_SIZE_UNRESOLVED'],
  ])('refuses %s without changing the document', (_name, params, expected) => {
    const result = settings(model, params);
    expect(code(result)).toBe(expected);
    expect(result.document).toBe(model.doc);
  });

  it('refuses an extrusion axis that is the grid normal in the job too', () => {
    const current = study(model.doc, model);
    const job = buildTopologyJob(model.doc, { ...current, manufacturing: { symmetry: [], extrusion: { axis: 'z' } } });
    expect(job).toMatchObject({ ok: false, code: 'TOP_SETUP_INVALID' });
  });
});

describe('pressure and gravity loads in the job', () => {
  const model = mbbModel();
  const fixedLeft: Params = { kind: 'fixed', target: { entityId: model.entityId, facesNear: [[0, 10, 0.5]] } };

  it('turns a pressure into the total force magnitude x area along the inward normal, spread over the face nodes', () => {
    const made = analysisOn(model, {
      constraints: [fixedLeft],
      loads: [
        {
          kind: 'pressure',
          loadCase: 'LC1',
          category: 'limit',
          target: { entityId: model.entityId, facesNear: [[60, 10, 0.5]] },
          magnitude: 2,
        },
      ],
    });
    const job = okJob(made.doc, made.studyId);
    const load = job.loadCases[0];
    // face x = 60: 20 mm x 1 mm = 20 mm^2, 2 MPa -> 40 N pushing towards -x over the 21 boundary nodes of the right edge
    expect(load?.dofs).toHaveLength(21);
    expect(load?.dofs.every((dof) => dof % 2 === 0 && (dof / 2) % 61 === 60)).toBe(true);
    expect(sum(load?.values ?? [])).toBeCloseTo(-40, 10);
    expect(load?.values.every((value) => Math.abs(value + 40 / 21) < 1e-12)).toBe(true);
    expect(load).not.toHaveProperty('gravity');
    // the loaded face is protected like a force's
    expect(job.grid.keepIn).toBeGreaterThan(0);
  });

  it('turns gravity into the weight of a solid voxel per load case, summing gravity loads of one case', () => {
    const made = analysisOn(model, {
      constraints: [fixedLeft],
      loads: [
        { kind: 'gravity', loadCase: 'LC1', category: 'limit', vector: [0, -9810, 0] },
        { kind: 'gravity', loadCase: 'LC1', category: 'limit', vector: [100, 0, 0] },
      ],
    });
    const job = okJob(made.doc, made.studyId);
    const load = job.loadCases[0];
    expect(load?.dofs).toEqual([]);
    // density 0.001 g/mm^3 = 1e-9 t/mm^3, voxel 1 mm^3: 9.81e-6 N down and 1e-7 N along x per solid voxel
    expect(load?.gravity).toHaveLength(2);
    expect(load?.gravity?.[0]).toBeCloseTo(1e-7, 20);
    expect(load?.gravity?.[1]).toBeCloseTo(-9.81e-6, 18);
    expect(job.grid.keepIn).toBeGreaterThan(0);
  });

  it('keeps gravity apart from the nodal forces of the same case and changes the input hash', () => {
    const forceOnly = analysisOn(model, {
      constraints: [fixedLeft],
      loads: [
        {
          kind: 'force',
          loadCase: 'LC1',
          category: 'limit',
          target: { entityId: model.entityId, pointsNear: [[60, 20, 0]] },
          vector: [0, -1, 0],
        },
      ],
    });
    const both = analysisOn(model, {
      constraints: [fixedLeft],
      loads: [
        {
          kind: 'force',
          loadCase: 'LC1',
          category: 'limit',
          target: { entityId: model.entityId, pointsNear: [[60, 20, 0]] },
          vector: [0, -1, 0],
        },
        { kind: 'gravity', loadCase: 'LC1', category: 'limit', vector: [0, -9810, 0] },
      ],
    });
    const a = okJob(forceOnly.doc, forceOnly.studyId);
    const b = okJob(both.doc, both.studyId);
    expect(b.loadCases[0]?.dofs).toEqual(a.loadCases[0]?.dofs);
    expect(b.loadCases[0]?.gravity).toBeDefined();
    expect(b.inputHash).not.toBe(a.inputHash);
  });
});

describe('V1 report and summary', () => {
  it('lists the rules of the study and the optimizer / projection; the summary carries optimizer, objective and constraints', () => {
    const model = mbbModel();
    const prepared = execute(model.doc, 'set_topology_settings', {
      studyId: model.studyId,
      filter: { kind: 'density' },
      projection: { beta: 8 },
      manufacturing: { symmetry: ['XZ'], extrusion: { axis: 'x' }, minMemberSize: 4 },
    }).document;
    const report = data<{ rules: string[]; optimizer: string; projection: { beta: { value: number } } | null }>(
      execute(prepared, 'topology_report', { studyId: model.studyId }),
    );
    expect(report.optimizer).toBe('oc');
    expect(report.projection?.beta.value).toBe(8);
    expect(report.rules).toHaveLength(4);
    expect(report.rules[0]).toContain('symmetry');
    expect(report.rules[1]).toContain('uniform along world axis x');
    expect(report.rules[2]).toContain('rmin >= size / 2');
    expect(report.rules[2]).toContain('effective radius 2 mm = 2 voxels');
    expect(report.rules[3]).toContain('beta 1 -> 8');
    const plain = data<{ rules: string[]; projection: unknown }>(execute(model.doc, 'topology_report', { studyId: model.studyId }));
    expect(plain.rules).toEqual([]);
    expect(plain.projection).toBeNull();

    const solved = solveAndRecord(model);
    const summary = studyOf(solved.doc, model.analysisId, model.studyId).result;
    expect(summary?.optimizer).toBe('oc');
    expect(summary?.objective).toEqual({ kind: 'min_compliance', value: summary?.compliance });
    expect(summary?.constraints).toEqual([{ name: 'volume', value: summary?.volumeFraction, limit: 0.5, satisfied: true }]);
    expect(summary).not.toHaveProperty('projection');
  });

  it('check_topology fails on an unsatisfied constraint reported by the solver', () => {
    const model = mbbModel();
    const job = jobOf(model);
    const field = Float32Array.from({ length: 1200 }, (_, n) => (n % 60 < 36 ? 1 : 0));
    const artifact = buildTopologyArtifact(
      job,
      fieldBytes(field),
      {
        compliance: 9,
        perLoadCase: { LC1: 9 },
        iterations: 3,
        status: 'converged',
        history: [],
        device: 'cpu',
        deterministic: true,
        version: 't',
        optimizer: 'mma',
        constraints: [{ name: 'volume', value: 0.6, limit: 0.5, satisfied: false }],
        projection: { beta: 16, eta: 0.5 },
      },
      'topopt',
    ) as FeTopologyArtifact;
    expect(artifact).toMatchObject({ optimizer: 'mma', projection: { beta: 16, eta: 0.5 } });
    const store = artifactStore();
    const hash = store.put(artifact);
    const ctx = contextWith(store.port);
    const recorded = execute(model.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: hash }, ctx);
    expect(recorded.rejected).not.toBe(true);
    const summary = studyOf(recorded.document, model.analysisId, model.studyId).result;
    expect(summary?.optimizer).toBe('mma');
    expect(summary?.constraints).toEqual([{ name: 'volume', value: 0.6, limit: 0.5, satisfied: false }]);
    expect(summary?.projection).toEqual({ beta: 16, eta: 0.5 });
    const check = data<{ status: string; items: Array<{ code: string; severity: string }> }>(
      execute(recorded.document, 'check_topology', { studyId: model.studyId }, ctx),
    );
    expect(check.items).toContainEqual(expect.objectContaining({ code: 'TOP_CONSTRAINT_VIOLATED', severity: 'fail' }));
    expect(check.status).toBe('fail');
  });
});

describe('load refusals of the V1 mapping', () => {
  const model = mbbModel();
  const fixedLeft: Params = { kind: 'fixed', target: { entityId: model.entityId, facesNear: [[0, 10, 0.5]] } };
  const refused = (doc: CadDocument, studyId: string): { code: string; message: string } => {
    const analysisId =
      Object.keys(doc.analysis?.cases ?? {}).find((id) => doc.analysis?.cases[id]?.topology?.[studyId] !== undefined) ?? '';
    const result = buildTopologyJob(doc, studyOf(doc, analysisId, studyId));
    if (result.ok) throw new Error('expected a refusal');
    return result;
  };
  /** The MBB material with its density removed. */
  const withoutDensity = (doc: CadDocument): CadDocument => {
    const materialId = doc.entities[model.entityId]?.materialId ?? '';
    const material = doc.materials[materialId];
    if (material === undefined) throw new Error('no material');
    return { ...doc, materials: { ...doc.materials, [materialId]: { ...material, density: 0 } } };
  };

  it.each([
    [
      'a pressure on a point target (no face)',
      [
        {
          kind: 'pressure',
          loadCase: 'LC1',
          category: 'limit',
          target: { entityId: model.entityId, pointsNear: [[60, 10, 0]] },
          magnitude: 1,
        },
      ],
      'needs a facesNear target',
      false,
    ],
    [
      'gravity with an out-of-plane component on a 2D study',
      [{ kind: 'gravity', loadCase: 'LC1', category: 'limit', vector: [0, -9810, 100] }],
      'must lie in the plane',
      false,
    ],
    [
      'gravity on a material without density',
      [{ kind: 'gravity', loadCase: 'LC1', category: 'limit', vector: [0, -9810, 0] }],
      'has no density',
      true,
    ],
    [
      'a moment',
      [
        {
          kind: 'moment',
          loadCase: 'LC1',
          category: 'limit',
          target: { entityId: model.entityId, facesNear: [[60, 10, 0.5]] },
          vector: [0, 0, 5],
        },
      ],
      'is not supported',
      false,
    ],
  ])('refuses %s with TOP_SETUP_INVALID', (_name, loads, message, stripDensity) => {
    const made = analysisOn(model, { constraints: [fixedLeft], loads });
    const refusal = refused(stripDensity ? withoutDensity(made.doc) : made.doc, made.studyId);
    expect(refusal.code).toBe('TOP_SETUP_INVALID');
    expect(refusal.message).toContain(message);
  });

  it('refuses a pressure whose face normal leaves the plane of a 2D grid', () => {
    const grid = {
      dimension: 2 as const,
      plane: 'XY' as const,
      voxel: 1,
      axes: [0, 1, 2] as const,
      origin: [0, 0, 0] as const,
      nx: 4,
      ny: 2,
      nz: 1,
      thickness: 1,
      count: 8,
    };
    const load = { id: 'p', name: 'p', loadCase: 'LC1', category: 'limit' as const, kind: 'pressure' as const, magnitude: 2 };
    const tilted = pressureLoad(load, grid, { nodes: [0, 5], normal: [0.6, 0, 0.8], faceArea: 10 }, 1);
    expect(tilted).toContain('not perpendicular to the plane');
    const straight = pressureLoad(load, grid, { nodes: [0, 5], normal: [1, 0, 0], faceArea: 10 }, 1);
    expect(straight).toEqual({ dofs: [0, 10], values: [-10, -10] });
  });
});

describe('the input hash and the material density', () => {
  const model = mbbModel();
  const fixedLeft: Params = { kind: 'fixed', target: { entityId: model.entityId, facesNear: [[0, 10, 0.5]] } };
  const point: Params = {
    kind: 'force',
    loadCase: 'LC1',
    category: 'limit',
    target: { entityId: model.entityId, pointsNear: [[60, 20, 0]] },
    vector: [0, -1, 0],
  };
  const denser = (doc: CadDocument): CadDocument => {
    const materialId = doc.entities[model.entityId]?.materialId ?? '';
    const material = doc.materials[materialId];
    if (material === undefined) throw new Error('no material');
    return { ...doc, materials: { ...doc.materials, [materialId]: { ...material, density: material.density * 2 } } };
  };
  const hashOf = (doc: CadDocument, studyId: string): string => {
    const analysisId =
      Object.keys(doc.analysis?.cases ?? {}).find((id) => doc.analysis?.cases[id]?.topology?.[studyId] !== undefined) ?? '';
    return topologyInputHash(doc, studyOf(doc, analysisId, studyId));
  };

  it('enters the hash only when the case has a gravity load (a solve reads it then), so a density change makes such a result stale', () => {
    const forceOnly = analysisOn(model, { constraints: [fixedLeft], loads: [point] });
    expect(hashOf(denser(forceOnly.doc), forceOnly.studyId)).toBe(hashOf(forceOnly.doc, forceOnly.studyId));
    const weighted = analysisOn(model, {
      constraints: [fixedLeft],
      loads: [point, { kind: 'gravity', loadCase: 'LC1', category: 'limit', vector: [0, -9810, 0] }],
    });
    expect(hashOf(denser(weighted.doc), weighted.studyId)).not.toBe(hashOf(weighted.doc, weighted.studyId));
    // a recorded gravity result reads stale once the density changed
    const job = okJob(weighted.doc, weighted.studyId);
    const field = Float32Array.from({ length: 1200 }, (_, n) => (n % 60 < 30 ? 1 : 0));
    const artifact = buildTopologyArtifact(
      job,
      fieldBytes(field),
      {
        compliance: 9,
        perLoadCase: { LC1: 9 },
        iterations: 3,
        status: 'converged',
        history: [],
        device: 'cpu',
        deterministic: true,
        version: 't',
      },
      'topopt',
    ) as FeTopologyArtifact;
    const store = artifactStore();
    const hash = store.put(artifact);
    const recorded = execute(
      weighted.doc,
      'record_topology_result',
      { studyId: weighted.studyId, fieldHash: hash },
      contextWith(store.port),
    );
    expect(recorded.rejected).not.toBe(true);
    const report = (doc: CadDocument): string =>
      data<{ state: string }>(execute(doc, 'topology_report', { studyId: weighted.studyId }, contextWith(store.port))).state;
    expect(report(recorded.document)).toBe('solved');
    expect(report(denser(recorded.document))).toBe('stale');
  });
});
