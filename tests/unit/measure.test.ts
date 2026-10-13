import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { docWith } from '../helpers/fixtureDocument';
import { build, pline } from '../helpers/addEntity';
import { xy, xyz } from '../helpers/xy';
import { defaultContext } from '@core/commands/context';
import type { ShapeTopology } from '@core/geometry/kernel';
import { fakeKernel, TETRA } from '../helpers/fakeKernel';

const CUBE = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5],
};
const SQUARE_RING = xy(2, 0, 4, 0, 4, 2, 2, 2);
const rev = (id: string, profile: Array<[number, number]>, angle?: number): Record<string, unknown> => ({
  id,
  kind: 'revolution',
  color: '#c8553d',
  profile,
  axis: [0, 1, 0],
  angle,
  segments: 32,
});

const {
  doc,
  ids: [box, far, sphere, cyl, circle, rect, square, open, line, vline, arc, ext, torus],
} = build(
  ['add_box', { size: [2, 4, 6], position: [0, 0, 0] }],
  ['add_box', { size: [2, 2, 2], position: [10, 0, 0] }],
  ['add_sphere', { radius: 3, position: [0, 0, 0] }],
  ['add_cylinder', { radius: 2, height: 5, position: [0, 0, 0] }],
  ['draw_arc', { center: [0, 0], radius: 5 }],
  ['draw_rectangle', { width: 4, height: 3 }],
  pline([0, 0, 1, 0, 1, 1, 0, 1], { closed: true }),
  pline([0, 0, 3, 0, 3, 4], { closed: false }),
  pline([0, 0, 3, 4]),
  pline([0, 0, 0, 1]),
  ['draw_arc', { center: [0, 0], radius: 2, startAngle: 0, endAngle: Math.PI / 2 }],
  ['extrude_profile', { profile: xy(0, 0, 1, 0, 1, 1, 0, 1), depth: 3 }],
  ['add_torus', { ringRadius: 4, tubeRadius: 0.5 }],
);
const revDoc = docWith(
  { id: 'mesh-1', kind: 'mesh', mesh: CUBE },
  rev('rev-ring', SQUARE_RING, 2 * Math.PI),
  rev('rev-half', SQUARE_RING, Math.PI),
  rev('rev-tri', xy(1, 0, 3, 0, 1, 2), 2 * Math.PI),
  rev('rev-no-angle', SQUARE_RING),
  rev('rev-cross', xy(-1, 0, 2, 0, 2, 2, -1, 2), 2 * Math.PI),
  rev('rev-tangent', xy(0, 0, 2, 0, 2, 2), 2 * Math.PI),
);
const data = (d: CadDocument, name: string, p: object): Record<string, number> => {
  const r = execute(d, name, p);
  expectNoOp(r, d);
  return r.data as Record<string, number>;
};

describe('measure commands (read-only)', () => {
  it.each<[string, () => object, Record<string, unknown>, string?]>([
    ['measure_distance', () => ({ point1: [0, 0, 0], point2: [3, 4, 0] }), { distance: 5, unit: 'mm' }, '5'],
    ['measure_distance', () => ({ entityId1: box, entityId2: far }), { distance: 10 }],
    ['measure_distance', () => ({ point1: [0, 0, 0], entityId2: far }), { distance: 10 }],
    ['measure_angle', () => ({ points: xyz(0, 0, 0, 1, 0, 0, 0, 1, 0) }), { degrees: 90, radians: Math.PI / 2 }, '90'],
    ['measure_angle', () => ({ points: xyz(0, 0, 0, 1, 0, 0, -1, 0, 0) }), { degrees: 180 }],
    ['measure_angle', () => ({ lineId1: line, lineId2: vline }), { degrees: 90 - (Math.atan2(4, 3) * 180) / Math.PI }],
    ['measure_area', () => ({ entityId: circle }), { area: Math.PI * 25, unit: 'mm²' }],
    ['measure_area', () => ({ entityId: rect }), { area: 12 }],
    ['measure_area', () => ({ entityId: square }), { area: 1 }],
    ['measure_area', () => ({ points: xy(0, 0, 3, 0, 0, 4) }), { area: 6 }],
    ['measure_perimeter', () => ({ entityId: line }), { perimeter: 5, unit: 'mm' }],
    ['measure_perimeter', () => ({ entityId: circle }), { perimeter: 10 * Math.PI }],
    ['measure_perimeter', () => ({ entityId: rect }), { perimeter: 14 }],
    ['measure_perimeter', () => ({ entityId: open }), { perimeter: 7 }],
    ['measure_perimeter', () => ({ entityId: square }), { perimeter: 4 }],
    ['measure_perimeter', () => ({ entityId: arc }), { perimeter: Math.PI }],
    ['mass_properties', () => ({ entityId: box }), { volume: 48, volumeUnit: 'mm³' }, '48'],
    ['mass_properties', () => ({ entityId: sphere }), { volume: (4 / 3) * Math.PI * 27 }],
    ['mass_properties', () => ({ entityId: cyl }), { volume: Math.PI * 4 * 5 }],
    ['mass_properties', () => ({ entityId: ext }), { volume: 3 }],
    ['mass_properties', () => ({ entityId: torus }), { volume: 2 * Math.PI ** 2 * 4 * 0.25, volumeUnit: 'mm³' }],
    [
      'mass_properties',
      () => ({ entityId: box, density: 0.00785 }),
      { volume: 48, density: 0.00785, mass: 48 * 0.00785, unit: 'g' },
      'mass',
    ],
    ['mass_properties', () => ({ entityId: sphere, density: 0.0027 }), { mass: (4 / 3) * Math.PI * 27 * 0.0027 }],
  ])('%s %j', (name, p, expected, summary) => {
    const r = execute(doc, name, p());
    expectNoOp(r, doc, summary);
    for (const [k, v] of Object.entries(expected)) {
      const actual = (r.data as Record<string, unknown>)[k];
      if (typeof v === 'number') expect(actual).toBeCloseTo(v, 5);
      else expect(actual).toBe(v);
    }
    expectPure(doc, () => execute(doc, name, p()));
  });

  it.each<[string, () => object, string?]>([
    ['measure_distance', () => ({ entityId1: 'ghost', point2: [0, 0, 0] }), 'ghost'],
    ['measure_distance', () => ({})],
    ['measure_angle', () => ({ lineId1: 'ghost', lineId2: 'also-ghost' }), 'ghost'],
    ['measure_angle', () => ({ lineId1: box, lineId2: box }), 'box'],
    ['measure_angle', () => ({ points: xyz(0, 0, 0, 0, 0, 0, 1, 0, 0) })],
    ['measure_angle', () => ({})],
    ['measure_area', () => ({ entityId: open }), 'not closed'],
    ['measure_area', () => ({ entityId: 'ghost' })],
    ['measure_area', () => ({ entityId: box })],
    ['measure_area', () => ({})],
    ['measure_area', () => ({ points: xy(0, 0, 1, 0) })],
    ['measure_perimeter', () => ({ entityId: 'ghost' }), 'ghost'],
    ['measure_perimeter', () => ({ entityId: box })],
    ['measure_bounding_box', () => ({ entityId: 'ghost' }), 'ghost'],
    ['mass_properties', () => ({ entityId: 'ghost' }), 'ghost'],
    ['mass_properties', () => ({ entityId: line }), "kind 'line'"],
    ['mass_properties', () => ({ entityId: 'ghost', density: 0.001 }), 'ghost'],
    ['mass_properties', () => ({ entityId: box, density: 0 }), 'density'],
    ['mass_properties', () => ({ entityId: box, density: -1 })],
    ['mass_properties', () => ({ entityId: circle, density: 0.001 })],
  ])('%s %j is a no-op without data', (name, p, summary) => {
    const r = execute(doc, name, p());
    expectNoOp(r, doc, summary);
    expect(r.data).toBeUndefined();
  });

  it('measure_bounding_box: one entity, the selection, the whole document; empty docs fail', () => {
    const one = build(['add_box', { size: [4, 6, 8], position: [0, 0, 0] }]).doc;
    expect(data(one, 'measure_bounding_box', { entityId: one.order[0] })).toEqual({ min: [-2, -3, -4], max: [2, 3, 4], size: [4, 6, 8] });
    const pair = build(['add_box', { size: [2, 2, 2], position: [0, 0, 0] }], ['add_box', { size: [2, 2, 2], position: [10, 0, 0] }]).doc;
    const all = data(pair, 'measure_bounding_box', {}) as unknown as Record<string, number[]>;
    expect([all['min']![0], all['max']![0], all['size']![0]]).toEqual([-1, 11, 12]);
    const sel = { ...pair, selection: [pair.order[0]!] };
    expect((data(sel, 'measure_bounding_box', { useSelection: true }) as unknown as Record<string, number[]>)['max']![0]).toBeCloseTo(
      1,
      10,
    );
    expectPure(pair, () => execute(pair, 'measure_bounding_box', { entityId: pair.order[0] }));
    const empty = createEmptyDocument();
    const r = execute(empty, 'measure_bounding_box', {});
    expectNoOp(r, empty, 'empty');
    expect(r.data).toBeUndefined();
  });

  it('mass_properties data shape: volume only, or with density and mass', () => {
    const b = build(['add_box', { size: [2, 4, 6], position: [0, 0, 0] }]);
    const r = execute(b.doc, 'mass_properties', { entityId: b.ids[0] });
    expect(r.data).toEqual({ volume: 48, volumeUnit: 'mm³' });
    expect(r.summary).toContain('Volume of');
    expect(execute(b.doc, 'mass_properties', { entityId: b.ids[0], density: 0.5 }).data).toEqual({
      volume: 48,
      volumeUnit: 'mm³',
      density: 0.5,
      mass: 24,
      unit: 'g',
    });
    const crossing = build(['revolve_profile', { profile: xy(-1, 0, 1, 0, 1, 1, -1, 1) }]);
    expect(execute(crossing.doc, 'mass_properties', { entityId: crossing.ids[0] }).summary).toContain('bounding-box approximation');
  });

  it.each<[string, number | null, boolean]>([
    ['mesh-1', 1, false],
    ['rev-ring', 24 * Math.PI, false],
    ['rev-tri', (20 * Math.PI) / 3, false],
    ['rev-half', 12 * Math.PI, false],
    ['rev-no-angle', 24 * Math.PI, false],
    ['rev-tangent', (16 * Math.PI) / 3, false],
    ['rev-cross', null, true],
  ])('mass_properties volume of %s (indexed mesh / Pappus revolutions)', (entityId, volume, approx) => {
    const d = data(revDoc, 'mass_properties', { entityId });
    if (volume === null) expect(d['volume']).toBeGreaterThan(0);
    else expect(d['volume']).toBeCloseTo(volume, 6);
    expect(d['volumeUnit']).toBe('mm³');
    const summary = execute(revDoc, 'mass_properties', { entityId }).summary;
    expect(summary.includes('approximation')).toBe(approx);
    if (entityId === 'rev-ring' || entityId === 'mesh-1') expect(summary).toContain(entityId === 'mesh-1' ? '1' : entityId);
    expectPure(revDoc, () => execute(revDoc, 'mass_properties', { entityId }));
  });

  it('mass of the indexed cube mesh = volume × density', () => {
    expect(data(revDoc, 'mass_properties', { entityId: 'mesh-1', density: 0.00785 })).toMatchObject({
      volume: expect.closeTo(1, 10),
      mass: expect.closeTo(0.00785, 10),
      unit: 'g',
    });
  });
});

function arcLength(startAngle: number, endAngle: number): number {
  const arc = execute(createEmptyDocument(), 'draw_arc', { center: [0, 0], radius: 2, startAngle, endAngle });
  const result = execute(arc.document, 'measure_perimeter', { entityId: arc.affected[0]! });
  return (result.data as { perimeter: number }).perimeter;
}

describe('measure_perimeter arc wrap-around', () => {
  it('start === end is a full circle (matches the renderer)', () => {
    expect(arcLength(1, 1)).toBeCloseTo(4 * Math.PI);
  });
  it('end before start sweeps CCW through 2π', () => {
    expect(arcLength(Math.PI, Math.PI / 2)).toBeCloseTo(2 * 1.5 * Math.PI);
  });
  it('a span below -2π wraps into (0, 2π]', () => {
    expect(arcLength(0, -2 * Math.PI - Math.PI / 2)).toBeCloseTo(2 * 1.5 * Math.PI);
  });
  it('a positive quarter sweep is unchanged', () => {
    expect(arcLength(0, Math.PI / 2)).toBeCloseTo(Math.PI);
  });
});

function assembly(scale?: number[]): { doc: CadDocument; instanceId: string; boxId: string } {
  const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
  const sphere = execute(box.document, 'add_sphere', { radius: 1, position: [10, 0, 0] });
  const component = execute(sphere.document, 'create_component', {
    name: 'Part',
    entityIds: [box.affected[0]!, sphere.affected[0]!],
    componentId: 'comp-part',
  });
  const inserted = execute(component.document, 'insert_instance', {
    componentId: 'comp-part',
    position: [100, 0, 0],
    ...(scale ? { scale } : {}),
  });
  return { doc: inserted.document, instanceId: inserted.affected[0]!, boxId: box.affected[0]! };
}

const dataOf = <T>(result: { data?: unknown }): T => result.data as T;

describe('measure commands on assembly instances', () => {
  it('mass_properties sums the component solids', () => {
    const { doc, instanceId } = assembly();
    const result = execute(doc, 'mass_properties', { entityId: instanceId });
    expect(dataOf<{ volume: number }>(result).volume).toBeCloseTo(8 + (4 / 3) * Math.PI);
    expect(dataOf<{ mass?: number }>(result).mass).toBeUndefined();
  });
  it('mass_properties scales with the instance scale (cubed)', () => {
    const { doc, instanceId } = assembly([2, 2, 2]);
    const result = execute(doc, 'mass_properties', { entityId: instanceId });
    expect(dataOf<{ volume: number }>(result).volume).toBeCloseTo((8 + (4 / 3) * Math.PI) * 8);
  });
  it('mass_properties uses the density param for unassigned parts', () => {
    const { doc, instanceId } = assembly();
    const result = execute(doc, 'mass_properties', { entityId: instanceId, density: 2 });
    expect(dataOf<{ mass: number }>(result).mass).toBeCloseTo(2 * (8 + (4 / 3) * Math.PI));
    expect(result.summary).toContain('assembly');
  });
  it('mass_properties uses an instance material when the parts have none', () => {
    const { doc, instanceId } = assembly();
    const withMaterial = execute(
      execute(doc, 'create_material', { name: 'steel', density: 5, color: '#b0b0b0', metalness: 1, roughness: 0.4 }).document,
      'assign_material',
      { materialName: 'steel', entityIds: [instanceId] },
    ).document;
    const result = execute(withMaterial, 'mass_properties', { entityId: instanceId, density: 1 });
    expect(dataOf<{ mass: number }>(result).mass).toBeCloseTo(5 * (8 + (4 / 3) * Math.PI));
  });
  it('measure_bounding_box measures the baked instance, not the origin', () => {
    const { doc, instanceId } = assembly();
    const result = execute(doc, 'measure_bounding_box', { entityId: instanceId });
    const { min, max } = dataOf<{ min: number[]; max: number[] }>(result);
    expect(min[0]).toBeCloseTo(99);
    expect(max[0]).toBeCloseTo(111);
  });
  it('whole-document bounding box includes instances', () => {
    const { doc } = assembly();
    const result = execute(doc, 'measure_bounding_box', {});
    expect(dataOf<{ max: number[] }>(result).max[0]).toBeCloseTo(111);
  });
  it('an instance whose component is missing is a graceful no-op', () => {
    const { doc, instanceId } = assembly();
    const broken: CadDocument = { ...doc, components: {} };
    for (const [name, params] of [
      ['mass_properties', { entityId: instanceId }],
      ['mass_properties', { entityId: instanceId, density: 1 }],
    ] as const) {
      const result = execute(broken, name, params);
      expect(result.data).toBeUndefined();
      expect(result.affected).toEqual([]);
      expect(result.summary).toContain('missing component');
    }
  });
});

const TOPOLOGY: ShapeTopology = { solids: 1, faces: [], edges: [], vertices: 4, volume: 0.17 };

function unionOfTwoBoxes(topology: ShapeTopology | null): { doc: CadDocument; id: string; kernel: ReturnType<typeof fakeKernel> } {
  const kernel = fakeKernel({ boolean: TETRA, topology });
  const ctx = { ...defaultContext(), kernel };
  const first = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }, ctx);
  const second = execute(first.document, 'add_box', { size: [1, 1, 1] }, ctx);
  const [a, b] = second.document.order;
  const union = execute(second.document, 'boolean', { op: 'union', a, b }, ctx);
  return { doc: union.document, id: union.affected[0]!, kernel };
}

describe('mass_properties of a kernel result', () => {
  it('reports the exact B-rep volume when the kernel has topology', () => {
    const { doc, id, kernel } = unionOfTwoBoxes(TOPOLOGY);
    const result = execute(doc, 'mass_properties', { entityId: id }, { ...defaultContext(), kernel });
    expect(result.data).toEqual({ volume: 0.17, volumeUnit: 'mm³', method: 'exact' });
    expectNoOp(result, doc, '(exact B-rep)');
  });
  it('falls back to the display mesh without exact topology', () => {
    const { doc, id, kernel } = unionOfTwoBoxes(null);
    const result = execute(doc, 'mass_properties', { entityId: id }, { ...defaultContext(), kernel });
    expect(result.data).toMatchObject({ method: 'mesh' });
    expect((result.data as { volume: number }).volume).toBeCloseTo(1 / 6, 9);
    expect(result.summary).toContain('display mesh');
  });
  it('mass_properties weighs the exact volume', () => {
    const { doc, id, kernel } = unionOfTwoBoxes(TOPOLOGY);
    const result = execute(doc, 'mass_properties', { entityId: id, density: 2 }, { ...defaultContext(), kernel });
    expect(result.data).toMatchObject({ volume: 0.17, mass: 0.34 });
  });
  it('a primitive keeps its analytic volume (no method)', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [2, 3, 4] });
    const result = execute(box.document, 'mass_properties', { entityId: box.affected[0]! });
    expect(result.data).toEqual({ volume: 24, volumeUnit: 'mm³' });
  });
});
