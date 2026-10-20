/**
 * 12 CFD M1: cfd_prepare (TECHNICAL_SPEC §5.1) — VC-CFD-10 voxel volume, VC-CFD-11 watertight check and union, VC-CFD-12 buildings domain
 * and blockage, VC-CFD-14 determinism, VC-CFD-15 small-feature report; plus the remaining check rows. The Manifold kernel is the mesh kernel.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import refs from '../../../../docs/aerospace/12-cfd-gpu/validation/data/analytic_references.json';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { expectRefusal } from '../../../helpers/commandAssertions';
import { addBody, boxMesh, ctxWith, metreDocument, ok, prepare, rowOf, withCase } from './fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

const meshDoc = (bodies: Array<{ positions: number[]; indices: number[] }>): { doc: CadDocument; ids: string[] } => {
  const result = ok(metreDocument(), 'import_mesh', { bodies });
  return { doc: result.document, ids: result.affected };
};

describe('VC-CFD-10: voxel volume of a sphere', () => {
  const { doc, id } = addBody(metreDocument(), 'add_sphere', { radius: 0.5, position: [0, 0, 0] });

  it('stays inside the derived bound and falls with h at 16 / 32 / 64 cells per radius', () => {
    const errors = refs.voxelSphere.rows.map((reference) => {
      const report = prepare(withCase(doc, [id], { cellsPerReferenceLength: reference.cellsPerRadius * 2 }));
      const surface = report.surface as Record<string, number>;
      expect(rowOf(report, 'CFD_GEOMETRY_NOT_WATERTIGHT').status).toBe('pass');
      expect(surface['voxelVolumeRelativeError']).toBeLessThanOrEqual(reference.relativeVolumeBound);
      expect(surface['voxelVolumeRelativeError']).toBeLessThanOrEqual(surface['voxelVolumeBoundRelative'] as number);
      return surface['voxelVolumeRelativeError'] as number;
    });
    expect(errors[1]).toBeLessThan(errors[0] as number);
    expect(errors[2]).toBeLessThan(errors[1] as number);
  });

  it('reports the tessellated volume and area of the sphere', () => {
    const surface = prepare(withCase(doc, [id])).surface as Record<string, number>;
    expect(Math.abs((surface['volumeM3'] as number) / ((4 / 3) * Math.PI * 0.125) - 1)).toBeLessThan(0.05);
    expect(surface['closed']).toBe(true);
    expect(surface['method']).toBe('single_body');
  });
});

describe('VC-CFD-11: watertight check and union', () => {
  it('an open box fails with its 4 open edges and their positions', () => {
    const open = boxMesh([3, 0, 0], [1, 1, 1]);
    const { doc, ids } = meshDoc([{ positions: open.positions, indices: open.indices.slice(0, 30) }]);
    const report = prepare(withCase(doc, ids));
    const row = rowOf(report, 'CFD_GEOMETRY_NOT_WATERTIGHT');
    expect(row.status).toBe('fail');
    expect(row['openEdges']).toBe(4);
    expect(row['openAt']).toHaveLength(4);
    expect(row['remediation']).toContain('cfd_set_boundary');
    expect(report.status).toBe('fail');
    expect(rowOf(report, 'CFD_SMALL_FEATURE').status).toBe('not_run');
    expect(rowOf(report, 'CFD_BLOCKAGE_TOO_HIGH').status).toBe('not_run');
  });

  it('a closed box passes with its volume and area', () => {
    const closed = boxMesh([0, 0, 0], [1, 2, 3]);
    const { doc, ids } = meshDoc([closed]);
    const surface = prepare(withCase(doc, ids)).surface as Record<string, number>;
    expect(surface['volumeM3']).toBeCloseTo(6, 9);
    expect(surface['areaM2']).toBeCloseTo(2 * (2 + 3 + 6), 9);
  });

  it('two unit cubes overlapping by 0.5 union to 1.5 m3 with no internal face (kernel)', () => {
    const first = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
    const second = addBody(first.doc, 'add_box', { size: [1, 1, 1], position: [0.5, 0, 0], anchor: 'min' });
    const doc = withCase(second.doc, [first.id, second.id]);
    const report = prepare(doc, {}, ctxWith(kernel));
    const surface = report.surface as Record<string, number | string>;
    expect(surface['method']).toBe('kernel_union');
    expect(surface['volumeM3']).toBeCloseTo(1.5, 9);
    expect(surface['areaM2']).toBeCloseTo(8, 9);
    expect(rowOf(report, 'CFD_KERNEL_REQUIRED').status).toBe('pass');
    expect(rowOf(report, 'CFD_GEOMETRY_NOT_WATERTIGHT').status).toBe('pass');

    const withoutKernel = prepare(doc);
    const row = rowOf(withoutKernel, 'CFD_KERNEL_REQUIRED');
    expect(row.status).toBe('fail');
    expect(row['pairs']).toEqual([[first.id, second.id]]);
    expect(rowOf(withoutKernel, 'CFD_GEOMETRY_SELF_INTERSECTING').status).toBe('not_run');
  });

  it('separate bodies need no union', () => {
    const first = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
    const second = addBody(first.doc, 'add_box', { size: [1, 1, 1], position: [5, 0, 0], anchor: 'min' });
    const report = prepare(withCase(second.doc, [first.id, second.id]));
    expect(rowOf(report, 'CFD_KERNEL_REQUIRED').status).toBe('pass');
    expect((report.surface as Record<string, number>)['volumeM3']).toBeCloseTo(2, 9);
  });

  it('a kernel that cannot union the bodies falls back to display triangles and says so', () => {
    const first = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
    const second = addBody(first.doc, 'add_box', { size: [1, 1, 1], position: [5, 0, 0], anchor: 'min' });
    const refusing: GeometryKernel = { ...kernel, evaluate: () => null };
    const report = prepare(withCase(second.doc, [first.id, second.id]), {}, ctxWith(refusing));
    expect((report.surface as Record<string, string>)['method']).toBe('display_triangles');
    expect(report.warnings.join(' ')).toContain('could not union');
  });

  it('an intersecting mesh (two boxes in one body) is self-intersecting', () => {
    const a = boxMesh([0, 0, 0], [1, 1, 1]);
    const b = boxMesh([0.5, 0.25, 0.25], [1, 0.5, 0.5]);
    const merged = { positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices.map((index) => index + 8)] };
    const { doc, ids } = meshDoc([merged]);
    const report = prepare(withCase(doc, ids));
    const row = rowOf(report, 'CFD_GEOMETRY_SELF_INTERSECTING');
    expect(row.status).toBe('fail');
    expect(row['pairs']).toBeGreaterThan(0);
    expect((row['examples'] as unknown[]).length).toBeGreaterThan(0);
    expect(rowOf(report, 'CFD_GEOMETRY_NOT_WATERTIGHT').status).toBe('pass');
  });

  it('an inward-oriented closed mesh is flipped with a warning', () => {
    const { doc, ids } = meshDoc([boxMesh([0, 0, 0], [1, 1, 1], true)]);
    const report = prepare(withCase(doc, ids));
    expect((report.surface as Record<string, unknown>)['flipped']).toBe(true);
    expect(report.warnings.join(' ')).toContain('inward oriented');
    expect(rowOf(report, 'CFD_GEOMETRY_NOT_WATERTIGHT').status).toBe('pass');
    expect((report.surface as Record<string, number>)['volumeM3']).toBeCloseTo(1, 9);
  });

  it('an inconsistently wound closed mesh is not watertight (misoriented edges)', () => {
    const box = boxMesh([0, 0, 0], [1, 1, 1]);
    const indices = [...box.indices];
    const [i1, i2] = [indices[1] as number, indices[2] as number];
    indices[1] = i2;
    indices[2] = i1;
    const { doc, ids } = meshDoc([{ positions: box.positions, indices }]);
    const row = rowOf(prepare(withCase(doc, ids)), 'CFD_GEOMETRY_NOT_WATERTIGHT');
    expect(row.status).toBe('fail');
    expect(row['misorientedEdges']).toBeGreaterThan(0);
  });

  it('degenerate triangles are dropped and counted', () => {
    const box = boxMesh([0, 0, 0], [1, 1, 1]);
    const { doc, ids } = meshDoc([{ positions: [...box.positions, 0, 0, 0, 0, 0, 0, 0, 0, 0], indices: [...box.indices, 8, 9, 10] }]);
    const report = prepare(withCase(doc, ids));
    expect((report.surface as Record<string, number>)['degenerateDropped']).toBe(1);
    expect(report.warnings.join(' ')).toContain('degenerate');
  });
});

describe('VC-CFD-12: buildings domain and blockage', () => {
  const tower = addBody(metreDocument(), 'add_box', { size: [1, 1, 2], position: [10, 0, 0], anchor: 'min' });
  const buildings = withCase(tower.doc, [tower.id], {
    freestream: { speedMS: 10 },
    reference: { areaM2: 2, lengthM: 2 },
    domain: { rule: 'buildings' },
    ground: { enabled: true },
  });

  it('a 1:1:2 block gets 5H / 5H / 15H, top at 6H and blockage 0.794 %', () => {
    const report = prepare(buildings);
    const box = report.domain?.box;
    expect(box?.max[2]).toBeCloseTo(refs.blockage.case.tunnelHeight, 9);
    expect(box?.min).toEqual([0, -10, 0]);
    expect(box?.max).toEqual([41, 11, 12]);
    expect(Math.abs((report.blockageRatio as number) / refs.blockage.blockageRatio - 1)).toBeLessThan(1e-6);
    expect(rowOf(report, 'CFD_BLOCKAGE_TOO_HIGH').status).toBe('pass');
    expect(report.defaults.some((entry) => entry.source.includes('COST'))).toBe(true);
  });

  it('a custom domain too small for the body fails on blockage and containment', () => {
    const custom = withCase(tower.doc, [tower.id], {
      reference: { areaM2: 2, lengthM: 2 },
      domain: { rule: 'custom', box: { min: [9, -0.2, 0], max: [12, 1.2, 2.5] } },
    });
    const report = prepare(custom);
    expect(rowOf(report, 'CFD_BLOCKAGE_TOO_HIGH').status).toBe('fail');
    expect(report.status).toBe('fail');
    const outside = withCase(tower.doc, [tower.id], { domain: { rule: 'custom', box: { min: [10.2, 0, 0], max: [20, 1, 1] } } });
    expect(rowOf(prepare(outside), 'CFD_PARAM_INVALID').message).toContain('does not contain');
  });

  it('external aero subsonic is 5L / 5L / 15L around the body, ground pins the bottom', () => {
    const box = addBody(metreDocument(), 'add_box', { size: [2, 1, 1], position: [0, 0, 0], anchor: 'min' });
    const free = prepare(withCase(box.doc, [box.id]));
    expect(free.domain?.box).toEqual({ min: [-10, -10, -10], max: [32, 11, 11] });
    const grounded = prepare(withCase(box.doc, [box.id], { ground: { enabled: true } }));
    expect(grounded.domain?.box.min).toEqual([-10, -10, 0]);
  });

  it('external aero supersonic keeps the Mach cone inside at the outlet', () => {
    const box = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
    const report = prepare(withCase(box.doc, [box.id], { freestream: { mach: 2 } }));
    expect(report.solver).toBe('euler');
    const domain = report.domain?.box;
    expect(domain?.min[0]).toBeCloseTo(-0.5, 9);
    expect(domain?.max[0]).toBeCloseTo(3, 9);
    const cone = (3 - 0) * Math.tan(Math.asin(0.5));
    expect(domain?.max[1]).toBeCloseTo(0.5 + cone + 0.5, 9);
  });

  it('the symmetry plane halves the domain of a symmetric body and refuses an asymmetric one', () => {
    const symmetric = meshDoc([boxMesh([0, -0.5, 0], [1, 1, 1])]);
    const report = prepare(withCase(symmetric.doc, symmetric.ids, { domain: { rule: 'external_aero', symmetryPlane: 'xz' } }));
    expect(report.domain?.box.min[1]).toBe(0);
    expect(report.domain?.box.max[1]).toBeCloseTo(5.5, 9);
    expect(report.checks.some((check) => check.code === 'CFD_PARAM_INVALID')).toBe(false);
    const off = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0.2, 0], anchor: 'min' });
    const bad = prepare(withCase(off.doc, [off.id], { domain: { rule: 'external_aero', symmetryPlane: 'xz' } }));
    expect(rowOf(bad, 'CFD_PARAM_INVALID').message).toContain('mirror-symmetric');
  });
});

describe('VC-CFD-14: preparation is deterministic', () => {
  const build = (): CadDocument => {
    const body = addBody(metreDocument(), 'add_sphere', { radius: 0.5, position: [0, 0, 0] });
    return withCase(body.doc, [body.id]);
  };

  it('gives the same geometryHash after save / load and for a rebuilt document', () => {
    const doc = build();
    const reloaded = JSON.parse(JSON.stringify(doc)) as CadDocument;
    expect(prepare(reloaded).geometryHash).toBe(prepare(doc).geometryHash);
    expect(prepare(build()).geometryHash).toBe(prepare(doc).geometryHash);
    expect(prepare(doc).geometryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replays through build_project to the same hash', () => {
    const plan = [
      { command: 'set_units', params: { units: 'm' } },
      { command: 'add_sphere', params: { radius: 0.5, position: [0, 0, 0] }, as: 'ball' },
      {
        command: 'cfd_create_case',
        params: { id: 'c1', entityIds: ['$ball'], freestream: { speedMS: 1 }, reference: { areaM2: 1, lengthM: 1 } },
      },
    ];
    const first = execute(metreDocument(), 'build_project', { actions: plan });
    const second = execute(metreDocument(), 'build_project', { actions: plan });
    expect(prepare(first.document).geometryHash).toBe(prepare(second.document).geometryHash);
    expect(prepare(first.document).caseHash).toBe(prepare(second.document).caseHash);
  });

  it('changes when the body moves', () => {
    const doc = build();
    const body = Object.keys(doc.entities)[0] as string;
    const moved = ok(doc, 'move_entities', { ids: [body], delta: [1, 0, 0] }).document;
    expect(prepare(moved).geometryHash).not.toBe(prepare(doc).geometryHash);
  });
});

describe('VC-CFD-15: small features', () => {
  it('flags a 2 mm hole in a 1 m box at h = 10 mm', () => {
    const ctx = ctxWith(kernel);
    const box = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' }, ctx);
    const pin = addBody(box.doc, 'add_cylinder', { radius: 0.001, height: 3, position: [0.5, 0.5, 0.5] }, ctx);
    const drilled = ok(pin.doc, 'boolean', { op: 'subtract', a: box.id, b: pin.id }, ctx);
    const body = drilled.affected[0] as string;
    const report = prepare(withCase(drilled.document, [body], { cellsPerReferenceLength: 100 }), {}, ctx);
    const row = rowOf(report, 'CFD_SMALL_FEATURE');
    expect(row.status).toBe('warn');
    expect(report.status).toBe('warn');
    const hole = report.smallFeatures.find((feature) => feature.kind === 'gap');
    expect(Math.abs((hole?.sizeM ?? 1) - 0.002)).toBeLessThan(0.01);
    expect(hole?.entityId).toBe(body);
    expect(hole?.at[0]).toBeCloseTo(0.5, 6);
  });

  it('flags a thin plate and a tiny closed loop, and passes a solid block', () => {
    const plate = addBody(metreDocument(), 'add_box', { size: [1, 1, 0.01], position: [0, 0, 0], anchor: 'min' });
    const thin = prepare(withCase(plate.doc, [plate.id], { cellsPerReferenceLength: 100 }));
    expect(thin.smallFeatures[0]?.kind).toBe('thin_wall');
    expect(thin.smallFeatures[0]?.sizeM).toBeCloseTo(0.01, 6);
    const tiny = addBody(metreDocument(), 'add_cylinder', { radius: 0.005, height: 0.5, position: [0, 0, 0] });
    const loops = prepare(withCase(tiny.doc, [tiny.id], { cellsPerReferenceLength: 100 }));
    expect(loops.smallFeatures.some((feature) => feature.kind === 'small_loop')).toBe(true);
    const block = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
    const solid = prepare(withCase(block.doc, [block.id], { cellsPerReferenceLength: 100 }));
    expect(rowOf(solid, 'CFD_SMALL_FEATURE').status).toBe('pass');
    expect(solid.smallFeatures).toEqual([]);
  });
});

describe('solver choice, memory and options', () => {
  const block = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });

  it('picks lbm below Mach 0.3 and euler above, from speed or Mach', () => {
    expect(prepare(withCase(block.doc, [block.id], { freestream: { speedMS: 50 } })).solver).toBe('lbm');
    expect(prepare(withCase(block.doc, [block.id], { freestream: { speedMS: 200 } })).solver).toBe('euler');
    expect(prepare(withCase(block.doc, [block.id], { freestream: { mach: 0.8, altitudeM: 10000 } })).solver).toBe('euler');
  });

  it('checks the memory against a device and gives the largest resolution that fits', () => {
    const doc = withCase(block.doc, [block.id], { cellsPerReferenceLength: 256 });
    const fits = prepare(doc, { deviceMemoryBytes: 1e12 });
    expect(rowOf(fits, 'CFD_MEMORY_EXCEEDED').status).toBe('pass');
    const small = prepare(doc, { deviceMemoryBytes: 4e9 });
    const row = rowOf(small, 'CFD_MEMORY_EXCEEDED');
    expect(row.status).toBe('fail');
    const largest = row['largestFittingCellsPerReferenceLength'] as number;
    expect(largest).toBeGreaterThan(0);
    expect(largest).toBeLessThan(256);
    const again = prepare(withCase(block.doc, [block.id], { cellsPerReferenceLength: largest }), { deviceMemoryBytes: 4e9 });
    expect(rowOf(again, 'CFD_MEMORY_EXCEEDED').status).toBe('pass');
    expect(small.estimate?.fitsDevice).toBe(false);
  });

  it('estimates an Euler case and lets quality override the case grid', () => {
    const doc = withCase(block.doc, [block.id], { freestream: { mach: 2 }, cellsPerReferenceLength: 32 });
    const base = prepare(doc);
    expect(base.estimate?.solver).toBe('euler');
    expect(base.grid.cellsPerReferenceLength).toBe(32);
    const draft = prepare(doc, { quality: 'draft' });
    expect(draft.grid.cellsPerReferenceLength).toBe(64);
    expect(draft.estimate?.cells).toBeGreaterThan(base.estimate?.cells ?? Infinity);
    expect(draft.defaults.some((entry) => entry.path === 'grid.cellsPerReferenceLength')).toBe(true);
  });

  it('reports a regime error as a fail row without a solver', () => {
    const doc = withCase(block.doc, [block.id], { freestream: { speedMS: 50 } });
    const forced = ok(doc, 'cfd_update_case', { caseId: 'c1', freestream: { speedMS: 50 } }).document;
    const broken = {
      ...forced,
      cfd: { ...forced.cfd!, cases: { c1: { ...forced.cfd!.cases['c1']!, freestream: { alphaDeg: 0, betaDeg: 0 } } } },
    };
    const report = prepare(broken);
    expect(report.status).toBe('fail');
    expect(report.solver).toBeNull();
    expect(report.estimate).toBeNull();
    expect(rowOf(report, 'CFD_PARAM_INVALID').status).toBe('fail');
    expect(rowOf(report, 'CFD_MEMORY_EXCEEDED').status).toBe('not_run');
  });

  it('expands instances of a component and skips 2D sketches and excluded bodies', () => {
    const made = ok(block.doc, 'create_component', { name: 'cube', entityIds: [block.id] });
    const firstInstance = made.affected[0] as string;
    const componentId = Object.keys(made.document.components)[0] as string;
    const placed = ok(made.document, 'insert_instance', { componentId, position: [3, 0, 0] });
    const instance = placed.affected[0] as string;
    const line = ok(placed.document, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    const sketch = line.affected[0] as string;
    const report = prepare(withCase(line.document, [firstInstance, instance, sketch]));
    expect((report.surface as Record<string, number>)['bodies']).toBe(2);
    expect((report.surface as Record<string, number>)['volumeM3']).toBeCloseTo(2, 9);
    expect(report.warnings.join(' ')).toContain(sketch);
  });

  it('a case with only 2D entities or only excluded bodies has no geometry', () => {
    const line = ok(metreDocument(), 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    const sketch = line.affected[0] as string;
    const flat = prepare(withCase(line.document, [sketch]));
    expect(rowOf(flat, 'CFD_NO_GEOMETRY').status).toBe('fail');
    expect(flat.surface).toBeNull();
    expect(flat.status).toBe('fail');
    const excluded = prepare(withCase(block.doc, [block.id], { excludedEntityIds: [block.id] }));
    expect(rowOf(excluded, 'CFD_NO_GEOMETRY').status).toBe('fail');
  });
});

describe('cfd_prepare command', () => {
  const body = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
  const doc = withCase(body.doc, [body.id]);

  it('is pure and read-only', () => {
    expectPure(doc, () => execute(doc, 'cfd_prepare', { caseId: 'c1' }));
    const result = execute(doc, 'cfd_prepare', { caseId: 'c1' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('cfd_prepare c1: pass');
  });

  it('refuses an unknown case and a bad device memory', () => {
    expectRefusal(doc, 'cfd_prepare', { caseId: 'nope' }, 'CFD_CASE_NOT_FOUND', 'caseId');
    expectRefusal(doc, 'cfd_prepare', { caseId: 'c1', deviceMemoryBytes: -1 }, 'CFD_PARAM_INVALID', 'deviceMemoryBytes');
    expectNoOp(execute(doc, 'cfd_prepare', { caseId: 'nope' }), doc);
  });

  it('summarises failures by code', () => {
    const open = boxMesh([0, 0, 0], [1, 1, 1]);
    const meshes = meshDoc([{ positions: open.positions, indices: open.indices.slice(0, 30) }]);
    const result = execute(withCase(meshes.doc, meshes.ids), 'cfd_prepare', { caseId: 'c1' });
    expect(result.summary).toContain('CFD_GEOMETRY_NOT_WATERTIGHT');
  });
});
