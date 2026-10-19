/** buildTopologyJob: voxelisation, 05 loads / supports mapped onto grid nodes (TECHNICAL_SPEC 5.4), regions and refusals. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import type { CadDocument } from '@core/model/types';
import { buildTopologyJob, type TopologyJob } from '@cae/index';
import { jobOf, mbbModel, studyOf, type Model } from './support';

type Params = Record<string, unknown>;

/** A new static analysis on the MBB plate (or on `entityId`) with the given supports and loads, and a study over it. */
function analysisOn(
  base: Model,
  setup: { constraints?: Params[]; loads?: Params[]; study?: Params; entityId?: string; doc?: CadDocument },
): { doc: CadDocument; analysisId: string; studyId: string } {
  let doc = setup.doc ?? base.doc;
  const entityId = setup.entityId ?? base.entityId;
  const analysisId = execute(doc, 'create_analysis', { name: 'extra', analysisType: 'static' });
  doc = analysisId.document;
  const id = analysisId.affected[0] ?? '';
  doc = execute(doc, 'set_part_idealization', { analysisId: id, entityId, idealization: 'solid' }).document;
  for (const constraint of setup.constraints ?? [])
    doc = execute(doc, 'add_fea_constraint', { analysisId: id, name: 'c', ...constraint }).document;
  for (const load of setup.loads ?? []) doc = execute(doc, 'add_fea_load', { analysisId: id, name: 'l', ...load }).document;
  const study = execute(doc, 'create_topology_study', {
    analysisId: id,
    name: 's',
    designDomain: [entityId],
    dimension: 2,
    voxel: 1,
    volumeFraction: 0.5,
    ...setup.study,
  });
  return { doc: study.document, analysisId: id, studyId: study.affected[0] ?? '' };
}

const jobFor = (made: { doc: CadDocument; analysisId: string; studyId: string }): ReturnType<typeof buildTopologyJob> =>
  buildTopologyJob(made.doc, studyOf(made.doc, made.analysisId, made.studyId));

const okJob = (made: { doc: CadDocument; analysisId: string; studyId: string }): TopologyJob => {
  const result = jobFor(made);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.job;
};

const refusal = (made: {
  doc: CadDocument;
  analysisId: string;
  studyId: string;
}): { code: string; message: string; ids: readonly string[] } => {
  const result = jobFor(made);
  if (result.ok) throw new Error('expected a refusal');
  return result;
};

const sum = (values: ArrayLike<number>): number => Array.from(values).reduce((total, value) => total + value, 0);

describe('buildTopologyJob on the MBB plate', () => {
  const model = mbbModel();
  const job = jobOf(model);

  it('describes the 60 x 20 grid, the material and the settings in voxel units', () => {
    expect(job.grid).toEqual({
      nx: 60,
      ny: 20,
      nz: 1,
      active: 1200,
      keepIn: 0,
      keepOut: 0,
      dimension: 2,
      plane: 'XY',
      voxel: 1,
      origin: [0, 0, 0],
      thickness: 1,
    });
    expect(job.active).toHaveLength(1200);
    expect(sum(job.active)).toBe(1200);
    expect(job.material).toMatchObject({ youngsModulus: 1, poisson: 0.3, unverifiedReasons: [] });
    expect(job.thickness).toBe(1);
    expect(job.unitSystem).toBe('N-mm-t-s');
    expect(job.settings).toMatchObject({
      penal: 3,
      move: 0.2,
      changeTol: 0.01,
      maxIterations: 300,
      filter: { kind: 'sensitivity', radiusVoxels: 1.5 },
      optimizer: 'oc',
    });
    expect(job.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(job.settingsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps the left-edge symmetry, the bottom-right roller and the top-left point load', () => {
    const left = Array.from({ length: 21 }, (_, iy) => 2 * (61 * iy));
    expect(job.fixedDofs).toEqual([...left, 2 * 60 + 1].sort((a, b) => a - b));
    expect(job.loadCases).toEqual([{ name: 'LC1', weight: 1, dofs: [2 * (61 * 20) + 1], values: [-1] }]);
  });

  it('is deterministic and a pure function of the document', () => {
    const again = jobOf(model);
    expect(again.inputHash).toBe(job.inputHash);
    expect(Array.from(again.active)).toEqual(Array.from(job.active));
  });

  it('protects the voxels around loads and supports unless the setting is false', () => {
    const protectedJob = jobOf({
      ...model,
      doc: execute(model.doc, 'set_topology_settings', { studyId: model.studyId, protectLoadSupport: true }).document,
    });
    expect(protectedJob.grid.keepIn).toBeGreaterThan(20);
    expect(protectedJob.keepIn[0 + 60 * 19]).toBe(1);
    expect(protectedJob.keepIn[30 + 60 * 10]).toBe(0);
    expect(protectedJob.inputHash).not.toBe(job.inputHash);
  });

  it('turns keep-in and keep-out regions into masks, keep-out winning over protection', () => {
    const regions = execute(model.doc, 'set_topology_regions', {
      studyId: model.studyId,
      keepIn: [{ kind: 'box', min: [10, 0, 0], max: [20, 5, 1] }],
      keepOut: [{ kind: 'box', min: [30, 8, 0], max: [34, 12, 1] }],
    });
    const withRegions = jobOf({ ...model, doc: regions.document });
    expect(withRegions.grid.keepIn).toBe(50);
    expect(withRegions.grid.keepOut).toBe(16);
    expect(withRegions.keepIn[10 + 60 * 0]).toBe(1);
    expect(withRegions.keepOut[30 + 60 * 8]).toBe(1);
    const overlapping = execute(model.doc, 'set_topology_regions', {
      studyId: model.studyId,
      keepOut: [{ kind: 'box', min: [0, 18, 0], max: [5, 20, 1] }],
    });
    const protectedAndVoid = jobOf({
      ...model,
      doc: execute(overlapping.document, 'set_topology_settings', { studyId: model.studyId, protectLoadSupport: true }).document,
    });
    expect(protectedAndVoid.keepOut[0 + 60 * 19]).toBe(1);
    expect(protectedAndVoid.keepIn[0 + 60 * 19]).toBe(0);
  });
});

describe('loads and supports on faces, edges and points', () => {
  const model = mbbModel();
  const face = (x: number): Params => ({ entityId: model.entityId, facesNear: [[x, 10, 0]] });
  const fixedLeft: Params = { kind: 'fixed', target: face(0) };

  it('spreads a total force equally over the face nodes and keeps the total', () => {
    const job = okJob(
      analysisOn(model, {
        constraints: [fixedLeft],
        loads: [{ kind: 'force', loadCase: 'LC1', category: 'limit', target: face(60), vector: [0, -21, 0] }],
      }),
    );
    expect(job.fixedDofs).toHaveLength(42);
    const load = job.loadCases[0];
    expect(load?.dofs).toHaveLength(21);
    expect(load?.values.every((value) => value === -1)).toBe(true);
    expect(sum(load?.values ?? [])).toBe(-21);
    expect(load?.dofs.every((dof) => dof % 2 === 1)).toBe(true);
    expect(load?.dofs[0]).toBe(2 * 60 + 1);
  });

  it('applies the full vector at every node for per_node and keeps components', () => {
    const job = okJob(
      analysisOn(model, {
        constraints: [fixedLeft],
        loads: [{ kind: 'force', loadCase: 'LC1', category: 'limit', target: face(60), vector: [3, -2, 5], distribution: 'per_node' }],
      }),
    );
    const load = job.loadCases[0];
    expect(load?.dofs).toHaveLength(42);
    expect(load?.values.filter((value) => value === 3)).toHaveLength(21);
    expect(load?.values.filter((value) => value === -2)).toHaveLength(21);
  });

  it('sums loads of the same case, orders the cases by appearance and weights them', () => {
    const made = analysisOn(model, {
      constraints: [fixedLeft],
      loads: [
        {
          kind: 'force',
          loadCase: 'wind',
          category: 'limit',
          target: { entityId: model.entityId, pointsNear: [[60, 20, 0]] },
          vector: [0, -1, 0],
        },
        {
          kind: 'force',
          loadCase: 'wind',
          category: 'limit',
          target: { entityId: model.entityId, pointsNear: [[60, 20, 0]] },
          vector: [0, -2, 0],
        },
        {
          kind: 'force',
          loadCase: 'lift',
          category: 'limit',
          target: { entityId: model.entityId, pointsNear: [[60, 0, 0]] },
          vector: [0, 4, 0],
        },
      ],
      study: { objective: { kind: 'min_compliance', loadCaseWeights: { lift: 0.5 } } },
    });
    const job = okJob(made);
    expect(job.loadCases).toEqual([
      { name: 'wind', weight: 1, dofs: [2 * 60 + 2 * 61 * 20 + 1], values: [-3] },
      { name: 'lift', weight: 0.5, dofs: [2 * 60 + 1], values: [4] },
    ]);
  });

  it('fixes the normal dof of a symmetry face and both dofs of a pinned edge', () => {
    const symmetry = okJob(
      analysisOn(model, {
        constraints: [
          { kind: 'symmetry', target: face(0) },
          { kind: 'symmetry', target: { entityId: model.entityId, facesNear: [[30, 0, 0.5]] } },
        ],
        loads: [
          {
            kind: 'force',
            loadCase: 'LC1',
            category: 'limit',
            target: { entityId: model.entityId, pointsNear: [[60, 20, 0]] },
            vector: [0, -1, 0],
          },
        ],
      }),
    );
    expect(symmetry.fixedDofs).toHaveLength(21 + 61);
    expect(symmetry.fixedDofs.filter((dof) => dof % 2 === 1)).toHaveLength(61);
    const pinned = okJob(
      analysisOn(model, {
        constraints: [{ kind: 'pinned', target: { entityId: model.entityId, edgesNear: [[0, 10, 0]] } }],
        loads: [
          {
            kind: 'force',
            loadCase: 'LC1',
            category: 'limit',
            target: { entityId: model.entityId, pointsNear: [[60, 20, 0]] },
            vector: [0, -1, 0],
          },
        ],
      }),
    );
    expect(pinned.fixedDofs).toHaveLength(42);
  });

  it('fixes the zero dofs of a displacement constraint and ignores the out-of-plane one', () => {
    const job = okJob(
      analysisOn(model, {
        constraints: [{ kind: 'displacement', dofs: { ux: 0, uz: 0, rx: 0 }, target: face(0) }],
        loads: [
          {
            kind: 'force',
            loadCase: 'LC1',
            category: 'limit',
            target: { entityId: model.entityId, pointsNear: [[60, 20, 0]] },
            vector: [0, -1, 0],
          },
        ],
      }),
    );
    expect(job.fixedDofs).toHaveLength(21);
    expect(job.fixedDofs.every((dof) => dof % 2 === 0)).toBe(true);
  });
});

describe('refusals of buildTopologyJob', () => {
  const model = mbbModel();
  const left: Params = { kind: 'fixed', target: { entityId: model.entityId, facesNear: [[0, 10, 0]] } };
  const push: Params = {
    kind: 'force',
    loadCase: 'LC1',
    category: 'limit',
    target: { entityId: model.entityId, pointsNear: [[60, 20, 0]] },
    vector: [0, -1, 0],
  };

  it.each([
    [
      'a point far from the domain',
      { constraints: [left], loads: [{ ...push, target: { entityId: 'E', pointsNear: [[500, 500, 0]] } }] },
      'TOP_TARGET_UNMAPPED',
    ],
    [
      'a face normal to the 2D plane (a cap)',
      { constraints: [{ ...left, target: { entityId: 'E', facesNear: [[30, 10, 1]] } }], loads: [push] },
      'TOP_TARGET_UNMAPPED',
    ],
    [
      'a pressure load',
      {
        constraints: [left],
        loads: [
          { kind: 'pressure', loadCase: 'LC1', category: 'limit', target: { entityId: 'E', facesNear: [[60, 10, 0]] }, magnitude: 1 },
        ],
      },
      'TOP_SETUP_INVALID',
    ],
    [
      'a gravity load',
      { constraints: [left], loads: [{ kind: 'gravity', loadCase: 'LC1', category: 'limit', vector: [0, -9810, 0] }] },
      'TOP_SETUP_INVALID',
    ],
    ['no support', { loads: [push] }, 'TOP_SETUP_INVALID'],
    ['no load', { constraints: [left] }, 'TOP_SETUP_INVALID'],
    ['a force with only an out-of-plane component', { constraints: [left], loads: [{ ...push, vector: [0, 0, 7] }] }, 'TOP_SETUP_INVALID'],
    [
      'a symmetry constraint without a face',
      { constraints: [{ kind: 'symmetry', target: { entityId: 'E', pointsNear: [[0, 10, 0]] } }], loads: [push] },
      'TOP_SETUP_INVALID',
    ],
    [
      'a prescribed non-zero displacement',
      { constraints: [{ kind: 'displacement', dofs: { ux: 0.5 }, target: { entityId: 'E', facesNear: [[0, 10, 0]] } }], loads: [push] },
      'TOP_SETUP_INVALID',
    ],
  ])('refuses %s', (_name, setup, expected) => {
    const resolved = JSON.parse(JSON.stringify(setup).replaceAll('"E"', JSON.stringify(model.entityId))) as Parameters<
      typeof analysisOn
    >[1];
    const refused = refusal(analysisOn(model, resolved));
    expect(refused.code).toBe(expected);
    expect(refused.message.length).toBeGreaterThan(10);
  });

  it('refuses a load or support on an entity outside the design domain', () => {
    const other = execute(model.doc, 'add_box', { size: [5, 5, 5], position: [100, 0, 0] });
    const otherId = other.affected[0] ?? '';
    const made = analysisOn(model, { doc: other.document, constraints: [left] });
    const withOther = execute(made.doc, 'set_part_idealization', {
      analysisId: made.analysisId,
      entityId: otherId,
      idealization: 'solid',
    }).document;
    const loaded = execute(withOther, 'add_fea_load', {
      analysisId: made.analysisId,
      name: 'out',
      kind: 'force',
      loadCase: 'LC1',
      category: 'limit',
      target: { entityId: otherId, facesNear: [[100, 2, 2]] },
      vector: [0, -1, 0],
    });
    expect(refusal({ ...made, doc: loaded.document }).code).toBe('TOP_LOAD_OUTSIDE_DOMAIN');
    const supported = execute(withOther, 'add_fea_constraint', {
      analysisId: made.analysisId,
      name: 'far',
      kind: 'fixed',
      target: { entityId: otherId, facesNear: [[100, 2, 2]] },
    });
    expect(refusal({ ...made, doc: supported.document }).code).toBe('TOP_TARGET_UNMAPPED');
  });

  it('refuses a domain without a shared, elastic material', () => {
    const second = execute(model.doc, 'add_box', { size: [60, 20, 1], position: [0, 0, 5] });
    const made = analysisOn(model, {
      doc: second.document,
      constraints: [left],
      loads: [push],
      study: { designDomain: [model.entityId, second.affected[0] ?? ''] },
    });
    expect(made.studyId).toBe('');
    const bare = execute(model.doc, 'add_box', { size: [10, 10, 1] });
    const bareId = bare.affected[0] ?? '';
    const bareCase = analysisOn(model, {
      doc: bare.document,
      entityId: bareId,
      constraints: [{ kind: 'fixed', target: { entityId: bareId, facesNear: [[0, 5, 0.5]] } }],
      loads: [
        { kind: 'force', loadCase: 'LC1', category: 'limit', target: { entityId: bareId, facesNear: [[10, 5, 0.5]] }, vector: [0, -1, 0] },
      ],
    });
    expect(refusal(bareCase).code).toBe('TOP_SETUP_INVALID');
    expect(refusal(bareCase).message).toContain('same material');
  });

  it('refuses a study whose analysis or domain disappeared', () => {
    const study = studyOf(model.doc, model.analysisId, model.studyId);
    expect(buildTopologyJob(model.doc, { ...study, analysisId: 'an-0.0' })).toMatchObject({ ok: false, code: 'TOP_ANALYSIS_MISSING' });
    expect(buildTopologyJob(model.doc, { ...study, designDomain: ['ghost'] })).toMatchObject({ ok: false, code: 'TOP_DOMAIN_INVALID' });
    expect(buildTopologyJob(model.doc, { ...study, voxel: 0.001 })).toMatchObject({ ok: false, code: 'TOP_GRID_TOO_LARGE' });
    expect(buildTopologyJob(model.doc, { ...study, voxel: 1000 })).toMatchObject({ ok: false, code: 'TOP_DOMAIN_INVALID' });
    expect(buildTopologyJob(model.doc, { ...study, keepIn: [{ kind: 'entity', entityId: 'ghost' }] })).toMatchObject({
      ok: false,
      code: 'TOP_REGION_OUTSIDE_DOMAIN',
    });
    expect(buildTopologyJob(model.doc, { ...study, keepOut: [{ kind: 'entity', entityId: 'ghost' }] })).toMatchObject({
      ok: false,
      code: 'TOP_REGION_OUTSIDE_DOMAIN',
    });
  });
});

describe('other planes and 3D grids', () => {
  const model = mbbModel();

  function solidModel(size: [number, number, number], extra: Params = {}): { doc: CadDocument; entityId: string } {
    const box = execute(model.doc, 'add_box', { size, position: [0, 0, 0], anchor: 'min' });
    const entityId = box.affected[0] ?? '';
    const assigned = execute(box.document, 'assign_material', { materialName: 'topo_unit', entityIds: [entityId] });
    void extra;
    return { doc: assigned.document, entityId };
  }

  it('builds a 3D job: faces, edges and points map to layers of nodes with three dofs each', () => {
    const { doc, entityId } = solidModel([12, 8, 6]);
    const made = analysisOn(model, {
      doc,
      entityId,
      constraints: [{ kind: 'fixed', target: { entityId, facesNear: [[0, 4, 3]] } }],
      loads: [{ kind: 'force', loadCase: 'LC1', category: 'limit', target: { entityId, edgesNear: [[12, 4, 0]] }, vector: [0, 0, -10] }],
      study: { dimension: 3, voxel: 2 },
    });
    const job = okJob(made);
    expect(job.grid).toMatchObject({ nx: 6, ny: 4, nz: 3, active: 72, dimension: 3 });
    expect(job.dimension).toBe(3);
    expect(job.fixedDofs).toHaveLength(5 * 4 * 3);
    const load = job.loadCases[0];
    expect(load?.dofs).toHaveLength(5);
    expect(sum(load?.values ?? [])).toBeCloseTo(-10, 12);
    expect(load?.dofs.every((dof) => dof % 3 === 2)).toBe(true);
  });

  it('rounds partial voxels up and keeps only voxels whose centre is inside', () => {
    const { doc, entityId } = solidModel([4.5, 3.5, 2]);
    const made = analysisOn(model, {
      doc,
      entityId,
      constraints: [{ kind: 'fixed', target: { entityId, facesNear: [[0, 1.5, 1]] } }],
      loads: [{ kind: 'force', loadCase: 'LC1', category: 'limit', target: { entityId, pointsNear: [[4.5, 1.5, 1]] }, vector: [0, -1, 0] }],
      study: { dimension: 3, voxel: 2 },
    });
    const job = okJob(made);
    expect(job.grid).toMatchObject({ nx: 3, ny: 2, nz: 1 });
    expect(job.grid.active).toBe(4);
    expect(Array.from(job.active)).toEqual([1, 1, 0, 1, 1, 0]);
  });

  it('builds an XZ plane study with the plate normal along y', () => {
    const { doc, entityId } = solidModel([20, 2, 8]);
    const made = analysisOn(model, {
      doc,
      entityId,
      constraints: [{ kind: 'fixed', target: { entityId, facesNear: [[0, 1, 4]] } }],
      loads: [{ kind: 'force', loadCase: 'LC1', category: 'limit', target: { entityId, pointsNear: [[20, 1, 8]] }, vector: [0, 0, -1] }],
      study: { plane: 'XZ', voxel: 2 },
    });
    const job = okJob(made);
    expect(job.grid).toMatchObject({ nx: 10, ny: 4, nz: 1, plane: 'XZ', thickness: 2 });
    expect(job.fixedDofs).toHaveLength(10);
    expect(job.loadCases[0]?.dofs).toEqual([2 * (10 + 11 * 4) + 1]);
  });

  it('builds a YZ plane study', () => {
    const { doc, entityId } = solidModel([2, 10, 6]);
    const made = analysisOn(model, {
      doc,
      entityId,
      constraints: [{ kind: 'fixed', target: { entityId, edgesNear: [[1, 0, 0]] } }],
      loads: [{ kind: 'force', loadCase: 'LC1', category: 'limit', target: { entityId, pointsNear: [[1, 10, 6]] }, vector: [0, 0, -1] }],
      study: { plane: 'YZ', voxel: 2 },
    });
    expect(okJob(made).grid).toMatchObject({ nx: 5, ny: 3, plane: 'YZ' });
  });

  it('voxelises a rotated solid by the centres inside it', () => {
    const { doc, entityId } = solidModel([12, 12, 4]);
    const rotated = execute(doc, 'rotate_entity', { id: entityId, delta: [0, 0, Math.PI / 4] });
    expect(rotated.affected).toEqual([entityId]);
    const entity = rotated.document.entities[entityId];
    const corners = entity === undefined ? [] : entityToTriangles(entity, rotated.document).flat();
    const centre = [0, 1, 2].map((axis) => corners.reduce((total, point) => total + (point[axis] ?? 0), 0) / corners.length);
    const at = (dy: number): Params => ({ entityId, pointsNear: [[centre[0] ?? 0, (centre[1] ?? 0) + dy, centre[2] ?? 0]] });
    const made = analysisOn(model, {
      doc: rotated.document,
      entityId,
      constraints: [{ kind: 'fixed', target: at(-2) }],
      loads: [{ kind: 'force', loadCase: 'LC1', category: 'limit', target: at(2), vector: [0, -1, 0] }],
      study: { voxel: 1 },
    });
    const job = okJob(made);
    expect(job.grid.active).toBeLessThan(job.grid.nx * job.grid.ny);
    expect(Math.abs(job.grid.active - 144)).toBeLessThan(12);
  });
});
