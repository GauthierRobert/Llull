import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { derivedEntityIds } from '@core/plugins/host';
import type { CadDocument, PolylineEntity } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { panelPart } from './fixtures';

const { doc: start, part } = panelPart();
const whole = { kind: 'whole_face' } as const;
const patch = {
  kind: 'polygon',
  polygons: [
    [
      [100, 100],
      [200, 100],
      [200, 200],
      [100, 200],
    ],
  ],
} as const;

const names = (doc: CadDocument): string[] =>
  Object.values(doc.composites?.plies ?? {})
    .sort((a, b) => a.order - b.order)
    .map((ply) => ply.name);

function stacked(): CadDocument {
  let doc = apply(start, 'add_ply', { part, name: 'A', material: 'T300_5208', orientation: 0, boundary: whole });
  doc = apply(doc, 'add_ply', { part, name: 'B', material: 'T300_5208', orientation: 135, boundary: patch });
  return apply(doc, 'add_ply', { part, name: 'C', material: 'T300_5208', orientation: 90, boundary: whole, order: 0, sequence: 'LAST' });
}

describe('add_ply', () => {
  it('stacks on top by default, inserts at an order, normalises the angle and labels the sequence', () => {
    const doc = stacked();
    expect(names(doc)).toEqual(['C', 'A', 'B']);
    const plies = Object.values(doc.composites?.plies ?? {});
    expect(plies.find((ply) => ply.name === 'B')).toMatchObject({ orientation: -45, sequence: 'S2', order: 2 });
    expect(plies.find((ply) => ply.name === 'C')).toMatchObject({ orientation: 90, sequence: 'LAST', order: 0 });
    expect(plies.every((ply) => /^ply-\d+\.\d+$/.test(ply.id))).toBe(true);
    expect(plies.find((ply) => ply.name === 'B')?.boundary).toEqual({
      kind: 'polygons',
      polygons: [
        [
          [100, 100],
          [200, 100],
          [200, 200],
          [100, 200],
        ],
      ],
    });
  });

  it('derives one outline polyline per piece, lifted to the ply mid-height', () => {
    const doc = stacked();
    const derived = [...derivedEntityIds(doc)];
    expect(derived).toHaveLength(3);
    const lifted = derived.map((id) => (doc.entities[id] as PolylineEntity).position[2]).sort((a, b) => a - b);
    expect(lifted[0]).toBeCloseTo(0.0625, 12);
    expect(lifted[2]).toBeCloseTo(0.3125, 12);
    expect((doc.entities[derived[0] as string] as PolylineEntity).closed).toBe(true);
  });

  it('refuses unknown references, duplicate names and bad polygons', () => {
    const base = { part, name: 'X', material: 'T300_5208', orientation: 0, boundary: whole };
    expectRefusal(start, 'add_ply', { ...base, part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(start, 'add_ply', { ...base, material: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(start, 'add_ply', { ...base, rosette: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(stacked(), 'add_ply', { ...base, name: 'A' }, 'CMP_NAME_TAKEN');
    expectRefusal(start, 'add_ply', { ...base, boundary: { kind: 'polygon', polygons: [] } }, 'CMP_ZONE_BOUNDARY_INVALID');
    expectRefusal(
      start,
      'add_ply',
      {
        ...base,
        boundary: {
          kind: 'polygon',
          polygons: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
      },
      'CMP_ZONE_BOUNDARY_INVALID',
    );
    expectRefusal(
      start,
      'add_ply',
      {
        ...base,
        boundary: {
          kind: 'polygon',
          polygons: [
            [
              [0, 0],
              [10, 10],
              [10, 0],
              [0, 12],
            ],
          ],
        },
      },
      'CMP_ZONE_BOUNDARY_INVALID',
    );
    expectRefusal(
      start,
      'add_ply',
      {
        ...base,
        boundary: {
          kind: 'polygon',
          polygons: [
            [
              [0, 0],
              [900, 0],
              [900, 10],
            ],
          ],
        },
      },
      'CMP_ZONE_BOUNDARY_INVALID',
    );
  });

  it('is pure', () => {
    expectPure(start, () => execute(start, 'add_ply', { part, name: 'A', material: 'T300_5208', orientation: 0, boundary: whole }));
  });
});

describe('edit_ply, delete_ply, reorder_plies', () => {
  const doc = stacked();

  it('edits fields in place and regenerates the outline', () => {
    const before = derivedEntityIds(doc).size;
    const edited = ok(doc, 'edit_ply', {
      part,
      ply: 'B',
      name: 'B2',
      material: 'AS4_3501_6',
      orientation: 30,
      sequence: 'Q',
      boundary: whole,
    });
    expect(edited.document.composites?.plies[edited.affected[0] as string]).toMatchObject({
      name: 'B2',
      materialName: 'AS4_3501_6',
      orientation: 30,
      sequence: 'Q',
      boundary: whole,
    });
    expect(names(edited.document)).toEqual(['C', 'A', 'B2']);
    expect(derivedEntityIds(edited.document).size).toBe(before);
    const noChange = ok(doc, 'edit_ply', { part, ply: 'B' });
    expect(noChange.document.composites?.plies).toEqual(doc.composites?.plies);
  });

  it('deletes a ply and renumbers the rest, dropping its outline', () => {
    const removed = ok(doc, 'delete_ply', { part, ply: 'A' });
    expect(names(removed.document)).toEqual(['C', 'B']);
    expect(
      Object.values(removed.document.composites?.plies ?? {})
        .map((ply) => ply.order)
        .sort(),
    ).toEqual([0, 1]);
    expect(derivedEntityIds(removed.document).size).toBe(2);
    expect(Object.keys(removed.document.entities).filter((id) => id.includes('.o'))).toHaveLength(2);
  });

  it('restacks the part', () => {
    const reordered = ok(doc, 'reorder_plies', { part, order: ['B', 'C', 'A'] });
    expect(names(reordered.document)).toEqual(['B', 'C', 'A']);
    expect(reordered.affected).toHaveLength(3);
    const first = data<{ plies: { name: string }[] }>(reordered.document, 'core_sample', { part, point: [150, 150, 0] });
    expect(first.plies.map((ply) => ply.name)).toEqual(['B', 'C', 'A']);
  });

  it('refuses unknown references and incomplete or repeated orders', () => {
    expectRefusal(doc, 'edit_ply', { part: 'nope', ply: 'A' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'edit_ply', { part, ply: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'edit_ply', { part, ply: 'A', material: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'edit_ply', { part, ply: 'A', name: 'B' }, 'CMP_NAME_TAKEN');
    expectRefusal(doc, 'edit_ply', { part, ply: 'A', boundary: { kind: 'polygon', polygons: [] } }, 'CMP_ZONE_BOUNDARY_INVALID');
    expectRefusal(doc, 'delete_ply', { part: 'nope', ply: 'A' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'delete_ply', { part, ply: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'reorder_plies', { part: 'nope', order: [] }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'reorder_plies', { part, order: ['A', 'B', 'nope'] }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'reorder_plies', { part, order: ['A', 'B'] }, 'CMP_PARAM_INVALID');
    expectRefusal(doc, 'reorder_plies', { part, order: ['A', 'A', 'B'] }, 'CMP_PARAM_INVALID');
  });

  it('is pure', () => {
    expectPure(doc, () => execute(doc, 'delete_ply', { part, ply: 'A' }));
    expectPure(doc, () => execute(doc, 'reorder_plies', { part, order: ['B', 'C', 'A'] }));
  });
});

describe('core_sample', () => {
  const doc = stacked();

  it('samples along a polyline and reports unverified data', () => {
    const result = data<{ stations: { plyCount: number; flatPoint: number[] }[] }>(doc, 'core_sample', {
      part,
      polyline: [
        [0, 150, 0],
        [300, 150, 0],
      ],
      samples: 4,
    });
    expect(result.stations.map((station) => station.plyCount)).toEqual([2, 3, 3, 2]);
    expect(result.stations[1]?.flatPoint).toEqual([100, 150]);
  });

  it('refuses points off the part, missing arguments and unknown parts', () => {
    expectRefusal(doc, 'core_sample', { part, point: [-50, 0, 0] }, 'CMP_POINT_OFF_PART');
    expectRefusal(doc, 'core_sample', { part }, 'CMP_PARAM_INVALID');
    expectRefusal(
      doc,
      'core_sample',
      {
        part,
        point: [1, 1, 0],
        polyline: [
          [0, 0, 0],
          [1, 1, 0],
        ],
      },
      'CMP_PARAM_INVALID',
    );
    expectRefusal(doc, 'core_sample', { part, polyline: [[0, 0, 0]] }, 'CMP_PARAM_INVALID');
    expectRefusal(doc, 'core_sample', { part: 'nope', point: [1, 1, 0] }, 'CMP_REF_MISSING');
    expectRefusal(
      doc,
      'core_sample',
      {
        part,
        polyline: [
          [0, 0, 0],
          [1000, 0, 0],
        ],
      },
      'CMP_POINT_OFF_PART',
    );
  });
});

describe('laminate_mass failures', () => {
  it('refuses a part without plies, an unknown part and a material without density', () => {
    expectRefusal(start, 'laminate_mass', { part }, 'CMP_NO_PLIES');
    expectRefusal(start, 'laminate_mass', { part: 'nope' }, 'CMP_REF_MISSING');
    const rest = {
      name: 'light',
      form: 'ud_tape',
      E1: 1e5,
      E2: 8e3,
      G12: 4e3,
      nu12: 0.3,
      plyThickness: 0.2,
      source: 'test',
    };
    const light = apply(stacked(), 'create_lamina_material', rest);
    const used = apply(light, 'edit_ply', { part, ply: 'A', material: 'light' });
    expectRefusal(used, 'laminate_mass', { part }, 'CMP_MATERIAL_DENSITY_MISSING');
  });

  it('reports per-material totals, the centre of gravity above the face and the unverified flag', () => {
    const doc = apply(stacked(), 'edit_ply', { part, ply: 'B', material: 'AS4_3501_6' });
    const mass = data<{
      mass: number;
      cg: number[];
      perMaterial: Record<string, { plies: number }>;
      unverified: boolean;
      thickness: number;
    }>(doc, 'laminate_mass', { part });
    expect(mass.perMaterial['T300_5208']?.plies).toBe(2);
    expect(mass.perMaterial['AS4_3501_6']?.plies).toBe(1);
    expect(mass.unverified).toBe(true);
    expect(mass.thickness).toBeCloseTo(0.375, 12);
    expect(mass.cg[2]).toBeGreaterThan(0);
    expect(mass.cg[2]).toBeLessThan(0.375);
    expect(mass.cg[0]).toBeGreaterThan(100);
    expect(mass.cg[0]).toBeLessThan(300);
  });
});
