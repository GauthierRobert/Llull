/** M5 lattices (05 IMP FR-IMP-17, 18; VC-IMP-17, 18, 25, 26, 27, 30): eight TPMS families, nine strut cells, spherical maps, graph lattices, dangling struts. */
import { describe, expect, it } from 'vitest';
import { expectPure } from '../../helpers/expectNoOp';
import { empty, expectRefused, ok, run } from './helpers';

const KINDS = ['gyroid', 'schwarz_p', 'diamond', 'neovius', 'iwp', 'lidinoid', 'fischer_koch_s', 'split_p'] as const;

describe('TPMS families', () => {
  it('every family has a unit-gradient wall when normalised: |grad f| = 1 on the surface (the physical gradient of F is right)', () => {
    for (const kind of KINDS) {
      const lattice = ok(empty(), 'add_tpms_lattice', { kind, form: 'sheet', thickness: 0.05, cellSize: 4 });
      let points: number[][] = Array.from({ length: 300 }, (_, n) =>
        [0, 1, 2].map((a) => ((0.5 + (n + 1) * [0.8191725, 0.6710436, 0.5497004][a]!) % 1) * 4),
      );
      for (let pass = 0; pass < 8; pass += 1) {
        const answer = ok(lattice.doc, 'evaluate_field', { field: lattice.id, points, gradient: true }).data;
        const values = answer['values'] as number[];
        const gradients = answer['gradients'] as number[];
        points = points.map((p, i) => {
          const g = [gradients[3 * i], gradients[3 * i + 1], gradients[3 * i + 2]] as number[];
          const norm2 = g[0]! ** 2 + g[1]! ** 2 + g[2]! ** 2;
          // Newton step towards f = 0 (the wall face at half the thickness from F = 0)
          const step = ((values[i] as number) - 0) / Math.max(norm2, 1e-12);
          return [p[0]! - step * g[0]!, p[1]! - step * g[1]!, p[2]! - step * g[2]!];
        });
      }
      const answer = ok(lattice.doc, 'evaluate_field', { field: lattice.id, points, gradient: true }).data;
      const values = answer['values'] as number[];
      const gradients = answer['gradients'] as number[];
      const converged = points.map((_, i) => i).filter((i) => Math.abs(values[i] as number) < 1e-8);
      expect(converged.length, kind).toBeGreaterThan(150);
      const norms = converged.map((i) => Math.hypot(gradients[3 * i]!, gradients[3 * i + 1]!, gradients[3 * i + 2]!));
      const mean = norms.reduce((a, b) => a + b, 0) / norms.length;
      expect(Math.abs(mean - 1), kind).toBeLessThan(0.03);
    }
  });

  it('Neovius, Fischer-Koch S and the other level-0 networks fill their symmetric fraction; the rest match the measured fractions (VC-IMP-27)', () => {
    const expected: Record<string, [number, number]> = {
      neovius: [0.5, 2e-3],
      fischer_koch_s: [0.5, 2e-3],
      iwp: [0.4693, 5e-3],
      lidinoid: [0.3842, 5e-3],
      split_p: [0.51, 5e-3],
    };
    for (const [kind, [fraction, tolerance]] of Object.entries(expected)) {
      const lattice = ok(empty(), 'add_tpms_lattice', { kind, form: 'network', level: 0, cellSize: 10 });
      const density = ok(lattice.doc, 'lattice_properties', { id: lattice.id, resolution: 64 }).data['rhoMeasured'] as number;
      expect(Math.abs(density - fraction), kind).toBeLessThan(tolerance);
    }
  });

  it('measures the specific surface of families without a reference value, and walls / pores by the distance transform', () => {
    const lattice = ok(empty(), 'add_tpms_lattice', { kind: 'neovius', form: 'sheet', thickness: 1, cellSize: 12 });
    const data = ok(lattice.doc, 'lattice_properties', { id: lattice.id, resolution: 48 }).data;
    expect(data['specificSurface'] as number).toBeGreaterThan(0.1);
    expect(String(data['specificSurfaceNote'])).toContain('measured');
    expect(data['wallThicknessMeasured'] as number).toBeGreaterThan(0.5);
    expect(data['wallThicknessMeasured'] as number).toBeLessThan(1.5);
    expect(data['poreDiameterMax'] as number).toBeGreaterThan(2);
    const reference = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 1, cellSize: 12 });
    const gyroid = ok(reference.doc, 'lattice_properties', { id: reference.id, resolution: 48 }).data;
    expect(gyroid['specificSurface'] as number).toBeCloseTo((2 * 3.0916 * 144) / 1728, 6);
  });

  it('refuses a level outside the range of each family', () => {
    const doc = empty();
    for (const [kind, level] of [
      ['neovius', 14],
      ['iwp', 6],
      ['lidinoid', 2],
      ['fischer_koch_s', 1.5],
      ['split_p', 2],
    ] as const)
      expectRefused(doc, run(doc, 'add_tpms_lattice', { kind, form: 'network', level, cellSize: 5 }), 'IMP_TPMS_CONTROL_RANGE');
  });
});

describe('strut cells', () => {
  const bookkeeping = (cell: string): Record<string, unknown> => {
    const lattice = ok(empty(), 'add_strut_lattice', { cell, cellSize: 10, radius: 0.5 });
    return ok(lattice.doc, 'lattice_properties', { id: lattice.id, resolution: 32 }).data;
  };

  it('each new cell has its beams, strut length and class', () => {
    const cases: Array<[string, number, number]> = [
      ['diamond', 16, (16 * Math.sqrt(3)) / 4],
      ['kelvin', 24, (24 * Math.SQRT2) / 4],
      ['bccz', 9, 4 * Math.sqrt(3) + 1],
      ['fccz', 7, 6 * Math.SQRT2 + 1],
      ['reentrant', 24, 24 * 0.75],
    ];
    for (const [cell, beams, lengthPerCell] of cases) {
      const data = bookkeeping(cell);
      expect(data['beamsPerCell'], cell).toBe(beams);
      expect((data['lengthPerCell'] as number) / 10, cell).toBeCloseTo(lengthPerCell, 9);
      expect((data['maxwell'] as { class: string }).class).toBe('bending');
      expect(String((data['maxwell'] as { basis: string }).basis)).toContain('assigned by llull');
    }
    expect(bookkeeping('kelvin')['valence'] as { min: number; max: number }).toEqual({ min: 4, max: 4 });
    expect(bookkeeping('diamond')['valence'] as { min: number; max: number }).toEqual({ min: 4, max: 4 });
  });

  it('the literature cells keep their class and basis', () => {
    expect((bookkeeping('octet')['maxwell'] as { class: string; basis: string }).class).toBe('stretch');
    expect((bookkeeping('octet')['maxwell'] as { basis: string }).basis).toContain('Deshpande');
  });

  it('the periodic density follows rho1 for each new cell and the strut radius rule uses the shortest strut', () => {
    for (const cell of ['diamond', 'kelvin', 'bccz', 'fccz', 'reentrant']) {
      const data = bookkeeping(cell);
      const rho1 = data['rho1'] as number;
      expect(Math.abs((data['rhoMeasured'] as number) - rho1) / rho1, cell).toBeLessThan(cell === 'reentrant' ? 0.2 : 0.12);
    }
    const doc = empty();
    expectRefused(doc, run(doc, 'add_strut_lattice', { cell: 'kelvin', cellSize: 10, radius: 1.8 }), 'IMP_STRUT_RADIUS_RANGE');
  });

  it('realises a clipped kelvin lattice as a closed manifold', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });
    const lattice = ok(box.doc, 'add_strut_lattice', { cell: 'kelvin', cellSize: 10, radius: 0.6, region: box.id });
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.3 });
    expect(body.data['closedManifold']).toBe(true);
  }, 60_000);
});

describe('dangling struts (VC-IMP-18) and 3MF counts', () => {
  it('a block of whole cells has no dangling strut; a box that cuts cells reports them with bounds equal to the region', () => {
    const aligned = ok(empty(), 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });
    const exact = ok(aligned.doc, 'add_strut_lattice', { cell: 'octet', cellSize: 10, radius: 0.5, region: aligned.id });
    const clean = ok(exact.doc, 'lattice_properties', { id: exact.id }).data;
    expect(clean['danglingStruts']).toBe(0);
    expect(clean['nodes']).toBe(63);
    expect(clean['beams']).toBe(240);
    const cut = ok(empty(), 'add_field_primitive', { shape: 'box', size: [17, 13, 11], position: [8, 6, 5], rotation: [0, 0, 0] });
    const lattice = ok(cut.doc, 'add_strut_lattice', { cell: 'octet', cellSize: 10, radius: 0.5, region: cut.id });
    const info = ok(lattice.doc, 'lattice_properties', { id: lattice.id }).data;
    expect(info['danglingStruts'] as number).toBeGreaterThan(10);
    expect(info['cutBeams']).toMatchObject({ available: true });
    const unclipped = ok(empty(), 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 0.5 });
    expect(ok(unclipped.doc, 'lattice_properties', { id: unclipped.id }).data['danglingStruts']).toBeNull();
  });
});

describe('spherical maps (FR-IMP-17)', () => {
  const map = { kind: 'spherical', origin: [0, 0, 0], cellsAround: 8, cellsPolar: 4, radialCellSize: 3 };

  it('the field is continuous across the longitude seam and carries the pole warning and the cell stretch', () => {
    const lattice = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.3, cellSize: 3, map });
    expect((lattice.data['warnings'] as Array<{ code: string }>).map((w) => w.code)).toContain('IMP_MAP_POLE');
    const r = 7;
    const below = [r * Math.cos(1e-9 - 0), r * Math.sin(1e-9), 2];
    const above = [r * Math.cos(-1e-9), r * Math.sin(-1e-9), 2];
    const values = ok(lattice.doc, 'evaluate_field', { field: lattice.id, points: [below, above] }).data['values'] as number[];
    expect(Math.abs((values[0] as number) - (values[1] as number))).toBeLessThan(1e-6);
  });

  it('refuses fractional counts with IMP_MAP_SEAM, both a map and an origin, and a density target', () => {
    const doc = empty();
    const base = { kind: 'gyroid', form: 'sheet', thickness: 0.3, cellSize: 3 };
    for (const bad of [
      { ...map, cellsAround: 6.5 },
      { ...map, cellsPolar: 2.5 },
      { ...map, cellsPolar: 0 },
    ])
      expectRefused(doc, run(doc, 'add_tpms_lattice', { ...base, map: bad }), 'IMP_MAP_SEAM');
    expectRefused(doc, run(doc, 'add_tpms_lattice', { ...base, map, origin: [1, 0, 0] }), 'IMP_PARAM_CONFLICT');
    expectRefused(
      doc,
      run(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', relativeDensity: 0.3, cellSize: 3, map }),
      'IMP_PARAM_CONFLICT',
    );
    expectRefused(doc, run(doc, 'add_tpms_lattice', { ...base, map: { ...map, radialCellSize: 0 } }), 'IMP_PARAM_RANGE');
  });

  it('lattice_properties reports the cell stretch of a mapped region', () => {
    const outer = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 12 });
    const inner = ok(outer.doc, 'add_field_primitive', { shape: 'sphere', radius: 6 });
    const shell = ok(inner.doc, 'combine_fields', { op: 'subtract', a: outer.id, b: inner.id });
    const lattice = ok(shell.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 0.4,
      cellSize: 3,
      map,
      region: shell.id,
    });
    const data = ok(lattice.doc, 'lattice_properties', { id: lattice.id, resolution: 24 }).data;
    expect(data['cellStretchMin'] as number).toBeGreaterThan(0.9);
    expect(data['cellStretchMax'] as number).toBeGreaterThan(data['cellStretchMin'] as number);
    const cyl = ok(shell.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 0.4,
      cellSize: 3,
      map: { kind: 'cylindrical', origin: [0, 0, 0], axis: [0, 0, 1], cellsAround: 8, radialCellSize: 3 },
      region: shell.id,
    });
    expect(ok(cyl.doc, 'lattice_properties', { id: cyl.id, resolution: 24 }).data['cellStretchMax']).toBeDefined();
  });
});

describe('add_graph_lattice (VC-IMP-26)', () => {
  const line = (): { doc: ReturnType<typeof empty>; id: string } => {
    const made = ok(empty(), 'draw_polyline', {
      points: [
        [0, 0],
        [10, 0],
      ],
    });
    return { doc: made.doc, id: made.id };
  };

  it('a 10 mm beam from radius 1 to 0.5 with butt caps has the frustum volume pi h (r1^2 + r1 r2 + r2^2) / 3', () => {
    const { doc, id } = line();
    const graph = ok(doc, 'add_graph_lattice', { sourceIds: [id], radiusStart: 1, radiusEnd: 0.5, cap: 'butt' });
    expect(graph.data).toMatchObject({ beams: 1, nodes: 2, dropped: 0, radiusMax: 1 });
    const volume = ok(graph.doc, 'implicit_properties', { id: graph.id, voxel: 0.04 }).data['volumeQuadrature'] as number;
    const exact = (Math.PI * 10 * (1 + 0.5 + 0.25)) / 3;
    expect(Math.abs(volume - exact) / exact).toBeLessThan(0.002);
  });

  it('samples curves to the chord, merges coincident nodes and drops duplicates; the sources are guarded while a body exists', () => {
    const circle = ok(empty(), 'draw_arc', { center: [0, 0], radius: 10 });
    const polyline = ok(circle.doc, 'draw_polyline', {
      points: [
        [10, 0],
        [20, 0],
      ],
    });
    const graph = ok(polyline.doc, 'add_graph_lattice', { sourceIds: [circle.id, polyline.id, polyline.id], radiusStart: 0.4, chord: 2 });
    expect(graph.data['beams'] as number).toBeGreaterThan(25);
    expect(graph.data['dropped']).toBe(1);
    const body = ok(graph.doc, 'create_implicit_body', { field: graph.id, voxel: 0.4 });
    expect(body.data['closedManifold']).toBe(true);
    const moved = run(body.doc, 'move_entities', { ids: [circle.id], delta: [1, 0, 0] });
    expect(moved.result.error?.code).toBe('IMP_SOURCE_IN_USE');
    const clipped = ok(body.doc, 'add_field_primitive', { shape: 'box', size: [10, 10, 10] });
    const withRegion = ok(clipped.doc, 'add_graph_lattice', { sourceIds: [circle.id], radiusStart: 0.4, chord: 2, region: clipped.id });
    expect(withRegion.data['beams']).toBeDefined();
  }, 60_000);

  it('refuses missing sources, non-curves, bad radii, chords and merge tolerances, unknown regions and oversized graphs', () => {
    const { doc, id } = line();
    const box = ok(doc, 'add_box', { size: [1, 1, 1] });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sourceIds: ['nope'], radiusStart: 1 }, 'IMP_ENTITY_NOT_FOUND'],
      [{ sourceIds: [box.id], radiusStart: 1 }, 'IMP_GRAPH_EMPTY'],
      [{ sourceIds: [id], radiusStart: 0 }, 'IMP_STRUT_RADIUS_RANGE'],
      [{ sourceIds: [id], radiusStart: 1, radiusEnd: -1 }, 'IMP_STRUT_RADIUS_RANGE'],
      [{ sourceIds: [id], radiusStart: 1, chord: 0 }, 'IMP_PARAM_RANGE'],
      [{ sourceIds: [id], radiusStart: 1, mergeTolerance: -1 }, 'IMP_PARAM_RANGE'],
      [{ sourceIds: [id], radiusStart: 1, region: 'nope' }, 'IMP_FIELD_NOT_FOUND'],
    ];
    for (const [params, code] of cases) expectRefused(box.doc, run(box.doc, 'add_graph_lattice', params), code);
    const ring = ok(box.doc, 'draw_arc', { center: [0, 0], radius: 1000 });
    const big = ok(ring.doc, 'add_graph_lattice', { sourceIds: [ring.id], radiusStart: 1, chord: 0.5 });
    expect(big.data['beams'] as number).toBeGreaterThan(12000);
    const probe = ok(big.doc, 'evaluate_field', { field: big.id, points: [[1003, 0, 0]] });
    expect((probe.data['values'] as number[])[0]).toBeCloseTo(2, 6);
    const huge = ok(box.doc, 'draw_arc', { center: [0, 0], radius: 20000 });
    expectRefused(
      huge.doc,
      run(huge.doc, 'add_graph_lattice', { sourceIds: [huge.id], radiusStart: 1, chord: 0.5 }),
      'IMP_GRAPH_TOO_LARGE',
    );
    const zero = ok(box.doc, 'draw_polyline', {
      points: [
        [3, 3],
        [3, 3],
      ],
    });
    expectRefused(zero.doc, run(zero.doc, 'add_graph_lattice', { sourceIds: [zero.id], radiusStart: 1 }), 'IMP_GRAPH_EMPTY');
  });

  it('is pure', () => {
    const { doc, id } = line();
    expectPure(doc, () => run(doc, 'add_graph_lattice', { sourceIds: [id], radiusStart: 1 }));
  });
});
