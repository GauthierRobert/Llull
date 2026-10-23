/** TPMS lattices (05 IMP M3): fractions, density inversion, wall normalisation, cylindrical map (VC-IMP-10..14, 25, 40). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { type Step, empty, expectRefused, ok, run } from './helpers';

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'design', '05-implicit-lattice', 'validation', 'data');
const table = JSON.parse(readFileSync(join(DATA, 'tpms_volume_fraction.json'), 'utf8')) as {
  surfaces: Record<
    string,
    {
      network: Array<{ t: number; fraction: number }>;
      sheet: Array<{ t: number; fraction: number }>;
      sheetDistanceNormalised: Array<{ t: number; fraction: number }>;
    }
  >;
};
const surface = JSON.parse(readFileSync(join(DATA, 'tpms_surface.json'), 'utf8')) as {
  surfaces: Record<
    string,
    { areaPerCell_a1: { extrapolated: number }; rawSheetThicknessRatio: number; gradientOnSurface_a1: { min: number; max: number } }
  >;
};
const KIND_KEY = { gyroid: 'gyroid', schwarz_p: 'schwarzP', diamond: 'diamond' } as const;
type Kind = keyof typeof KIND_KEY;
const KINDS = Object.keys(KIND_KEY) as Kind[];

const rho = (doc: CadDocument, id: string, resolution = 64): number =>
  ok(doc, 'lattice_properties', { id, resolution }).data['rhoMeasured'] as number;

const lattice = (params: Record<string, unknown>): Step => ok(empty(), 'add_tpms_lattice', params);

describe('fractions (VC-IMP-10, VC-IMP-11)', () => {
  it.each(KINDS)('%s network at level 0 holds exactly half of an integer cell block', (kind) => {
    const created = lattice({ kind, form: 'network', level: 0, cellSize: 10 });
    expect(Math.abs(rho(created.doc, created.id) - 0.5)).toBeLessThan(1e-4);
  });

  it.each(KINDS)('%s network fractions match the 240^3 table within 2e-3', (kind) => {
    const rows = table.surfaces[KIND_KEY[kind]]?.network ?? [];
    expect(rows.length).toBeGreaterThan(10);
    for (const { t, fraction } of rows.filter((row) => row.t === -0.4)) {
      const created = lattice({ kind, form: 'network', level: t, cellSize: 10 });
      expect(Math.abs(rho(created.doc, created.id, 96) - fraction)).toBeLessThan(2e-3);
    }
  });

  it.each(KINDS)('%s raw and distance-normalised sheet fractions match the table within 2e-3', (kind) => {
    const rows = table.surfaces[KIND_KEY[kind]];
    for (const { t, fraction } of (rows?.sheet ?? []).filter((row) => row.t === 0.3)) {
      const created = lattice({ kind, form: 'sheet', thickness: t, normalize: 'none', cellSize: 10 });
      expect(Math.abs(rho(created.doc, created.id, 128) - fraction)).toBeLessThan(2e-3);
    }
    for (const { t, fraction } of (rows?.sheetDistanceNormalised ?? []).filter((row) => row.t === 0.1)) {
      const created = lattice({ kind, form: 'sheet', thickness: t * 10, cellSize: 10 });
      expect(Math.abs(rho(created.doc, created.id, 96) - fraction)).toBeLessThan(2e-3);
    }
  });
});

describe('relativeDensity control (VC-IMP-12)', () => {
  it.each([
    ['sheet', 'gradient'],
    ['sheet', 'none'],
    ['network', 'gradient'],
  ] as const)('%s / %s: a target of 0.3 is realised and stored with its resolved control', (form, normalize) => {
    const created = lattice({ kind: 'gyroid', form, relativeDensity: 0.3, normalize, cellSize: 10 });
    const control = created.data['control'] as { kind: string; value: number; relativeDensityTarget: number };
    expect(control.kind).toBe(form === 'sheet' ? 'thickness' : 'level');
    expect(control.relativeDensityTarget).toBe(0.3);
    expect(Math.abs(rho(created.doc, created.id, 96) - 0.3)).toBeLessThan(0.005);
    const stored = created.doc.implicit?.fields[created.id];
    expect(stored).toMatchObject({ op: 'tpms', relativeDensityTarget: 0.3 });
  });

  it('is confirmed by the mesh volume of a 2x2x2 block within 0.5 %', () => {
    const cell = lattice({ kind: 'gyroid', form: 'sheet', relativeDensity: 0.3, cellSize: 10 });
    const block = ok(cell.doc, 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });
    const clipped = ok(block.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      relativeDensity: 0.3,
      cellSize: 10,
      region: block.id,
    });
    const body = ok(clipped.doc, 'create_implicit_body', { field: clipped.id, voxel: 0.5 });
    const volume = ok(body.doc, 'implicit_properties', { id: body.id, region: block.id });
    expect(Math.abs((volume.data['relativeDensity'] as number) - 0.3)).toBeLessThan(0.005);
    expect(body.data['closedManifold']).toBe(true);
  });
});

describe('wall normalisation (VC-IMP-13)', () => {
  const normalGrad = (doc: CadDocument, field: string, points: number[][]): { values: number[]; gradients: number[] } => {
    const data = ok(doc, 'evaluate_field', { field, points, gradient: true }).data as { values: number[]; gradients: number[] };
    return data;
  };

  it.each(KINDS)('%s: the normalised wall is uniform and the raw wall varies by the tabulated gradient ratio', (kind) => {
    const key = KIND_KEY[kind];
    const network = lattice({ kind, form: 'network', level: 0, cellSize: 10 });
    const raw = ok(network.doc, 'add_tpms_lattice', { kind, form: 'network', level: 0, cellSize: 10, normalize: 'none' });
    const wall = 0.6;
    const sheet = ok(raw.doc, 'add_tpms_lattice', { kind, form: 'sheet', thickness: wall, cellSize: 10 });
    let points: number[][] = Array.from({ length: 1500 }, (_, i) => [
      (((i + 0.5) * 0.7548776662466927) % 1) * 10,
      (((i + 0.5) * 0.5698402909980532) % 1) * 10,
      (((i + 0.5) * 0.4301597090019468) % 1) * 10,
    ]);
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const probe = normalGrad(sheet.doc, network.id, points);
      points = points.map((p, i) => {
        const g = [probe.gradients[3 * i] ?? 0, probe.gradients[3 * i + 1] ?? 0, probe.gradients[3 * i + 2] ?? 0];
        const length2 = g[0]! ** 2 + g[1]! ** 2 + g[2]! ** 2;
        const f = probe.values[i] ?? 0;
        return length2 < 1e-12 ? p : [p[0]! - (f * g[0]!) / length2, p[1]! - (f * g[1]!) / length2, p[2]! - (f * g[2]!) / length2];
      });
    }
    const onSurface = normalGrad(sheet.doc, raw.id, points);
    const slopes = points.map((_, i) =>
      Math.hypot(onSurface.gradients[3 * i] ?? 0, onSurface.gradients[3 * i + 1] ?? 0, onSurface.gradients[3 * i + 2] ?? 0),
    );
    const residual = onSurface.values.map(Math.abs);
    const good = points.map((_, i) => i).filter((i) => (residual[i] ?? 1) < 1e-6);
    expect(good.length).toBeGreaterThan(1000);
    const ratio = Math.max(...good.map((i) => slopes[i] ?? 0)) / Math.min(...good.map((i) => slopes[i] ?? 1));
    expect(Math.abs(ratio - (surface.surfaces[key]?.rawSheetThicknessRatio ?? 0))).toBeLessThan(0.02);
    expect(Math.min(...good.map((i) => slopes[i] ?? 1))).toBeCloseTo(((surface.surfaces[key]?.gradientOnSurface_a1.min ?? 0) / 10) * 1, 1);
    // normalised sheet: the signed distance along the surface normal reaches 0 at wall / 2 to first order
    const unit = good.slice(0, 200).map((i) => {
      const g = normalGrad(sheet.doc, network.id, [points[i] ?? [0, 0, 0]]).gradients;
      const length = Math.hypot(g[0] ?? 0, g[1] ?? 0, g[2] ?? 0);
      return [(g[0] ?? 0) / length, (g[1] ?? 0) / length, (g[2] ?? 0) / length];
    });
    let low = unit.map(() => 0);
    let high = unit.map(() => wall);
    for (let step = 0; step < 24; step += 1) {
      const mid = low.map((l, i) => (l + (high[i] ?? 0)) / 2);
      const probe = normalGrad(
        sheet.doc,
        sheet.id,
        mid.map((s, i) => [0, 1, 2].map((a) => (points[good[i] ?? 0]?.[a] ?? 0) + s * (unit[i]?.[a] ?? 0))),
      );
      low = low.map((l, i) => ((probe.values[i] ?? 1) < 0 ? (mid[i] ?? l) : l));
      high = high.map((h, i) => ((probe.values[i] ?? 1) < 0 ? h : (mid[i] ?? h)));
    }
    const walls = low.map((l, i) => l + (high[i] ?? 0));
    expect(Math.min(...walls) / wall).toBeGreaterThan(0.92);
    expect(Math.max(...walls) / wall).toBeLessThan(1.08);
  });

  it('lattice_properties reports the raw thickness range and a uniform normalised wall', () => {
    const raw = lattice({ kind: 'schwarz_p', form: 'sheet', thickness: 0.3, normalize: 'none', cellSize: 10 });
    const data = ok(raw.doc, 'lattice_properties', { id: raw.id }).data as {
      thicknessMin: number;
      thicknessMax: number;
      specificSurface: number;
    };
    expect(data.thicknessMax / data.thicknessMin).toBeCloseTo(Math.sqrt(3), 6);
    const uniform = lattice({ kind: 'schwarz_p', form: 'sheet', thickness: 1, cellSize: 10 });
    const normalised = ok(uniform.doc, 'lattice_properties', { id: uniform.id }).data as { thicknessMin: number; thicknessMax: number };
    expect([normalised.thicknessMin, normalised.thicknessMax]).toEqual([1, 1]);
  });
});

describe('specific surface (VC-IMP-14)', () => {
  it.each(KINDS)('%s: lattice_properties reports the extrapolated nodal area per volume within 0.2 %%', (kind) => {
    const reference = surface.surfaces[KIND_KEY[kind]]?.areaPerCell_a1.extrapolated ?? 0;
    const net = lattice({ kind, form: 'network', level: 0, cellSize: 10 });
    const sheet = ok(net.doc, 'add_tpms_lattice', { kind, form: 'sheet', thickness: 0.5, cellSize: 10 });
    const network = ok(sheet.doc, 'lattice_properties', { id: net.id }).data['specificSurface'] as number;
    const wall = ok(sheet.doc, 'lattice_properties', { id: sheet.id }).data['specificSurface'] as number;
    expect(Math.abs(network * 10 - reference) / reference).toBeLessThan(0.002);
    expect(Math.abs(wall * 10 - 2 * reference) / (2 * reference)).toBeLessThan(0.002);
  });

  it('the mesh of a gyroid block has the tabulated area (cut faces removed) within 1.5 %', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });
    const lat = ok(box.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 10, region: box.id });
    const sheet = ok(lat.doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 10 * 0.01, cellSize: 10 });
    expect(sheet.id).not.toBe('');
    const body = ok(sheet.doc, 'create_implicit_body', { field: lat.id, voxel: 0.4 });
    const area = body.data['area'] as number;
    const nodal = 3.091646 * (8000 / 10);
    const cut = 6 * 400 * 0.5;
    expect(Math.abs(area - (nodal + cut)) / (nodal + cut)).toBeLessThan(0.03);
  });
});

describe('cylindrical map (VC-IMP-25)', () => {
  const map = (cellsAround: number): Record<string, unknown> => ({
    kind: 'cylindrical',
    origin: [0, 0, 0],
    axis: [0, 0, 1],
    cellsAround,
    radialCellSize: 10,
  });

  it('whole cell counts are continuous at the seam; fractional counts are refused with IMP_MAP_SEAM', () => {
    for (const cells of [6, 8]) {
      const created = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 10, map: map(cells) });
      const eps = 1e-9;
      const ring = (theta: number): number[] => [25 * Math.cos(theta), 25 * Math.sin(theta), 3];
      const above = ok(created.doc, 'evaluate_field', { field: created.id, points: [ring(Math.PI - eps), ring(-Math.PI + eps)] }).data[
        'values'
      ] as number[];
      expect(Math.abs((above[0] ?? 0) - (above[1] ?? 9))).toBeLessThan(1e-6);
    }
    const doc = empty();
    expectRefused(
      doc,
      run(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 10, map: map(6.5) }),
      'IMP_MAP_SEAM',
    );
    expectRefused(
      doc,
      run(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 10, map: { ...map(6), radialCellSize: 0 } }),
      'IMP_PARAM_RANGE',
    );
    expectRefused(
      doc,
      run(doc, 'add_tpms_lattice', { kind: 'gyroid', form: 'network', level: 0, cellSize: 10, map: map(6), origin: [1, 0, 0] }),
      'IMP_PARAM_CONFLICT',
    );
  });

  it('the cylindrical sleeve keeps its wall uniform and bounded by the region', () => {
    let doc = empty();
    const outer = ok(doc, 'add_field_primitive', { shape: 'cylinder', radius: 30, height: 40, position: [0, 0, 20] });
    const bore = ok(outer.doc, 'add_field_primitive', { shape: 'cylinder', radius: 20, height: 42, position: [0, 0, 20] });
    const sleeve = ok(bore.doc, 'combine_fields', { op: 'subtract', a: outer.id, b: bore.id });
    const lat = ok(sleeve.doc, 'add_tpms_lattice', {
      kind: 'gyroid',
      form: 'sheet',
      thickness: 1,
      cellSize: [10, 10, 10],
      map: map(16),
      region: sleeve.id,
    });
    doc = lat.doc;
    const body = ok(doc, 'create_implicit_body', { field: lat.id, voxel: 0.8 });
    expect(body.data['closedManifold']).toBe(true);
    const props = ok(body.doc, 'implicit_properties', { id: body.id, region: sleeve.id });
    const density = props.data['relativeDensity'] as number;
    expect(density).toBeGreaterThan(0.1);
    expect(density).toBeLessThan(0.35);
    const bounds = body.data['bounds'] as { min: number[]; max: number[] };
    expect(bounds.max[0]).toBeCloseTo(30, 6);
  });
});

describe('add_tpms_lattice failure paths (VC-IMP-40)', () => {
  const base = { kind: 'gyroid', form: 'sheet', cellSize: 10 };

  it.each([
    ['thickness above half the cell', { ...base, thickness: 6 }, 'IMP_TPMS_CONTROL_RANGE'],
    ['negative thickness', { ...base, thickness: -1 }, 'IMP_TPMS_CONTROL_RANGE'],
    ['level beyond the range of F', { ...base, form: 'network', level: 2 }, 'IMP_TPMS_CONTROL_RANGE'],
    ['density 0', { ...base, relativeDensity: 0 }, 'IMP_TPMS_CONTROL_RANGE'],
    ['density 1', { ...base, relativeDensity: 1 }, 'IMP_TPMS_CONTROL_RANGE'],
    ['density unreachable by a thin-capped sheet', { ...base, relativeDensity: 0.95 }, 'IMP_TPMS_CONTROL_RANGE'],
    ['two controls', { ...base, thickness: 1, level: 0 }, 'IMP_PARAM_CONFLICT'],
    ['no control', { ...base }, 'IMP_PARAM_CONFLICT'],
    ['level on a sheet', { ...base, level: 0 }, 'IMP_PARAM_CONFLICT'],
    ['thickness on a network', { ...base, form: 'network', thickness: 1 }, 'IMP_PARAM_CONFLICT'],
    ['zero cell', { ...base, cellSize: 0, thickness: 1 }, 'IMP_PARAM_RANGE'],
    ['unknown region', { ...base, thickness: 1, region: 'nope' }, 'IMP_FIELD_NOT_FOUND'],
  ])('%s', (_label, params, code) => {
    const doc = empty();
    expectRefused(doc, run(doc, 'add_tpms_lattice', params), code);
  });

  it('is pure and anisotropic cells are accepted', () => {
    const doc = empty();
    const before = JSON.stringify(doc);
    const created = ok(doc, 'add_tpms_lattice', {
      ...base,
      cellSize: [8, 10, 12],
      thickness: 1,
      rotation: [0.1, 0.2, 0.3],
      origin: [1, 1, 1],
      name: 'g',
    });
    expect(JSON.stringify(doc)).toBe(before);
    expect(created.data['distanceQuality']).toBe('approximate');
    expect(created.data['bounds']).toBeNull();
    expect(created.result.summary).toContain('create_implicit_body');
  });
});
