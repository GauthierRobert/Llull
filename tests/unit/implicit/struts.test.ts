/** Strut lattices and lattice_properties (05 IMP M3; VC-IMP-15..19, 30 counts). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Step, empty, expectRefused, ok, run } from './helpers';

const DATA = join(import.meta.dirname, '..', '..', '..', 'docs', 'design', '05-implicit-lattice', 'validation', 'data');
const struts = JSON.parse(readFileSync(join(DATA, 'strut_lattices.json'), 'utf8')) as {
  lattices: Record<string, { rows: Array<{ rOverA: number; rho1: number; rhoQuadrature: number }> }>;
  cubicBlocks: Array<{ n: number; nodes: number; beams: number }>;
};
const blocks = JSON.parse(readFileSync(join(DATA, 'beam_block_counts.json'), 'utf8')) as {
  octet: Array<{ n: number; nodes: number; beams: number }>;
};

const CELLS = ['cubic', 'bcc', 'fcc', 'octet'] as const;
const lattice = (cell: (typeof CELLS)[number], radius: number, extra: Record<string, unknown> = {}, from = empty()): Step =>
  ok(from, 'add_strut_lattice', { cell, cellSize: 10, radius, ...extra });

describe('rho1 and the periodic density (VC-IMP-16, VC-IMP-17)', () => {
  it.each(CELLS)('%s: rho1 at r/a = 0.1 is pi x^2 L / a to 1e-6', (cell) => {
    const created = lattice(cell, 1);
    const reference = struts.lattices[cell]?.rows.find((row) => row.rOverA === 0.1)?.rho1 ?? 0;
    const data = ok(created.doc, 'lattice_properties', { id: created.id, resolution: 16 }).data as { rho1: number };
    expect(Math.abs(data.rho1 - reference)).toBeLessThan(1e-6);
  });

  it.each(CELLS)('%s: measured periodic density follows the quasi-Monte-Carlo reference within 0.5 %', (cell) => {
    const created = lattice(cell, 1);
    const reference = struts.lattices[cell]?.rows.find((row) => row.rOverA === 0.1)?.rhoQuadrature ?? 0;
    const data = ok(created.doc, 'lattice_properties', { id: created.id, resolution: 64 }).data as { rhoMeasured: number };
    expect(Math.abs(data.rhoMeasured - reference) / reference).toBeLessThan(0.005);
  });

  it('simple cubic follows 3 pi x^2 - 8 sqrt2 x^3 and the realised cell has V = 82.934 mm3 (VC-IMP-15, VC-IMP-49)', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [10, 10, 10], position: [5, 5, 5] });
    const sc = ok(box.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 1, origin: [0, 0, 0], region: box.id });
    const body = ok(sc.doc, 'create_implicit_body', { field: sc.id, voxel: 0.15 });
    expect(body.data['closedManifold']).toBe(true);
    const volume = body.data['volumeMesh'] as number;
    expect(Math.abs(volume - 82.93407) / 82.93407).toBeLessThan(0.03);
    const properties = ok(body.doc, 'implicit_properties', { id: body.id, region: box.id }).data;
    expect(Math.abs((properties['volumeQuadrature'] as number) - 82.93407) / 82.93407).toBeLessThan(0.005);
    expect(properties['components']).toBe(1);
    const lattice = ok(body.doc, 'lattice_properties', { id: sc.id, resolution: 16 }).data;
    expect(lattice['cells']).toBe(1);
    expect(lattice['nodes']).toBe(8);
  });

  it('octet 2x2x2 block with r = 0.5 holds 911.84 mm3 within 0.5 % by quasi-random quadrature (VC-IMP-17)', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [20, 20, 20], position: [10, 10, 10] });
    const octet = ok(box.doc, 'add_strut_lattice', { cell: 'octet', cellSize: 10, radius: 0.5, origin: [0, 0, 0], region: box.id });
    const volume = ok(octet.doc, 'implicit_properties', { id: octet.id, voxel: 0.4 }).data;
    expect(Math.abs((volume['volume'] as number) - 911.84) / 911.84).toBeLessThan(0.005);
    expect((volume['provenance'] as { quadrature: string }).quadrature).toBe('lowdiscrepancy');
  });
});

describe('block bookkeeping (VC-IMP-30 counts)', () => {
  const countsOf = (cell: 'cubic' | 'octet', n: number): { nodes: number; beams: number; countsExact: boolean; cells: number } => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [10 * n, 10 * n, 10 * n], position: [5 * n, 5 * n, 5 * n] });
    const created = ok(box.doc, 'add_strut_lattice', { cell, cellSize: 10, radius: 0.5, origin: [0, 0, 0], region: box.id });
    return ok(created.doc, 'lattice_properties', { id: created.id, resolution: 16 }).data as {
      nodes: number;
      beams: number;
      countsExact: boolean;
      cells: number;
    };
  };

  it.each(struts.cubicBlocks.filter((row) => row.n <= 3))('cubic n=$n has $nodes nodes and $beams beams', ({ n, nodes, beams }) => {
    expect(countsOf('cubic', n)).toMatchObject({ nodes, beams, countsExact: true, cells: n ** 3 });
  });

  it.each(blocks.octet)('octet n=$n has $nodes nodes and $beams beams', ({ n, nodes, beams }) => {
    expect(countsOf('octet', n)).toMatchObject({ nodes, beams, countsExact: true });
  });

  it('an unaligned region gives per-cell estimates, flagged inexact', () => {
    const box = ok(empty(), 'add_field_primitive', { shape: 'box', size: [25, 25, 25], position: [12.5, 12.5, 12.5] });
    const created = ok(box.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 1, region: box.id });
    const data = ok(created.doc, 'lattice_properties', { id: created.id, resolution: 16 }).data;
    expect(data['countsExact']).toBe(false);
    expect(data['cells']).toBeCloseTo(15.625, 9);
    expect(data['beams']).toBeCloseTo(3 * 15.625, 9);
    const noRegion = lattice('cubic', 1);
    expect(ok(noRegion.doc, 'lattice_properties', { id: noRegion.id, resolution: 16 }).data['beams']).toBeNull();
  });
});

describe('lattice_properties content', () => {
  it('reports valence, slenderness, Maxwell count and the literature class (VC-IMP-19)', () => {
    const octet = lattice('octet', 0.5);
    const bcc = lattice('bcc', 0.5, {}, octet.doc);
    const octetData = ok(bcc.doc, 'lattice_properties', { id: octet.id, resolution: 16 }).data as {
      maxwell: { b: number; j: number; M: number; class: string };
      valence: { min: number; max: number };
      slendernessMax: number;
      beamsPerCell: number;
      radiusMin: number;
    };
    expect(octetData.maxwell).toMatchObject({ b: 24, j: 4, M: 18, class: 'stretch' });
    expect(octetData.valence).toEqual({ min: 12, max: 12 });
    expect(octetData.beamsPerCell).toBe(24);
    expect(octetData.slendernessMax).toBeCloseTo(10 / Math.SQRT2 / 1, 9);
    const bccData = ok(bcc.doc, 'lattice_properties', { id: bcc.id, resolution: 16 }).data as {
      maxwell: { class: string };
      valence: { min: number; max: number };
      beamsPerCell: number;
    };
    expect(bccData.maxwell.class).toBe('bending');
    expect(bccData.valence).toEqual({ min: 8, max: 8 });
    expect(bccData.beamsPerCell).toBe(8);
    const cubic = lattice('cubic', 1);
    expect(ok(cubic.doc, 'lattice_properties', { id: cubic.id, resolution: 16 }).data['valence']).toEqual({ min: 6, max: 6 });
  });

  it('the mechanics estimate is opt-in and always unverified and review-required (VC-IMP-47)', () => {
    const octet = lattice('octet', 0.5);
    const plain = ok(octet.doc, 'lattice_properties', { id: octet.id, resolution: 16 });
    expect(plain.data['mechanics']).toBeUndefined();
    expect(plain.data['unverified']).toBe(false);
    const withMechanics = ok(octet.doc, 'lattice_properties', { id: octet.id, estimateMechanics: true, resolution: 16 });
    expect(withMechanics.data['mechanics']).toMatchObject({
      exponent: 1,
      coefficient: null,
      unverified: true,
      reviewRequired: true,
      warning: 'IMP_MECHANICS_UNVERIFIED',
    });
    expect(withMechanics.data['unverified']).toBe(true);
    expect(withMechanics.result.summary).toContain('not approved: needs a qualified engineer');
    const bcc = lattice('bcc', 0.5);
    expect(
      (ok(bcc.doc, 'lattice_properties', { id: bcc.id, estimateMechanics: true, resolution: 16 }).data['mechanics'] as { exponent: number })
        .exponent,
    ).toBe(2);
    const tpms = ok(empty(), 'add_tpms_lattice', { kind: 'gyroid', form: 'sheet', thickness: 1, cellSize: 10 });
    expect(
      (
        ok(tpms.doc, 'lattice_properties', { id: tpms.id, estimateMechanics: true, resolution: 16 }).data['mechanics'] as {
          exponent: unknown;
        }
      ).exponent,
    ).toBeNull();
  });

  it('refuses a missing id and a non-lattice field', () => {
    const doc = empty();
    expectRefused(doc, run(doc, 'lattice_properties', { id: 'nope' }), 'IMP_FIELD_NOT_FOUND');
    const sphere = ok(doc, 'add_field_primitive', { shape: 'sphere', radius: 2 });
    expectRefused(sphere.doc, run(sphere.doc, 'lattice_properties', { id: sphere.id, resolution: 16 }), 'IMP_FIELD_NOT_FOUND');
  });
});

describe('add_strut_lattice', () => {
  it('node balls larger than the strut add material at the nodes; origin and rotation move the lattice', () => {
    const plain = lattice('cubic', 1);
    const balls = ok(plain.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 1, nodeRadius: 2.5 });
    const shifted = ok(balls.doc, 'add_strut_lattice', {
      cell: 'cubic',
      cellSize: [10, 10, 10],
      radius: 1,
      origin: [2, 3, 4],
      rotation: [0, 0, 0],
    });
    const at = (field: string, point: number[]): number =>
      (ok(shifted.doc, 'evaluate_field', { field, points: [point] }).data['values'] as number[])[0] ?? NaN;
    expect(at(plain.id, [1.2, 1.2, 1.2])).toBeGreaterThan(0);
    expect(at(balls.id, [1.2, 1.2, 1.2])).toBeLessThan(0);
    expect(at(plain.id, [0, 0, 0])).toBeCloseTo(-1, 12);
    expect(at(shifted.id, [2, 3, 4])).toBeCloseTo(-1, 12);
    expect(at(shifted.id, [12, 3, 4.5])).toBeCloseTo(-0.5, 12);
    expect(plain.data['distanceQuality']).toBe('bound');
    const rotated = ok(shifted.doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 1, rotation: [0, 0, Math.PI / 2] });
    expect((ok(rotated.doc, 'evaluate_field', { field: rotated.id, points: [[5, 0, 0]] }).data['values'] as number[])[0]).toBeCloseTo(
      -1,
      9,
    );
  });

  it('refuses struts that would merge, bad sizes and unknown regions (VC-IMP-40)', () => {
    const doc = empty();
    expectRefused(doc, run(doc, 'add_strut_lattice', { cell: 'bcc', cellSize: 10, radius: 5.5 }), 'IMP_STRUT_RADIUS_RANGE');
    expectRefused(doc, run(doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 5 }), 'IMP_STRUT_RADIUS_RANGE');
    expectRefused(doc, run(doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 0 }), 'IMP_STRUT_RADIUS_RANGE');
    expectRefused(doc, run(doc, 'add_strut_lattice', { cell: 'cubic', cellSize: [10, 0, 10], radius: 1 }), 'IMP_PARAM_RANGE');
    expectRefused(doc, run(doc, 'add_strut_lattice', { cell: 'cubic', cellSize: 10, radius: 1, region: 'nope' }), 'IMP_FIELD_NOT_FOUND');
  });

  it('is pure', () => {
    const doc = empty();
    const before = JSON.stringify(doc);
    ok(doc, 'add_strut_lattice', { cell: 'fcc', cellSize: 10, radius: 1, name: 'f' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});
