import { afterEach, describe, expect, it } from 'vitest';
import { type CadDocument, type MeshData, type ShapeRecipe, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { type AnalysisData, type CheckData, type KernelKind, WORLD_Z, addBox, dataOf, installKernel, meshEntity } from './harness';

afterEach(() => setGeometryKernel(null));

const BEND_FRAME = { origin: [0, 0, 0], axis: [0, 0, 1], reference: [0, 1, 0] } as const;

/** `doc` with the mesh of entity `id` replaced. */
function withMesh(doc: CadDocument, id: string, edit: (mesh: MeshData) => MeshData): CadDocument {
  const entity = meshEntity(doc, id);
  return { ...doc, entities: { ...doc.entities, [id]: { ...entity, mesh: edit(entity.mesh) } } };
}

function twisted(deg = 90, region?: Record<string, unknown>): { doc: CadDocument; id: string } {
  const { doc, id } = addBox();
  const result = execute(doc, 'twist_body', {
    id,
    angleDeg: deg,
    frame: WORLD_Z,
    ...(region === undefined ? {} : { region }),
    output: { tolerance: 0.02 },
  });
  return { doc: result.document, id: result.affected[0] as string };
}

describe.each<KernelKind>(['none', 'manifold', 'exact'])('analyze_deformation, kernel: %s', (kind) => {
  it('reports the law, Jacobian, volume check, displacement and approximation of a twisted bar', async () => {
    await installKernel(kind);
    const { doc, id } = twisted();
    const result = execute(doc, 'analyze_deformation', { id });
    const data = dataOf<AnalysisData>(result);
    expect(data.law.kind).toBe('twist');
    expect(data.jacobian).toMatchObject({ min: 1, max: 1, bound: { min: 1, max: 1 } });
    expect(data.volume.source).toBeCloseTo(10000, 6);
    expect(data.volume.predicted).toBeCloseTo(10000, 6);
    expect(data.volume.driftRel).toBeLessThan(2e-3);
    expect(data.maxDisplacement).toBeCloseTo(10, 6);
    expect(data.approximation?.maxError).toBeLessThanOrEqual(0.02);
    expect(result.summary).toContain('analyze_deformation');
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expectPure(doc, () => execute(doc, 'analyze_deformation', { id }));
  });

  it('reports bend fibres and the Pappus volume', async () => {
    await installKernel(kind);
    const { doc, id } = addBox([10, 10, (Math.PI / 2) * 50]);
    const bent = execute(doc, 'bend_body', { id, radius: 50, angleDeg: 90, frame: BEND_FRAME, output: { tolerance: 0.02 } });
    const data = dataOf<AnalysisData>(execute(bent.document, 'analyze_deformation', { id: bent.affected[0] as string }));
    expect(data.fibres?.inner).toBeCloseTo(70.6858347, 6);
    expect(data.jacobian.bound.min).toBeCloseTo(0.9, 9);
    expect(data.jacobian.bound.max).toBeCloseTo(1.1, 9);
    expect(data.volume.predicted).toBeCloseTo(7853.98163397, 1);
  });

  it('refuses unknown ids and bodies that were not deformed', async () => {
    await installKernel(kind);
    const { doc, id } = addBox();
    const missing = execute(doc, 'analyze_deformation', { id: 'nope' });
    expectNoOp(missing, doc, 'DEF_ENTITY_NOT_FOUND');
    expect(missing.error?.code).toBe('DEF_ENTITY_NOT_FOUND');
    const plain = execute(doc, 'analyze_deformation', { id });
    expectNoOp(plain, doc, 'DEF_NOT_DEFORMED');
    expect(plain.error).toMatchObject({ code: 'DEF_NOT_DEFORMED', ids: [id] });
  });
});

describe('analyze_deformation paths', () => {
  it('an exact kernel evaluates an affine result exactly: path exact, volume from the kernel', async () => {
    await installKernel('exact');
    const { doc, id } = addBox([10, 20, 30], 'center');
    const scaled = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 3] });
    const data = dataOf<AnalysisData>(execute(scaled.document, 'analyze_deformation', { id: scaled.affected[0] as string }));
    expect(data).toMatchObject({ path: 'exact', approximation: null });
    expect(data.volume).toMatchObject({ method: 'exact' });
    expect(data.volume.measured).toBeCloseTo(36000, 6);
    expect(data.volume.driftRel).toBeLessThan(1e-9);
    expect(data.jacobian.min).toBe(6);
  });

  it('without a kernel a source the core cannot evaluate is refused with a code', async () => {
    await installKernel('none');
    const { doc, id } = twisted();
    const entity = meshEntity(doc, id);
    const unreachable: ShapeRecipe = { op: 'shell', source: (entity.brep as Extract<ShapeRecipe, { op: 'deform' }>).source, thickness: 1 };
    const broken = {
      ...doc,
      entities: {
        ...doc.entities,
        [id]: { ...entity, brep: { ...(entity.brep as Extract<ShapeRecipe, { op: 'deform' }>), source: unreachable } },
      },
    };
    const result = execute(broken as CadDocument, 'analyze_deformation', { id });
    expect(result.error?.code).toBe('DEF_SOURCE_UNAVAILABLE');
  });

  it('a corrupt recorded frame is reported, not thrown', async () => {
    await installKernel('none');
    const { doc, id } = twisted();
    const entity = meshEntity(doc, id);
    const node = entity.brep as Extract<ShapeRecipe, { op: 'deform' }>;
    const broken = {
      ...doc,
      entities: { ...doc.entities, [id]: { ...entity, brep: { ...node, frame: { ...node.frame, axis: [0, 0, 0] } } } },
    };
    expect(execute(broken as CadDocument, 'analyze_deformation', { id }).error?.code).toBe('DEF_FRAME_DEGENERATE');
  });
});

describe('check_deformation', () => {
  const run = (doc: CadDocument, params: Record<string, unknown> = {}): CheckData =>
    dataOf<CheckData>(execute(doc, 'check_deformation', params));
  const codes = (data: CheckData): string[] => data.findings.map((finding) => finding.code);

  it('passes a smooth-ramp exact result and lists only the notes about the check', async () => {
    await installKernel('exact');
    const { doc, id } = addBox([10, 20, 30], 'center');
    const scaled = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 3] });
    const data = run(scaled.document, { approx: 1, volumeDriftRel: 1e-6, creaseRad: 0.1 });
    expect(data.status).toBe('pass');
    expect(codes(data)).toEqual([]);
    expect(data.tolerances.every((entry) => !entry.defaulted)).toBe(true);
  });

  it('warns about a faceted result and a defaulted tolerance; release sets reviewRequired', async () => {
    await installKernel('none');
    const { doc } = twisted();
    const design = run(doc);
    expect(design.status).toBe('warn');
    expect(codes(design)).toEqual(expect.arrayContaining(['DEF_CHECK_MESH_RESULT', 'DEF_CHECK_TOLERANCE_DEFAULTED']));
    expect(design.reviewRequired).toBe(false);
    const release = run(doc, { purpose: 'release' });
    expect(release.reviewRequired).toBe(true);
    expect(release.reviewReason).toContain('faceted mesh');
    expect(release.unverified).toBe(false);
  });

  it('release of an exact result from an unverified input needs review for that reason', async () => {
    await installKernel('exact');
    const tetra = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] };
    const imported = execute(createEmptyDocument(), 'import_mesh', { bodies: [tetra] });
    const scaled = execute(imported.document, 'scale_nonuniform', { id: imported.affected[0] as string, factors: [2, 1, 1] });
    const data = run(scaled.document, { purpose: 'release', approx: 1, volumeDriftRel: 1e-3, creaseRad: 1 });
    expect(data.unverified).toBe(true);
    expect(data.reviewReason).toContain('unverified');
    expect(codes(data)).toContain('DEF_CHECK_INPUT_UNVERIFIED');
  });

  it('linear ramps leave a crease warning at the region end; a smooth ramp does not', async () => {
    await installKernel('none');
    const linear = twisted(90, { start: 0, end: 50, falloff: 'linear' });
    expect(codes(run(linear.doc))).toContain('DEF_CHECK_REGION_CREASE');
    expect(run(linear.doc, { creaseRad: 0.5 }).findings.map((f) => f.code)).not.toContain('DEF_CHECK_REGION_CREASE');
    const smooth = twisted(90, { start: 0, end: 50, falloff: 'smooth' });
    expect(codes(run(smooth.doc))).not.toContain('DEF_CHECK_REGION_CREASE');
  });

  it('fails a result whose volume, chord tolerance, closure or crossings are off', async () => {
    await installKernel('none');
    const { doc, id } = twisted();
    const inflated = withMesh(doc, id, (mesh) => ({ positions: mesh.positions.map((value) => value * 1.1), indices: mesh.indices }));
    const drift = run(inflated);
    expect(drift.status).toBe('fail');
    expect(drift.findings.find((f) => f.code === 'DEF_CHECK_VOLUME_DRIFT')).toMatchObject({ severity: 'fail', unit: 'relative' });
    const holed = withMesh(doc, id, (mesh) => ({ positions: mesh.positions, indices: mesh.indices.slice(3) }));
    expect(codes(run(holed))).toContain('DEF_CHECK_NOT_CLOSED');
    expect(codes(run(doc, { approx: 1e-9 }))).toContain('DEF_CHECK_APPROX_ERROR');
    const doubled = withMesh(doc, id, (mesh) => {
      const offset = mesh.positions.length / 3;
      const shifted = mesh.positions.map((value, i) => (i % 3 === 0 ? value + 4 : i % 3 === 1 ? value + 3 : value));
      return { positions: [...mesh.positions, ...shifted], indices: [...mesh.indices, ...mesh.indices.map((index) => index + offset)] };
    });
    expect(run(doubled).findings.find((f) => f.code === 'DEF_CHECK_SELF_INTERSECTION')).toMatchObject({ severity: 'fail', unit: 'pairs' });
  });

  it('fails a fold-over recorded in the recipe', async () => {
    await installKernel('none');
    const { doc, id } = addBox();
    const bent = execute(doc, 'bend_body', { id, radius: 40, angleDeg: 90, frame: BEND_FRAME, output: { tolerance: 0.5 } });
    const next = bent.affected[0] as string;
    const entity = meshEntity(bent.document, next);
    const node = entity.brep as Extract<ShapeRecipe, { op: 'deform' }>;
    const folded = {
      ...bent.document,
      entities: { ...bent.document.entities, [next]: { ...entity, brep: { ...node, law: { kind: 'bend', radius: 4, symmetric: false } } } },
    };
    const data = run(folded as CadDocument);
    expect(data.status).toBe('fail');
    expect(data.findings.find((f) => f.code === 'DEF_CHECK_FOLDOVER')).toMatchObject({ severity: 'fail', limit: 1e-6 });
  });

  it('refuses unknown ids and non-deformed bodies; with no deformed body it passes empty', async () => {
    await installKernel('none');
    const { doc, id } = addBox();
    expect(execute(doc, 'check_deformation', { ids: ['nope'] }).error?.code).toBe('DEF_ENTITY_NOT_FOUND');
    expect(execute(doc, 'check_deformation', { ids: [id] }).error?.code).toBe('DEF_NOT_DEFORMED');
    const empty = run(doc);
    expect(empty.status).toBe('pass');
    expect(empty.findings).toEqual([]);
    const broken = twisted();
    const entity = meshEntity(broken.doc, broken.id);
    const node = entity.brep as Extract<ShapeRecipe, { op: 'deform' }>;
    const lost = {
      ...broken.doc,
      entities: {
        ...broken.doc.entities,
        [broken.id]: { ...entity, brep: { ...node, source: { op: 'shell', source: node.source, thickness: 1 } } },
      },
    };
    expect(execute(lost as CadDocument, 'check_deformation', {}).error?.code).toBe('DEF_SOURCE_UNAVAILABLE');
  });
});
