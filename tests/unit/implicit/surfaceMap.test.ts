/**
 * Cell maps on a sheet and on strut lattices (05 IMP 5.6, 14.13): `surface_uv` follows a nurbs_surface (u, v, normal), the same maps shape strut lattices.
 * VC: on a planar sheet the mapped lattice IS the rectangular lattice (the map is exact where the parameterisation is linear), so a mapped TPMS and a mapped strut
 * lattice are compared point by point with their rectangular twins; the mapped field is declared approximate; the refusals are named.
 */
import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { compileField } from '@implicit/compile';
import { empty, expectRefused, ok, run } from './helpers';
import type { Step } from './helpers';

const L = 20;

/** A bilinear planar patch over [0, L]^2 (u along x, v along y), normal +z. */
function planarSheet(): Step {
  return ok(empty(), 'create_nurbs_surface', {
    degreeU: 1,
    degreeV: 1,
    poles: [
      [
        [0, 0, 0],
        [0, L, 0],
      ],
      [
        [L, 0, 0],
        [L, L, 0],
      ],
    ],
  });
}

const interiorPoints = (count: number): number[][] =>
  Array.from({ length: count }, (_, n) => [3 + ((n * 7.31) % 14), 3 + ((n * 5.17) % 14), 0.3 + ((n * 2.9) % 4.4)]);

const valuesAt = (step: Step, field: string, points: number[][]): number[] =>
  ok(step.doc, 'evaluate_field', { field, points }).data['values'] as number[];

describe('surface_uv map on a planar sheet', () => {
  const sheet = planarSheet();
  const map = { kind: 'surface_uv', sheetId: sheet.id, cellsU: 4, cellsV: 4, depth: 5, layers: 1 } as const;

  it('a mapped gyroid equals the rectangular gyroid of the same cells (the planar parameterisation is linear), and says it is approximate', () => {
    const mapped = ok(sheet.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 0.3,
      normalize: 'none',
      cellSize: 5,
      map,
    });
    const rectangular = ok(mapped.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 0.3,
      normalize: 'none',
      cellSize: 5,
    });
    const points = interiorPoints(120);
    const [a, b] = [valuesAt(rectangular, mapped.id, points), valuesAt(rectangular, rectangular.id, points)];
    a.forEach((value, n) => expect(value).toBeCloseTo(b[n] as number, 9));
    const answer = ok(rectangular.doc, 'evaluate_field', { field: mapped.id, points: [points[0]] });
    expect(answer.data['distanceQuality']).toBe('approximate');
  });

  it('a mapped strut lattice equals the rectangular strut lattice of the same cells, and is approximate', () => {
    const mapped = ok(sheet.doc, 'add_strut_lattice', { cell: 'octet', cellSize: 5, radius: 0.4, map });
    const rectangular = ok(mapped.doc, 'add_strut_lattice', { cell: 'octet', cellSize: 5, radius: 0.4 });
    const points = interiorPoints(120);
    const [a, b] = [valuesAt(rectangular, mapped.id, points), valuesAt(rectangular, rectangular.id, points)];
    // outside the struts the distances agree to rounding; inside, the capsule of the mapped set and the cylinder-and-ball of the rectangular one differ near the nodes
    a.forEach((value, n) => {
      const other = b[n] as number;
      expect(Math.sign(value)).toBe(Math.sign(other));
      if (other > 0) expect(value).toBeCloseTo(other, 9);
    });
    expect(b.filter((value) => value > 0).length).toBeGreaterThan(60);
    expect(ok(rectangular.doc, 'evaluate_field', { field: mapped.id, points: [points[0]] }).data['distanceQuality']).toBe('approximate');
  });

  it('lives on the +normal side of the sheet, over its footprint, within layers cells of depth: everywhere else the field is positive', () => {
    const struts = ok(sheet.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 5, radius: 0.4, map });
    const gyroid = ok(struts.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 0.3,
      normalize: 'none',
      cellSize: 5,
      map,
    });
    const outside = [
      [5, 5, -0.5],
      [5, 5, 5.5],
      [5, 5, 40],
      [-3, 5, 2.5],
      [23, 5, 2.5],
      [5, -3, 2.5],
      [500, 500, 500],
    ];
    for (const field of [struts.id, gyroid.id])
      valuesAt(gyroid, field, outside).forEach((value, n) => expect(value, `${field} at ${outside[n]}`).toBeGreaterThan(0));
    expect(
      valuesAt(gyroid, struts.id, [
        [5, 5, 2.5],
        [10, 5, 0.1],
        [5, 10, 4.9],
      ]).every((value) => value < 0),
    ).toBe(true);
    const body = ok(gyroid.doc, 'create_implicit_body', { field: gyroid.id, voxel: 0.5 });
    expect(body.data['closedManifold']).toBe(true);
    expect((body.data['bounds'] as { max: number[] }).max[2]).toBeLessThanOrEqual(5.5);
  });

  it('reports a stretch warning where the cells are distorted and keeps the field closed for a body', () => {
    const wedge = ok(empty(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 20, 0],
        ],
        [
          [20, 0, 0],
          [20, 2, 0],
        ],
      ],
    });
    const stretched = ok(wedge.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 0.2,
      normalize: 'none',
      cellSize: 5,
      map: { kind: 'surface_uv', sheetId: wedge.id, cellsU: 4, cellsV: 4, depth: 5, layers: 1 },
    });
    const compiled = compileField(stretched.doc, stretched.id);
    if (!compiled.ok) throw new Error(compiled.message);
    expect(compiled.warnings.map((w) => w.code)).toContain('IMP_MAP_STRETCH');
    expect(compiled.program.quality).toBe('approximate');
  });
});

/** A full rational quadratic circle of radius 10 (u) extruded 20 along z (v): closed in u. */
function cylinderSheet(): Step {
  const w = Math.SQRT1_2;
  const ring: Array<[number, number, number]> = [
    [10, 0, 1],
    [10, 10, w],
    [0, 10, 1],
    [-10, 10, w],
    [-10, 0, 1],
    [-10, -10, w],
    [0, -10, 1],
    [10, -10, w],
    [10, 0, 1],
  ];
  return ok(empty(), 'create_nurbs_surface', {
    degreeU: 2,
    degreeV: 1,
    poles: ring.map(([x, y]) => [
      [x, y, 0],
      [x, y, 20],
    ]),
    weights: ring.map(([, , weight]) => [weight, weight]),
    knotsU: [0, 0.25, 0.5, 0.75, 1],
    multiplicitiesU: [3, 2, 2, 2, 3],
  });
}

describe('a sheet that closes on itself (the u seam)', () => {
  const sheet = cylinderSheet();
  const map = (cellsU: number) => ({ kind: 'surface_uv', sheetId: sheet.id, cellsU, cellsV: 4, depth: 4, layers: 1 }) as const;

  it('needs whole cells over the closed direction and is continuous across the seam', () => {
    expectRefused(
      sheet.doc,
      run(sheet.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.3, normalize: 'none', cellSize: 4, map: map(7.5) }),
      'IMP_MAP_SEAM',
    );
    const gyroid = ok(sheet.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 0.3,
      normalize: 'none',
      cellSize: 4,
      map: map(8),
    });
    for (const radius of [8.2, 9.1, 10.9, 11.8]) {
      const [above, below] = [0.003, -0.003].map((angle) => [radius * Math.cos(angle), radius * Math.sin(angle), 6.3]);
      const [a, b] = valuesAt(gyroid, gyroid.id, [above as number[], below as number[]]);
      expect(Math.abs((a as number) - (b as number)), `radius ${radius}`).toBeLessThan(0.05);
    }
  });
});

describe('maps on strut lattices (cylindrical, spherical)', () => {
  it('a cylindrical strut lattice has its radial struts on the lines of the cells: the signed distance there is minus the radius', () => {
    const mapped = ok(empty(), 'add_strut_lattice', {
      cell: 'cubic',
      cellSize: 4,
      radius: 0.4,
      map: { kind: 'cylindrical', origin: [0, 0, 0], axis: [0, 0, 1], cellsAround: 8, radialCellSize: 4 },
    });
    const radial = [5, 8, 11, 14, 17].map((rho) => [rho, 0, 0]);
    valuesAt(mapped, mapped.id, radial).forEach((value) => expect(value).toBeCloseTo(-0.4, 9));
    expect(ok(mapped.doc, 'evaluate_field', { field: mapped.id, points: radial }).data['distanceQuality']).toBe('approximate');
  });

  it('a spherical strut lattice is created and evaluated finite', () => {
    const mapped = ok(empty(), 'add_strut_lattice', {
      cell: 'bcc',
      cellSize: 4,
      radius: 0.3,
      map: { kind: 'spherical', origin: [0, 0, 0], cellsAround: 8, cellsPolar: 4, radialCellSize: 4 },
    });
    valuesAt(mapped, mapped.id, [
      [6, 1, 2],
      [3, 5, 4],
      [9, 2, 1],
    ]).forEach((value) => expect(Number.isFinite(value)).toBe(true));
  });
});

describe('the sheet under a body, and a stored map', () => {
  it('is a source of the bodies built on its lattice: moving or deleting it is refused by name', () => {
    const sheet = planarSheet();
    const map = { kind: 'surface_uv', sheetId: sheet.id, cellsU: 4, cellsV: 4, depth: 5, layers: 1 } as const;
    const lattice = ok(sheet.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 5, radius: 0.4, map });
    const body = ok(lattice.doc, 'create_implicit_body', { field: lattice.id, voxel: 0.5 });
    expect(run(body.doc, 'move_entities', { ids: [sheet.id], delta: [1, 0, 0] }).result.error?.code).toBe('IMP_SOURCE_IN_USE');
    expect(run(body.doc, 'delete_entities', { ids: [sheet.id] }).result.error?.code).toBe('IMP_SOURCE_IN_USE');
  });

  it('is validated on load: a negative depth, a fractional layer count or a missing sheet name is refused with the invalid-values summary', () => {
    const sheet = planarSheet();
    const map = { kind: 'surface_uv', sheetId: sheet.id, cellsU: 4, cellsV: 4, depth: 5, layers: 1 } as const;
    const lattice = ok(sheet.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 0.3,
      normalize: 'none',
      cellSize: 5,
      map,
    });
    const saved = serializeDocument(lattice.doc);
    expect(() => deserializeDocument(saved)).not.toThrow();
    const broken = (patch: (stored: Record<string, unknown>) => void): string => {
      const raw = JSON.parse(saved) as { document: { implicit: { fields: Record<string, { map: Record<string, unknown> }> } } };
      patch((raw.document.implicit.fields[lattice.id] as { map: Record<string, unknown> }).map);
      return JSON.stringify(raw);
    };
    for (const patch of [
      (m: Record<string, unknown>) => (m['depth'] = -1),
      (m: Record<string, unknown>) => (m['layers'] = 1.5),
      (m: Record<string, unknown>) => (m['sheetId'] = 7),
      (m: Record<string, unknown>) => (m['kind'] = 'helical'),
      (m: Record<string, unknown>) => (m['cellsU'] = 0),
    ])
      expect(() => deserializeDocument(broken(patch))).toThrow(/invalid|implicit/i);
  });
});

describe('refusals by name', () => {
  const sheet = planarSheet();
  const good = { kind: 'surface_uv', sheetId: sheet.id, cellsU: 4, cellsV: 4, depth: 5, layers: 1 } as const;
  const tpms = (map: Record<string, unknown>, extra: Record<string, unknown> = {}): Step =>
    run(sheet.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.3, cellSize: 5, map, ...extra });

  it('names the problem of the sheet and of the parameters', () => {
    expectRefused(sheet.doc, tpms({ ...good, sheetId: 'nope' }), 'IMP_ENTITY_NOT_FOUND');
    const box = ok(sheet.doc, 'add_box', { size: [1, 1, 1] });
    expectRefused(
      box.doc,
      run(box.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 0.3, cellSize: 5, map: { ...good, sheetId: box.id } }),
      'IMP_PARAM_RANGE',
    );
    expectRefused(sheet.doc, tpms({ ...good, layers: 0 }), 'IMP_PARAM_RANGE');
    expectRefused(sheet.doc, tpms({ ...good, depth: 0 }), 'IMP_PARAM_RANGE');
    expectRefused(sheet.doc, tpms(good, { origin: [1, 0, 0] }), 'IMP_PARAM_CONFLICT');
    expectRefused(
      sheet.doc,
      run(sheet.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 5, radius: 0.4, map: { ...good, cellsU: -1 } }),
      'IMP_PARAM_RANGE',
    );
  });

  it('refuses a collapsed sheet as singular and a map grid above its node limit as too large', () => {
    const line = ok(empty(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 20, 0],
        ],
        [
          [0, 0, 0],
          [0, 20, 0],
        ],
      ],
    });
    const collapsed = run(line.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 0.3,
      cellSize: 5,
      map: { kind: 'surface_uv', sheetId: line.id, cellsU: 4, cellsV: 4, depth: 5, layers: 1 },
    });
    expectRefused(line.doc, collapsed, 'IMP_MAP_SINGULAR');
    const huge = ok(empty(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 2000, 0],
        ],
        [
          [2000, 0, 0],
          [2000, 2000, 0],
        ],
      ],
    });
    const tooLarge = run(huge.doc, 'add_strut_lattice', {
      cell: 'cubic',
      cellSize: 1,
      radius: 0.1,
      map: { kind: 'surface_uv', sheetId: huge.id, cellsU: 100, cellsV: 100, depth: 1, layers: 1 },
    });
    expectRefused(huge.doc, tooLarge, 'IMP_MAP_TOO_LARGE');
  });

  it('bounds the build by the closest-point tests, not only by the grid: a finely tessellated sheet under many layers is refused fast', () => {
    const net = Array.from({ length: 40 }, (_, i) => Array.from({ length: 40 }, (_, j) => [i * 0.5, j * 0.5, 0.01 * ((i + j) % 3)]));
    const fine = ok(empty(), 'create_nurbs_surface', { degreeU: 1, degreeV: 1, poles: net });
    const started = performance.now();
    const refused = run(fine.doc, 'add_strut_lattice', {
      cell: 'cubic',
      cellSize: 3,
      radius: 0.3,
      map: { kind: 'surface_uv', sheetId: fine.id, cellsU: 6, cellsV: 6, depth: 3, layers: 5 },
    });
    expectRefused(fine.doc, refused, 'IMP_MAP_TOO_LARGE');
    expect(refused.result.summary).toContain('closest-point tests');
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
