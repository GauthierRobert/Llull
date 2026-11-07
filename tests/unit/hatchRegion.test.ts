import { describe, it, expect } from 'vitest';
import { type CadDocument, type RegionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { entityBounds } from '@core/geometry/bounds';
import { loopDepths, regionFaces, regionHatchLines, regionLoopsIssue, regionNetArea } from '@core/geometry/region';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { docWith } from '../helpers/fixtureDocument';
import { xy } from '../helpers/xy';
import { placementOf } from '@core/commands/draw2d/sketchPlanes';

/** Hand-computed: 100 x 60 plate with a diameter-20 hole = 6000 - pi * 10^2. */
const PLATE_WITH_HOLE_AREA = 6000 - 100 * Math.PI;

const plate = { id: 'plate', kind: 'rectangle', width: 100, height: 60 };
const hole = { id: 'hole', kind: 'circle', center: [50, 30], radius: 10 };
const empty = createEmptyDocument();

const regionsOf = (doc: CadDocument, affected: readonly string[]): RegionEntity[] => affected.map((id) => doc.entities[id] as RegionEntity);

const areaOf = (doc: CadDocument, id: string): number => (execute(doc, 'measure_area', { entityId: id }).data as { area: number }).area;

/** Refused with `code`: unchanged document, nothing affected, the code in summary and error. */
function expectRefused(doc: CadDocument, params: object, code: string): void {
  const result = execute(doc, 'hatch_region', params as Record<string, unknown>);
  expectNoOp(result, doc, code);
  expect(result.error?.code).toBe(code);
  expect(result.error?.remediation.length).toBeGreaterThan(10);
}

describe('hatch_region from closed shapes', () => {
  it('plate 100x60 with a diameter-20 hole: net area 6000 - 100 pi = 5685.84, exact (not the polygon)', () => {
    const doc = docWith(plate, hole);
    const result = execute(doc, 'hatch_region', { ids: ['plate', 'hole'] });
    expect(result.affected).toHaveLength(1);
    const [region] = regionsOf(result.document, result.affected) as [RegionEntity];
    expect(region.kind).toBe('region');
    expect(region.loops).toHaveLength(2);
    expect(region.curves).toHaveLength(2);
    expect(areaOf(result.document, region.id)).toBeCloseTo(5685.84, 2);
    expect(regionNetArea(region)).toBeCloseTo(PLATE_WITH_HOLE_AREA, 9);
    expect(result.document.order).toEqual(['plate', 'hole', region.id]);
    expect(result.document.entities['plate']).toBe(doc.entities['plate']);
    expect(result.summary).toContain(`"${region.id}" net area 5685.84`);
    expect(region.hatch).toMatchObject({ pattern: 'lines', angle: Math.PI / 4 });
  });

  it('is pure and step-scoped ids are deterministic', () => {
    const doc = docWith(plate, hole);
    expectPure(doc, () => execute(doc, 'hatch_region', { ids: ['plate', 'hole'] }));
    const a = execute(doc, 'hatch_region', { ids: ['hole', 'plate'] });
    expect(regionNetArea(regionsOf(a.document, a.affected)[0] as RegionEntity)).toBeCloseTo(PLATE_WITH_HOLE_AREA, 9);
  });

  it('L-shape polyline: 40x10 bar + 10x20 leg = 600', () => {
    const doc = docWith({ id: 'ell', kind: 'polyline', closed: true, points: xy(0, 0, 40, 0, 40, 10, 10, 10, 10, 30, 0, 30) });
    const result = execute(doc, 'hatch_region', { ids: ['ell'] });
    expect(areaOf(result.document, result.affected[0] as string)).toBeCloseTo(600, 9);
    const region = regionsOf(result.document, result.affected)[0] as RegionEntity;
    expect(region.curves?.[0]).toHaveLength(6);
  });

  it('nested islands are even-odd: 100x100 - 60x60 hole + 20x20 island = 10000 - 3600 + 400 = 6800', () => {
    const doc = docWith(
      { id: 'outer', kind: 'rectangle', width: 100, height: 100 },
      { id: 'hole', kind: 'rectangle', width: 60, height: 60, position: [20, 20, 0] },
      { id: 'island', kind: 'rectangle', width: 20, height: 20, position: [40, 40, 0] },
    );
    const result = execute(doc, 'hatch_region', { ids: ['island', 'outer', 'hole'] });
    expect(result.affected).toHaveLength(1);
    const region = regionsOf(result.document, result.affected)[0] as RegionEntity;
    expect(areaOf(result.document, region.id)).toBeCloseTo(6800, 9);
    expect(loopDepths(region.loops).slice().sort()).toEqual([0, 1, 2]);
    // faces: the outer ring (with the hole) and the island on its own
    expect(
      regionFaces(region.loops)
        .map((face) => face.holes.length)
        .sort(),
    ).toEqual([0, 1]);
  });

  it('disjoint outermost loops make one region each, holes go to their own region', () => {
    const doc = docWith(
      { id: 'a', kind: 'rectangle', width: 10, height: 10 },
      { id: 'a-hole', kind: 'rectangle', width: 2, height: 2, position: [4, 4, 0] },
      { id: 'b', kind: 'rectangle', width: 10, height: 10, position: [30, 0, 0] },
    );
    const result = execute(doc, 'hatch_region', { ids: ['a', 'a-hole', 'b'] });
    expect(result.affected).toHaveLength(2);
    const [first, second] = regionsOf(result.document, result.affected) as [RegionEntity, RegionEntity];
    expect(areaOf(result.document, first.id)).toBeCloseTo(96, 9);
    expect(areaOf(result.document, second.id)).toBeCloseTo(100, 9);
    // both regions live in the plane of the first listed shape (origin [0,0,0]); b's loop is offset inside it
    expect(second.position).toEqual([0, 0, 0]);
    expect(second.loops[0]?.[0]).toEqual([30, 0]);
  });

  it('open pieces that join end to end form one more loop (four lines = a 10x5 rectangle)', () => {
    const doc = docWith(
      { id: 'l1', kind: 'line', start: [0, 0], end: [10, 0] },
      { id: 'l2', kind: 'line', start: [10, 0], end: [10, 5] },
      { id: 'l3', kind: 'line', start: [10, 5], end: [0, 5] },
      { id: 'l4', kind: 'line', start: [0, 5], end: [0, 0] },
    );
    const result = execute(doc, 'hatch_region', { ids: ['l1', 'l2', 'l3', 'l4'] });
    expect(areaOf(result.document, result.affected[0] as string)).toBeCloseTo(50, 9);
  });

  it('a closed spline and an ellipse bound a region too (ellipse area = pi a b, exact)', () => {
    const doc = docWith({ id: 'e', kind: 'ellipse', center: [0, 0], radiusX: 6, radiusY: 3 });
    const result = execute(doc, 'hatch_region', { ids: ['e'] });
    // quarter Beziers with kappa 0.5523: area within 0.03 % of the ellipse
    expect(areaOf(result.document, result.affected[0] as string) / (Math.PI * 18)).toBeCloseTo(1, 3);
  });

  it('sits at the first shape position and plane (shapes on a raised plane)', () => {
    const doc = docWith({ ...plate, position: [5, 6, 7] }, { ...hole, position: [5, 6, 7] });
    const result = execute(doc, 'hatch_region', { ids: ['plate', 'hole'], name: 'Slab', color: '#112233' });
    const region = regionsOf(result.document, result.affected)[0] as RegionEntity;
    expect(region.position).toEqual([5, 6, 7]);
    expect(region.name).toBe('Slab');
    expect(region.color).toBe('#112233');
  });
});

describe('hatch_region pick point', () => {
  const doc = docWith(
    plate,
    hole,
    { id: 'island', kind: 'rectangle', width: 4, height: 4, position: [48, 28, 0] },
    { id: 'far', kind: 'rectangle', width: 5, height: 5, position: [500, 500, 0] },
  );

  it('a point in the plate (outside the hole) hatches the plate with its direct holes: 6000 - 100 pi', () => {
    const result = execute(doc, 'hatch_region', { point: [5, 5] });
    expect(areaOf(result.document, result.affected[0] as string)).toBeCloseTo(PLATE_WITH_HOLE_AREA, 9);
    expect(result.summary).toContain('2 loop(s)');
  });

  it('a point in the hole hatches the hole (its island is a hole again): 100 pi - 16', () => {
    const result = execute(doc, 'hatch_region', { point: [43, 30] });
    expect(areaOf(result.document, result.affected[0] as string)).toBeCloseTo(100 * Math.PI - 16, 9);
  });

  it('a point in the island hatches the island: 16', () => {
    const result = execute(doc, 'hatch_region', { point: [50, 30], pattern: 'solid' });
    const region = regionsOf(result.document, result.affected)[0] as RegionEntity;
    expect(areaOf(result.document, region.id)).toBeCloseTo(16, 9);
    expect(region.hatch?.pattern).toBe('solid');
  });

  it('searches a sketch plane (an xz plane lifted 5 along its normal), in plane coordinates', () => {
    const created = execute(empty, 'create_sketch_plane', { plane: 'xz', offset: 5 });
    const planeId = (created.data as { id: string }).id;
    const { position, rotation } = placementOf((created.document.sketchPlanes ?? {})[planeId]!.frame);
    const onPlane = {
      ...docWith({ id: 'r', kind: 'rectangle', width: 10, height: 8, position, rotation }),
      sketchPlanes: created.document.sketchPlanes ?? {},
    };
    const result = execute(onPlane, 'hatch_region', { point: [5, 4], plane: planeId });
    expect(areaOf(result.document, result.affected[0] as string)).toBeCloseTo(80, 9);
    const region = regionsOf(result.document, result.affected)[0] as RegionEntity;
    expect(region.position).toEqual(position);
    expect(region.rotation).toEqual(rotation);
    // the same pick on the world plane finds nothing: the rectangle is not on it
    expectRefused(onPlane, { point: [5, 4] }, 'REGION_POINT_NOT_ENCLOSED');
  });

  it('refuses a point outside every shape, a shape cutting the boundary, an unknown plane', () => {
    expectRefused(doc, { point: [300, 300] }, 'REGION_POINT_NOT_ENCLOSED');
    const crossing = docWith(plate, { id: 'bar', kind: 'rectangle', width: 40, height: 30, position: [80, 20, 0] });
    expectRefused(crossing, { point: [5, 5] }, 'REGION_LOOPS_CROSS');
    expectRefused(doc, { point: [5, 5], plane: 'nope' }, 'REGION_ENTITY_NOT_FOUND');
  });

  it('ignores shapes on other planes', () => {
    const lifted = docWith(plate, { id: 'up', kind: 'rectangle', width: 200, height: 200, position: [-50, -50, 9] });
    const result = execute(lifted, 'hatch_region', { point: [5, 5] });
    expect(areaOf(result.document, result.affected[0] as string)).toBeCloseTo(6000, 9);
  });
});

describe('hatch_region refusals', () => {
  it.each<[string, object, string]>([
    ['empty selection', { ids: [] }, 'REGION_EMPTY_SELECTION'],
    ['nothing given', {}, 'REGION_EMPTY_SELECTION'],
    ['ids and point', { ids: ['plate'], point: [1, 1] }, 'REGION_BAD_PARAM'],
    ['spacing 0', { ids: ['plate'], spacing: 0 }, 'REGION_BAD_PARAM'],
    ['unknown id', { ids: ['plate', 'ghost'] }, 'REGION_ENTITY_NOT_FOUND'],
    ['too many ids', { ids: Array.from({ length: 300 }, (_, k) => `s${k}`) }, 'REGION_TOO_LARGE'],
  ])('%s', (_label, params, code) => {
    expectRefused(docWith(plate), params, code);
  });

  it('refuses an open polyline, a kind that bounds nothing, open pieces with a gap', () => {
    expectRefused(
      docWith({ id: 'p', kind: 'polyline', closed: false, points: xy(0, 0, 5, 0, 5, 5) }),
      { ids: ['p'] },
      'REGION_OPEN_BOUNDARY',
    );
    expectRefused(docWith({ id: 'pt', kind: 'point' }), { ids: ['pt'] }, 'REGION_UNSUPPORTED_KIND');
    const gap = docWith({ id: 'l1', kind: 'line', start: [0, 0], end: [10, 0] }, { id: 'l2', kind: 'line', start: [10, 1], end: [10, 5] });
    expectRefused(gap, { ids: ['l1', 'l2'] }, 'REGION_OPEN_BOUNDARY');
  });

  it('refuses shapes on another plane (offset or rotated)', () => {
    expectRefused(docWith(plate, { ...hole, id: 'hole2', position: [0, 0, 3] }), { ids: ['plate', 'hole2'] }, 'REGION_PLANE_MISMATCH');
    expectRefused(docWith(plate, { ...hole, id: 'hole2', rotation: [0.5, 0, 0] }), { ids: ['plate', 'hole2'] }, 'REGION_PLANE_MISMATCH');
  });

  it('refuses a bow-tie, crossing loops and a flat (doubled-back) loop', () => {
    expectRefused(
      docWith({ id: 'bow', kind: 'polyline', closed: true, points: xy(0, 0, 10, 10, 10, 0, 0, 10) }),
      { ids: ['bow'] },
      'REGION_SELF_INTERSECTING',
    );
    expectRefused(
      docWith(plate, { id: 'over', kind: 'rectangle', width: 100, height: 60, position: [50, 30, 0] }),
      { ids: ['plate', 'over'] },
      'REGION_LOOPS_CROSS',
    );
    expectRefused(
      docWith({ id: 'flat', kind: 'polyline', closed: true, points: xy(0, 0, 5, 0, 10, 0) }),
      { ids: ['flat'] },
      'REGION_SELF_INTERSECTING',
    );
  });

  it('refuses an oversized boundary by point budget', () => {
    const many = docWith({
      id: 'big',
      kind: 'polyline',
      closed: true,
      points: Array.from({ length: 4500 }, (_, k) => [Math.cos(k), Math.sin(k)]),
    });
    expectRefused(many, { ids: ['big'] }, 'REGION_TOO_LARGE');
  });
});

describe('hatch patterns', () => {
  const rectDoc = docWith(plate);
  const hatchOf = (params: object): RegionEntity => {
    const result = execute(rectDoc, 'hatch_region', { ids: ['plate'], ...params });
    return regionsOf(result.document, result.affected)[0] as RegionEntity;
  };

  it('none = outline only; solid and cross are stored; default spacing is a 1-2-5 step near diagonal / 40', () => {
    expect(hatchOf({ pattern: 'none' }).hatch).toBeUndefined();
    expect(hatchOf({ pattern: 'solid' }).hatch?.pattern).toBe('solid');
    // diagonal of 100 x 60 = 116.6; / 40 = 2.9 -> 5
    expect(hatchOf({}).hatch?.spacing).toBe(5);
  });

  it('horizontal lines at spacing 7.5 over a 100x60 rectangle: 7 lines of length 100 (y = 7.5 .. 52.5; y = 0 lies on the bottom edge and is skipped)', () => {
    const region = hatchOf({ angle: 0, spacing: 7.5 });
    const lines = regionHatchLines(region);
    expect(lines).toHaveLength(7);
    expect(Math.min(...lines.map(([a]) => a[1]))).toBeCloseTo(7.5, 9);
    for (const [a, b] of lines) expect(Math.abs(b[0] - a[0])).toBeCloseTo(100, 9);
  });

  it('cross doubles the lines (the second family at angle + 90 degrees); solid and none draw no lines', () => {
    const lines = regionHatchLines(hatchOf({ pattern: 'lines', angle: 0, spacing: 10 })).length;
    expect(regionHatchLines(hatchOf({ pattern: 'cross', angle: 0, spacing: 10 })).length).toBeGreaterThan(lines);
    expect(regionHatchLines(hatchOf({ pattern: 'solid' }))).toEqual([]);
    expect(regionHatchLines(hatchOf({ pattern: 'none' }))).toEqual([]);
  });

  it('hatch lines never cross the hole: even-odd clipping (total length = hatch of plate minus the hole chord)', () => {
    const result = execute(docWith(plate, hole), 'hatch_region', { ids: ['plate', 'hole'], angle: 0, spacing: 5 });
    const region = regionsOf(result.document, result.affected)[0] as RegionEntity;
    const total = regionHatchLines(region).reduce((sum, [a, b]) => sum + Math.abs(b[0] - a[0]), 0);
    // 11 lines (y = 5 .. 55; y = 0 is the bottom edge) x 100, minus the circle chords at y = 25, 30 (diameter 20) and 35 (polygon, within 1 %)
    const plain = 11 * 100;
    expect(total).toBeLessThan(plain - 2 * 19);
    expect(total).toBeGreaterThan(plain - 2 * 21 - 20);
  });
});

describe('region in the rest of the model', () => {
  const made = (): { doc: CadDocument; region: RegionEntity } => {
    const result = execute(docWith(plate, hole), 'hatch_region', { ids: ['plate', 'hole'], angle: 0, spacing: 5 });
    return { doc: result.document, region: regionsOf(result.document, result.affected)[0] as RegionEntity };
  };

  it('bounds are the outer loop', () => {
    const { region } = made();
    const { min, max } = entityBounds({ ...region, position: [10, 20, 0] });
    expect(min).toEqual([10, 20, 0]);
    expect(max).toEqual([110, 80, 0]);
  });

  it('scale_entity scales loops, exact curves and spacing: area x 4', () => {
    const { doc, region } = made();
    const result = execute(doc, 'scale_entity', { id: region.id, factor: 2 });
    const scaled = result.document.entities[region.id] as RegionEntity;
    expect(scaled.hatch?.spacing).toBe(10);
    expect(scaled.loops[0]?.[2]).toEqual([200, 120]);
    expect(areaOf(result.document, region.id)).toBeCloseTo(4 * PLATE_WITH_HOLE_AREA, 6);
    expectPure(doc, () => execute(doc, 'scale_entity', { id: region.id, factor: 2 }));
  });

  it('move, rotate, mirror, duplicate and array keep the region intact', () => {
    const { doc, region } = made();
    const moved = execute(doc, 'move_entities', { ids: [region.id], delta: [10, 0, 0] });
    expect((moved.document.entities[region.id] as RegionEntity).position).toEqual([10, 0, 0]);
    const rotated = execute(doc, 'rotate_entity', { id: region.id, delta: [0, 0, Math.PI / 2] });
    expect((rotated.document.entities[region.id] as RegionEntity).rotation[2]).toBeCloseTo(Math.PI / 2, 9);
    const mirrored = execute({ ...doc, entities: { ...doc.entities, [region.id]: { ...region, position: [3, 4, 0] } } }, 'mirror_entity', {
      id: region.id,
      axis: 'x',
    });
    expect((mirrored.document.entities[region.id] as RegionEntity).position).toEqual([-3, 4, 0]);
    const copies = execute(doc, 'array_linear', { id: region.id, count: 3, offset: [0, 100, 0] });
    expect(copies.affected).toHaveLength(2);
    for (const id of copies.affected) expect(areaOf(copies.document, id)).toBeCloseTo(PLATE_WITH_HOLE_AREA, 9);
    const duplicated = execute(doc, 'duplicate_entities', { ids: [region.id] });
    expect(duplicated.affected).toHaveLength(1);
    expect((duplicated.document.entities[duplicated.affected[0] as string] as RegionEntity).loops).toEqual(region.loops);
  });

  it('measure_perimeter is the outer plus hole boundary: 320 + 20 pi', () => {
    const { doc, region } = made();
    const perimeter = (execute(doc, 'measure_perimeter', { entityId: region.id }).data as { perimeter: number }).perimeter;
    expect(perimeter).toBeCloseTo(320 + 20 * Math.PI, 9);
  });

  it('survives save and load', () => {
    const { doc, region } = made();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.entities[region.id]).toEqual(region);
  });

  it('check_model flags a region without net area', () => {
    const flat = docWith({ id: 'flat', kind: 'region', loops: [xy(0, 0, 5, 0, 10, 0)] });
    const report = execute(flat, 'check_model', {}).data as { issues: Array<{ code: string }> };
    expect(report.issues.map((issue) => issue.code)).toContain('degenerate_size');
    const { doc } = made();
    expect((execute(doc, 'check_model', {}).data as { ok: boolean }).ok).toBe(true);
  });

  it('is listed by find_entities with its kind', () => {
    const { doc, region } = made();
    const found = execute(doc, 'find_entities', { kind: 'region' });
    expect(JSON.stringify(found.data)).toContain(region.id);
  });

  it('empty document: measure_area of a missing region is a no-op', () => {
    expectNoOp(execute(empty, 'measure_area', { entityId: 'region-1' }), empty, 'not found');
  });
});

describe('regionLoopsIssue', () => {
  it('names a loop with no area or fewer than 3 points as degenerate, with the index of the offending loop', () => {
    expect(
      regionLoopsIssue([
        [
          [0, 0],
          [0, 0],
          [0, 0],
        ],
      ]),
    ).toEqual({ code: 'REGION_DEGENERATE_LOOP', index: 0 });
    expect(
      regionLoopsIssue([
        [
          [0, 0],
          [4, 0],
          [4, 4],
        ],
        [
          [1, 1],
          [2, 1],
        ],
      ]),
    ).toEqual({ code: 'REGION_DEGENERATE_LOOP', index: 1 });
    expect(regionLoopsIssue([])).toBeNull();
  });
});

describe('touching, tangent and degenerate boundaries are refused (hand-built contacts)', () => {
  const outer = { id: 'outer', kind: 'rectangle', width: 100, height: 100 };
  const poly = (id: string, ...points: number[]): Record<string, unknown> => ({
    id,
    kind: 'polyline',
    closed: true,
    points: xy(...points),
  });

  it.each<[string, Array<Record<string, unknown>>, string]>([
    ['a hole vertex on the outer edge (T-touch)', [outer, poly('h', 50, 0, 70, 30, 30, 30)], 'REGION_LOOPS_TOUCH'],
    [
      'a hole sharing a stretch of the outer edge (collinear overlap)',
      [outer, { id: 'h', kind: 'rectangle', width: 20, height: 20, position: [0, 40, 0] }],
      'REGION_LOOPS_TOUCH',
    ],
    [
      'two rectangles sharing an edge',
      [
        { id: 'a', kind: 'rectangle', width: 10, height: 10 },
        { id: 'b', kind: 'rectangle', width: 10, height: 10, position: [10, 0, 0] },
      ],
      'REGION_LOOPS_TOUCH',
    ],
    [
      'two rectangles meeting at one corner',
      [
        { id: 'a', kind: 'rectangle', width: 10, height: 10 },
        { id: 'b', kind: 'rectangle', width: 10, height: 10, position: [10, 10, 0] },
      ],
      'REGION_LOOPS_TOUCH',
    ],
    [
      'a circle tangent to a rectangle edge at a quadrant point',
      [plate, { id: 'c', kind: 'circle', center: [50, 70], radius: 10 }],
      'REGION_LOOPS_TOUCH',
    ],
    [
      'a circle tangent to a slanted edge between tessellation vertices (exact curve vs polygon, within the sagitta tolerance)',
      [poly('tri', 0, 0, 100, 50, 0, 50), { id: 'c', kind: 'circle', center: [44.472136, 11.055728], radius: 10 }],
      'REGION_LOOPS_TOUCH',
    ],
    ['the same outline twice (coincident shapes)', [plate, { ...plate, id: 'twin' }], 'REGION_LOOPS_TOUCH'],
    ['a spike polyline [0,0] [10,0] [5,0] [5,5]', [poly('spike', 0, 0, 10, 0, 5, 0, 5, 5)], 'REGION_SELF_INTERSECTING'],
    ['a vertex on another edge of the same loop', [poly('pinch', 0, 0, 10, 0, 10, 10, 5, 0, 0, 10)], 'REGION_SELF_INTERSECTING'],
  ])('%s', (_label, shapes, code) => {
    expectRefused(docWith(...shapes), { ids: shapes.map((shape) => shape['id']) }, code);
  });

  it('a visible gap is fine: circle 1 unit above the plate, rectangles 0.001 apart make separate regions', () => {
    const gap = execute(docWith(plate, { id: 'c', kind: 'circle', center: [50, 71], radius: 10 }), 'hatch_region', { ids: ['plate', 'c'] });
    expect(gap.affected).toHaveLength(2);
    const near = docWith(
      { id: 'a', kind: 'rectangle', width: 10, height: 10 },
      { id: 'b', kind: 'rectangle', width: 10, height: 10, position: [10.001, 0, 0] },
    );
    expect(execute(near, 'hatch_region', { ids: ['a', 'b'] }).affected).toHaveLength(2);
  });

  it('duplicate ids are one shape: [plate, plate, hole] = [plate, hole]', () => {
    const doc = docWith(plate, hole);
    const result = execute(doc, 'hatch_region', { ids: ['plate', 'hole', 'plate', 'hole'] });
    expect(result.affected).toHaveLength(1);
    expect(areaOf(result.document, result.affected[0] as string)).toBeCloseTo(PLATE_WITH_HOLE_AREA, 9);
  });

  it('a hole near but clear of the edge is accepted (gap 1)', () => {
    const doc = docWith(outer, { id: 'h', kind: 'rectangle', width: 20, height: 20, position: [1, 40, 0] });
    const result = execute(doc, 'hatch_region', { ids: ['outer', 'h'] });
    expect(areaOf(result.document, result.affected[0] as string)).toBeCloseTo(10000 - 400, 9);
  });

  it('a pick point exactly on an outline is refused (REGION_POINT_ON_BOUNDARY), on an edge or on a circle', () => {
    const doc = docWith(plate, hole);
    expectRefused(doc, { point: [0, 30] }, 'REGION_POINT_ON_BOUNDARY');
    expectRefused(doc, { point: [60, 30] }, 'REGION_POINT_ON_BOUNDARY');
    expectRefused(doc, { point: [50, 60] }, 'REGION_POINT_ON_BOUNDARY');
  });

  it('a pick refuses a shape touching the chosen boundary', () => {
    const doc = docWith(plate, { id: 'next', kind: 'rectangle', width: 20, height: 60, position: [100, 0, 0] });
    expectRefused(doc, { point: [5, 5] }, 'REGION_LOOPS_TOUCH');
  });

  it('a pick ignores shapes far away: 600 distant rectangles do not matter, and 300 shapes around the point are refused', () => {
    const far = Array.from({ length: 600 }, (_, k) => ({
      id: `far${k}`,
      kind: 'rectangle',
      width: 5,
      height: 5,
      position: [1000 + k * 10, 1000, 0],
    }));
    const result = execute(docWith(plate, ...far), 'hatch_region', { point: [5, 5] });
    expect(areaOf(result.document, result.affected[0] as string)).toBeCloseTo(6000, 9);
    const nested = Array.from({ length: 300 }, (_, k) => ({
      id: `n${k}`,
      kind: 'rectangle',
      width: 1000 - k,
      height: 1000 - k,
      position: [k / 2, k / 2, 0],
    }));
    expectRefused(docWith(...nested), { point: [250, 250] }, 'REGION_TOO_LARGE');
  });
});
