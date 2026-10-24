/** M5 operations: section_field (VC-IMP-38), infill_solid (VC-IMP-23), measured wall / pore / overhang checks (VC-IMP-37), mechanics (VC-IMP-47), 3MF beam lattice (VC-IMP-30), STEP skip (VC-IMP-32). */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { base64ToUint8Array } from '@lib/base64';
import { expectPure } from '../../helpers/expectNoOp';
import { fakeKernel } from '../../helpers/fakeKernel';
import { unzip } from '../../helpers/unzipStore';
import { empty, expectRefused, ok, run } from './helpers';

const model = (data: Record<string, unknown>): string => {
  const files = unzip(base64ToUint8Array(data['base64'] as string) ?? new Uint8Array());
  return new TextDecoder().decode(files.get('3D/3dmodel.model'));
};

/** Untyped JSON read from a command result (any depth). */
interface Dyn {
  readonly [key: string]: Dyn;
}

describe('section_field (VC-IMP-38)', () => {
  it('a sphere section has the area pi R^2 and one outer loop', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 10 });
    const cut = ok(sphere.doc, 'section_field', {
      id: sphere.id,
      plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
      size: 24,
      resolution: 400,
    });
    expect(Math.abs((cut.data['solidArea'] as number) - Math.PI * 100) / (Math.PI * 100)).toBeLessThan(0.002);
    const loops = cut.data['loops'] as Array<{ role: string; area: number; points: number[][] }>;
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ role: 'outer' });
    expect(loops[0]?.points.length).toBeLessThanOrEqual(2000);
    expect(cut.data['solidFraction'] as number).toBeCloseTo((Math.PI * 100) / 576, 2);
    const tilted = ok(sphere.doc, 'section_field', {
      id: sphere.id,
      plane: { origin: [0, 0, 0], normal: [1, 2, 3] },
      size: 24,
      resolution: 200,
    });
    expect(Math.abs((tilted.data['solidArea'] as number) - Math.PI * 100) / (Math.PI * 100)).toBeLessThan(0.005);
    const off = ok(sphere.doc, 'section_field', {
      id: sphere.id,
      plane: { origin: [0, 0, 6], normal: [0, 0, 1] },
      size: 24,
      resolution: 200,
    });
    expect(Math.abs((off.data['solidArea'] as number) - Math.PI * 64) / (Math.PI * 64)).toBeLessThan(0.005);
  });

  it('a gyroid network section at z = 0 has the solid fraction 1/2 by odd symmetry', () => {
    const lattice = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 10 });
    const cut = ok(lattice.doc, 'section_field', {
      id: lattice.id,
      plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
      size: 20,
      resolution: 400,
    });
    expect(Math.abs((cut.data['solidFraction'] as number) - 0.5)).toBeLessThan(0.002);
    expect(Math.abs((cut.data['sampleSolidFraction'] as number) - 0.5)).toBeLessThan(0.01);
    expect(cut.data['svg']).toBeUndefined();
  });

  it('a ring has an outer loop and a hole of negative area; svg returns a drawing; a body can be cut like a field', () => {
    const outer = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 10 });
    const inner = ok(outer.doc, 'add_field_primitive', { shape: 'sphere', radius: 6 });
    const hollow = ok(inner.doc, 'combine_fields', { op: 'subtract', a: outer.id, b: inner.id });
    const body = ok(hollow.doc, 'create_implicit_body', { field: hollow.id, voxel: 0.5 });
    const cut = ok(body.doc, 'section_field', {
      id: body.id,
      plane: { origin: [0, 0, 0], normal: [0, 1, 0] },
      size: 24,
      resolution: 300,
      svg: true,
    });
    const loops = cut.data['loops'] as Array<{ role: string; area: number }>;
    expect(loops.map((l) => l.role)).toEqual(['outer', 'hole']);
    expect((loops[1]?.area as number) < 0).toBe(true);
    expect(Math.abs((cut.data['solidArea'] as number) - Math.PI * (100 - 36)) / (Math.PI * 64)).toBeLessThan(0.005);
    expect(String(cut.data['svg'])).toContain('<svg');
    expect(String(cut.data['svg'])).toContain('<path');
  });

  it('refuses unknown targets and bad geometry, and is pure', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 1 });
    const plane = { origin: [0, 0, 0], normal: [0, 0, 1] };
    expectRefused(sphere.doc, run(sphere.doc, 'section_field', { id: 'nope', plane, size: 4 }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(sphere.doc, run(sphere.doc, 'section_field', { id: sphere.id, plane, size: 0 }), 'IMP_PARAM_RANGE');
    expectRefused(sphere.doc, run(sphere.doc, 'section_field', { id: sphere.id, plane, size: 4, resolution: 7 }), 'IMP_PARAM_RANGE');
    expectRefused(sphere.doc, run(sphere.doc, 'section_field', { id: sphere.id, plane, size: 4, resolution: 401 }), 'IMP_PARAM_RANGE');
    expectRefused(
      sphere.doc,
      run(sphere.doc, 'section_field', { id: sphere.id, plane: { origin: [0, 0, 0], normal: [0, 0, 0] }, size: 4 }),
      'IMP_PARAM_RANGE',
    );
    expectPure(sphere.doc, () => run(sphere.doc, 'section_field', { id: sphere.id, plane, size: 4 }));
  });
});

describe('infill_solid (VC-IMP-23)', () => {
  const cube = (): ReturnType<typeof ok> => ok(empty(), 'add_box', { size: [20, 20, 20] });

  it('composes the field commands, hides the source and reports the lighter volume', () => {
    const box = cube();
    const made = ok(box.doc, 'infill_solid', {
      entityId: box.id,
      wall: 1.5,
      lattice: { type: 'tpms', kind: 'gyroid', form: 'network', level: 0, cellSize: 8 },
      voxel: 0.5,
    });
    const steps = made.data['steps'] as Array<{ command: string }>;
    expect(steps.map((s) => s.command)).toEqual([
      'field_from_solid',
      'shell_field',
      'offset_field',
      'add_tpms_lattice',
      'combine_fields',
      'create_implicit_body',
    ]);
    expect(made.doc.entities[box.id]?.layerId).toBe('layer-implicit-hidden');
    const lighter = made.data['lighterFraction'] as number;
    expect(lighter).toBeGreaterThan(0.25);
    expect(lighter).toBeLessThan(0.4);
    expect(made.result.affected[0]).toBe(made.data['id']);
    expect(Object.keys(made.data['fields'] as object)).toEqual(['source', 'skin', 'inner', 'lattice', 'part']);
    expect(ok(made.doc, 'check_implicit', { id: made.data['id'] }).data['status']).toBeDefined();
  }, 60_000);

  it('accepts a strut infill, an opening, drain holes and a graded lattice', () => {
    const box = cube();
    const struts = ok(box.doc, 'infill_solid', {
      entityId: box.id,
      wall: 2,
      lattice: { type: 'struts', cell: 'octet', cellSize: 8, radius: 0.5 },
      voxel: 0.5,
      name: 'lightened',
      color: '#336699',
    });
    expect(struts.doc.entities[struts.data['id'] as string]).toMatchObject({ name: 'lightened', color: '#336699' });
    const hole = ok(box.doc, 'add_field_primitive', { shape: 'cylinder', radius: 3, height: 30, position: [0, 0, 0] });
    const opened = ok(hole.doc, 'infill_solid', {
      entityId: box.id,
      wall: 2,
      lattice: { type: 'tpms', kind: 'diamond', form: 'sheet', thickness: 0.8, cellSize: 8 },
      openBy: hole.id,
      drainHoles: { diameter: 2, count: 3 },
      voxel: 0.5,
    });
    expect((opened.data['steps'] as Array<{ command: string }>).filter((s) => s.command === 'add_field_primitive')).toHaveLength(3);
    const single = ok(box.doc, 'infill_solid', {
      entityId: box.id,
      wall: 2,
      lattice: { type: 'tpms', kind: 'gyroid', form: 'sheet', relativeDensity: 0.2, cellSize: 10 },
      drainHoles: { diameter: 3, count: 1 },
      voxel: 0.5,
    });
    expect(single.data['volumeBody'] as number).toBeLessThan(8000);
  }, 120_000);

  it('returns the refusal of the composed step with its own code and leaves the document unchanged', () => {
    const box = cube();
    const lattice = { type: 'tpms', kind: 'gyroid', form: 'sheet', thickness: 9, cellSize: 8 };
    const base = { entityId: box.id, wall: 1.5, lattice, voxel: 0.5 };
    const bad = run(box.doc, 'infill_solid', base);
    expectRefused(box.doc, bad, 'IMP_TPMS_CONTROL_RANGE');
    expect(bad.result.summary).toContain('step 4 (add_tpms_lattice)');
    const good = { ...base, lattice: { ...lattice, thickness: 1 } };
    expectRefused(box.doc, run(box.doc, 'infill_solid', { ...good, wall: 0 }), 'IMP_PARAM_RANGE');
    expectRefused(box.doc, run(box.doc, 'infill_solid', { ...good, voxel: -1 }), 'IMP_PARAM_RANGE');
    expectRefused(box.doc, run(box.doc, 'infill_solid', { ...good, entityId: 'nope' }), 'IMP_ENTITY_NOT_FOUND');
    expectRefused(box.doc, run(box.doc, 'infill_solid', { ...good, openBy: 'nope' }), 'IMP_FIELD_NOT_FOUND');
    expectRefused(box.doc, run(box.doc, 'infill_solid', { ...good, drainHoles: { diameter: 0, count: 1 } }), 'IMP_PARAM_RANGE');
    expectRefused(box.doc, run(box.doc, 'infill_solid', { ...good, drainHoles: { diameter: 1, count: 40 } }), 'IMP_PARAM_RANGE');
    expectRefused(box.doc, run(box.doc, 'infill_solid', { ...good, voxel: 0.01 }), 'IMP_GRID_BUDGET');
    const line = ok(box.doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    expectRefused(line.doc, run(line.doc, 'infill_solid', { ...good, entityId: line.id }), 'IMP_SOLID_NOT_CLOSED');
    expectPure(box.doc, () => run(box.doc, 'infill_solid', good));
  });
});

describe('check_implicit: measured walls, pores and overhang', () => {
  const body = (
    build: (doc: ReturnType<typeof empty>) => { doc: ReturnType<typeof empty>; id: string },
    voxel: number,
  ): { doc: ReturnType<typeof empty>; id: string } => {
    const made = build(empty());
    const realised = ok(made.doc, 'create_implicit_body', { field: made.id, voxel });
    return { doc: realised.doc, id: realised.id };
  };
  const verdict = (target: { doc: ReturnType<typeof empty>; id: string }, process: Record<string, unknown>): Record<string, unknown> =>
    ok(target.doc, 'check_implicit', { id: target.id, process: { source: 'owner-supplied', ...process } }).data;
  const findings = (data: Record<string, unknown>): Array<{ code: string; severity: string; value: number | null }> =>
    data['findings'] as Array<{ code: string; severity: string; value: number | null }>;

  it('overhang of a sphere for +Z and 45 degrees is 2 pi R^2 (1 - cos 45) (VC-IMP-37)', () => {
    const sphere = body((doc) => {
      const s = ok(doc, 'add_field_primitive', { shape: 'sphere', radius: 10 });
      return { doc: s.doc, id: s.id };
    }, 0.25);
    const data = verdict(sphere, { buildDirection: [0, 0, 1], criticalAngleDeg: 45 });
    const found = findings(data).find((f) => f.code === 'IMP_CHECK_OVERHANG');
    expect(found?.severity).toBe('warn');
    expect(Math.abs((found?.value as number) - 184.03) / 184.03).toBeLessThan(0.01);
    expect((data['overhang'] as { flattestDeg: number }).flattestDeg).toBeLessThan(2);
    const wall = verdict(sphere, { buildDirection: [0, 0, 1] });
    expect(wall['notEvaluated']).toContain('overhang');
    const none = verdict(sphere, { buildDirection: [0, 0, 1], criticalAngleDeg: 1 });
    expect(findings(none).filter((f) => f.code === 'IMP_CHECK_OVERHANG').length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('a shell wall is measured by the distance transform and judged against the limit with the resolution band', () => {
    const shell = body((doc) => {
      const s = ok(doc, 'add_field_primitive', { shape: 'sphere', radius: 10 });
      const wall = ok(s.doc, 'shell_field', { field: s.id, thickness: 2 });
      return { doc: wall.doc, id: wall.id };
    }, 0.25);
    const data = verdict(shell, { minWallMm: 1 });
    const measured = data['measured'] as { available: boolean; wallMin: number; wallMax: number; voxel: number };
    expect(measured.available).toBe(true);
    expect(measured.wallMin).toBeGreaterThan(1.4);
    expect(measured.wallMax).toBeLessThan(2.2);
    expect(findings(data).some((f) => f.code === 'IMP_CHECK_MIN_WALL')).toBe(false);
    const fail = findings(verdict(shell, { minWallMm: 3 })).find((f) => f.code === 'IMP_CHECK_MIN_WALL');
    expect(fail?.severity).toBe('fail');
    const near = findings(verdict(shell, { minWallMm: 1.8 })).find((f) => f.code === 'IMP_CHECK_MIN_WALL');
    expect(near?.severity).toBe('warn');
  }, 60_000);

  it('a narrow gap between two plates is a pore; a wide one passes', () => {
    const plates = body((doc) => {
      const a = ok(doc, 'add_field_primitive', { shape: 'box', size: [12, 12, 3], position: [0, 0, -2.25] });
      const b = ok(a.doc, 'add_field_primitive', { shape: 'box', size: [12, 12, 3], position: [0, 0, 2.25] });
      const bridge = ok(b.doc, 'add_field_primitive', { shape: 'box', size: [3, 12, 6], position: [-4.5, 0, 0] });
      const u = ok(bridge.doc, 'combine_fields', { op: 'union', a: a.id, b: [b.id, bridge.id] });
      return { doc: u.doc, id: u.id };
    }, 0.25);
    const data = verdict(plates, { minPoreMm: 3 });
    const pore = findings(data).find((f) => f.code === 'IMP_CHECK_MIN_PORE');
    expect(pore?.severity).toBe('fail');
    expect((data['measured'] as { poreMin: number }).poreMin).toBeLessThan(1.8);
    expect(findings(verdict(plates, { minPoreMm: 0.5 })).some((f) => f.code === 'IMP_CHECK_MIN_PORE')).toBe(false);
  }, 60_000);

  it('falls back to the declared size when the wall is too thin to measure', () => {
    const thin = body((doc) => {
      const s = ok(doc, 'add_field_primitive', { shape: 'sphere', radius: 3 });
      const wall = ok(s.doc, 'shell_field', { field: s.id, thickness: 0.3 });
      return { doc: wall.doc, id: wall.id };
    }, 0.2);
    const data = verdict(thin, { minWallMm: 0.5 });
    expect(findings(data).find((f) => f.code === 'IMP_CHECK_MIN_WALL')).toMatchObject({ severity: 'fail', value: 0.3 });
  });
});

describe('lattice mechanics (VC-IMP-47)', () => {
  it('the octet truss has the affine stiffness E = rho Es / 9 along the cube axes and is flagged unverified', () => {
    const lattice = ok(empty(), 'add_strut_lattice', { cell: 'octet', cellSize: 10, radius: 0.5 });
    const data = ok(lattice.doc, 'lattice_properties', {
      id: lattice.id,
      estimateMechanics: true,
      baseMaterial: { youngModulusMpa: 70000, source: 'data sheet' },
      scaling: { exponent: 1, coefficient: 0.11 },
    }).data;
    const mechanics = data['mechanics'] as Dyn;
    expect(mechanics['unverified']).toBe(true);
    expect(mechanics['reviewRequired']).toBe(true);
    expect(mechanics['warning']).toBe('IMP_MECHANICS_UNVERIFIED');
    expect(data['unverified']).toBe(true);
    const rho = data['rhoMeasured'] as number;
    const affine = mechanics['affine'] as unknown as {
      youngRatio: number[];
      valid: boolean;
      bulkRatio: number;
      shearRatio: number[];
      poisson: number[];
    };
    expect(affine.valid).toBe(true);
    for (const e of affine.youngRatio) expect(Math.abs(e - rho / 9) / (rho / 9)).toBeLessThan(1e-9);
    expect(Math.abs(affine.bulkRatio - rho / 9)).toBeLessThan(1e-9);
    expect(affine.poisson[0]).toBeCloseTo(1 / 3, 9);
    expect(mechanics['stiffnessRatio']).toBeCloseTo(0.11 * rho, 12);
    expect(mechanics['youngModulusMpa']).toBeCloseTo(0.11 * rho * 70000, 6);
    expect(mechanics['exponent']).toBe(1);
  });

  it('a bending-dominated cell gets an upper bound and exponent 2; TPMS lattices need your scaling law', () => {
    const bcc = ok(empty(), 'add_strut_lattice', { cell: 'bcc', cellSize: 10, radius: 0.5 });
    const data = ok(bcc.doc, 'lattice_properties', { id: bcc.id, estimateMechanics: true }).data['mechanics'] as Dyn;
    expect(data['exponent']).toBe(2);
    expect(data['affine']?.['valid']).toBe(false);
    expect(String(data['affine']?.['note'])).toContain('UPPER bound');
    expect(data['stiffnessRatio']).toBeNull();
    expect(data['coefficientBasis']).toContain('give scaling');
    const cubic = ok(empty(), 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 0.5 });
    const cubicData = ok(cubic.doc, 'lattice_properties', { id: cubic.id, estimateMechanics: true }).data['mechanics'] as Dyn;
    expect(cubicData['affine']?.['youngRatio']?.['0']).toBeGreaterThan(0);
    expect(cubicData['affine']?.['shearRatio']).toEqual([0, 0, 0]);
    const tpms = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.6, cellSize: 10 });
    const noLaw = ok(tpms.doc, 'lattice_properties', { id: tpms.id, estimateMechanics: true, resolution: 32 }).data['mechanics'] as Dyn;
    expect(noLaw['exponent']).toBeNull();
    expect(noLaw['affine']).toBeNull();
    expect(noLaw['exponentBasis']).toContain('no verified law');
    const withLaw = ok(tpms.doc, 'lattice_properties', {
      id: tpms.id,
      estimateMechanics: true,
      resolution: 32,
      scaling: { exponent: 1.5, coefficient: 0.8 },
    }).data['mechanics'] as Dyn;
    expect(withLaw['stiffnessRatio']).toBeGreaterThan(0);
    expect(withLaw['exponentBasis']).toBe('caller');
    const plain = ok(tpms.doc, 'lattice_properties', { id: tpms.id, resolution: 32 }).data;
    expect(plain['mechanics']).toBeUndefined();
    expect(plain['unverified']).toBe(false);
  });
});

describe('3MF beam lattice (VC-IMP-30) and STEP skip (VC-IMP-32)', () => {
  const block = (extra: Record<string, unknown> = {}): { doc: ReturnType<typeof empty>; body: string } => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });
    const lattice = ok(box.doc, 'add_strut_lattice', { cell: 'octet', cellSize: 10, radius: 0.5, region: box.id, ...extra });
    const made = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.4 });
    return { doc: made.doc, body: made.id };
  };

  it('writes the octet 2x2x2 block as 63 nodes and 240 beams with the beam-lattice namespace, a clipping mesh and the representation mesh', () => {
    const { doc, body } = block();
    const result = execute(doc, 'export_3mf', { entityIds: [body], beamLattice: true });
    const data = result.data as Dyn;
    expect(data['beamLattice']).toMatchObject({ written: [body], skipped: [], beams: 240 });
    expect(data['objects']).toEqual([expect.objectContaining({ vertices: 63, triangles: 0, beams: 240 })]);
    const xml = model(data);
    expect(xml).toContain('xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02"');
    expect(xml).toContain('requiredextensions="b"');
    expect(xml.match(/<b:beam /g)).toHaveLength(240);
    expect(xml).toMatch(/minlength="[0-9.]+"/);
    expect(xml).toContain('clippingmode="inside"');
    expect(xml).toMatch(/clippingmesh="\d+"/);
    expect(xml).not.toContain('representationmesh');
    expect(xml.match(/type="other"/g)).toHaveLength(1);
    const withMesh = model(execute(doc, 'export_3mf', { entityIds: [body], beamLattice: true, beamRepresentation: true }).data as Dyn);
    expect(withMesh).toMatch(/representationmesh="\d+"/);
    expect(withMesh.match(/type="other"/g)).toHaveLength(2);
    expect(xml.match(/<item /g)).toHaveLength(1);
    expect(result.summary).toContain('240 beams');
  });

  it('is far smaller than the mesh and node balls add the balls extension', () => {
    const { doc, body } = block();
    const mesh = execute(doc, 'export_3mf', { entityIds: [body] }).data as Dyn;
    const lattice = execute(doc, 'export_3mf', { entityIds: [body], beamLattice: true }).data as Dyn;
    expect(model(lattice).length).toBeLessThan(model(mesh).length);
    const balls = block({ nodeRadius: 0.8 });
    const withBalls = model(execute(balls.doc, 'export_3mf', { entityIds: [balls.body], beamLattice: true }).data as Dyn);
    expect(withBalls).toContain('requiredextensions="b b2"');
    expect(withBalls).toContain('b2:ballmode="all"');
  });

  it('keeps TPMS and other bodies as meshes and says why; graph lattices and graded radii become beams', () => {
    const tpms = ok(empty(), 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
    const lattice = ok(tpms.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.8, cellSize: 5, region: tpms.id });
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.4 });
    const data = execute(body.doc, 'export_3mf', { entityIds: [body.id], beamLattice: true }).data as Dyn;
    expect(data['beamLattice']?.['written']).toEqual([]);
    expect(data['beamLattice']?.['skipped']?.['0']?.['reason']).toContain('not a strut or graph lattice');
    expect(data['triangleCount']).toBeGreaterThan(1000);
    const line = ok(empty(), 'draw_polyline', {
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    });
    const graph = ok(line.doc, 'add_graph_lattice', { sourceIds: [line.id], radiusStart: 1, radiusEnd: 0.5, cap: 'butt' });
    const graphBody = ok(graph.doc, 'create_implicit_body', { field: graph.id, voxel: 0.3 });
    const graphData = execute(graphBody.doc, 'export_3mf', { entityIds: [graphBody.id], beamLattice: true }).data as Dyn;
    expect(graphData['objects']?.['0']).toMatchObject({ beams: 2, vertices: 3 });
    expect(model(graphData)).toContain('cap1="butt"');
    const z = ok(empty(), 'create_scalar_field', { kind: 'coordinate', axis: 'z' });
    const radius = ok(z.doc, 'create_scalar_field', { kind: 'ramp', input: z.id, inMin: 0, inMax: 20, outMin: 0.3, outMax: 1 });
    const box = ok(radius.doc, 'add_field_primitive', { shape: 'box', size: [10, 10, 20], position: [5, 5, 10] });
    const graded = ok(box.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: radius.id, region: box.id });
    const gradedBody = ok(graded.doc, 'create_implicit_body', { field: graded.id, voxel: 0.4 });
    const gradedXml = model(execute(gradedBody.doc, 'export_3mf', { entityIds: [gradedBody.id], beamLattice: true }).data as Dyn);
    const radii = [...gradedXml.matchAll(/r1="([0-9.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...radii)).toBeGreaterThan(Math.min(...radii) + 0.3);
  }, 60_000);

  it('lists an implicit body as skipped in the STEP export with IMP_STEP_NOT_EXACT', () => {
    const { doc, body } = block();
    const result = execute(
      doc,
      'export_step_ap242',
      { entityIds: [body], includeValidationProperties: false },
      { ...defaultContext(), kernel: fakeKernel({ step: 'ISO-10303-21;' }) },
    );
    expect(result.summary).toContain('IMP_STEP_NOT_EXACT');
  });
});
