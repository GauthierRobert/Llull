import { describe, it, expect } from 'vitest';
import { type CadDocument, type Entity, type SweepEntity, DEFAULT_LAYER_ID, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { entityBounds } from '@core/geometry/bounds';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { tessellateEntity } from '@core/commands/render/polygons';
import { sweepFrames, sweepSegmentRings, sweepTriangles } from '@core/geometry/sweep';
import { expectNoOp } from '../helpers/expectNoOp';
import { docWith, volumeOf, isWatertight } from '../helpers/fixtureDocument';

const empty = createEmptyDocument();

const L_PATH = [
  [0, 0, 0],
  [10, 0, 0],
  [10, 10, 0],
];

function sweepOf(doc: CadDocument, params: Record<string, unknown>): SweepEntity {
  const result = execute(doc, 'sweep_profile', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return result.document.entities[result.affected[0] as string] as SweepEntity;
}

describe('sweep_profile — happy paths', () => {
  it('round pipe along a bent polyline: lines + exact bend arc, positioned at the start', () => {
    const result = execute(empty, 'sweep_profile', {
      path: [
        [5, 5, 1],
        [15, 5, 1],
        [15, 15, 1],
      ],
      radius: 1,
      bendRadius: 2,
    });
    expect(result.affected).toHaveLength(1);
    const pipe = result.document.entities[result.affected[0] as string] as SweepEntity;
    expect(pipe.kind).toBe('sweep');
    expect(pipe.position).toEqual([5, 5, 1]);
    expect(pipe.path.map((s) => s.type)).toEqual(['line', 'arc', 'line']);
    expect(pipe.path[0]?.points[0]).toEqual([0, 0, 0]);
    expect(pipe.section).toEqual({ shape: 'circle', radius: 1 });
    expect(result.summary).toContain('sweep_profile: created sweep');
    // Pappus: π r² × (8 + π + 8)
    expect(volumeOf(pipe)).toBeCloseTo(Math.PI * (16 + Math.PI), 9);
  });

  it('defaults the bend to three section radii (long-radius elbow)', () => {
    const pipe = sweepOf(empty, { path: L_PATH, radius: 1 });
    const arc = pipe.path[1];
    expect(arc?.type).toBe('arc');
    expect(arc?.points[0]).toEqual([7, 0, 0]);
  });

  it('hollow pipe subtracts the bore from the volume', () => {
    const tube = sweepOf(empty, { path: L_PATH, radius: 1, innerRadius: 0.8, bendRadius: 2 });
    expect(tube.section).toEqual({ shape: 'circle', radius: 1, innerRadius: 0.8 });
    expect(volumeOf(tube)).toBeCloseTo(Math.PI * 0.36 * (16 + Math.PI), 9);
  });

  it('smooth: true runs a spline through the points', () => {
    const hose = sweepOf(empty, {
      path: [
        [0, 0, 0],
        [5, 2, 1],
        [10, 0, 3],
      ],
      smooth: true,
      radius: 0.4,
    });
    expect(hose.path.map((s) => s.type)).toEqual(['bezier', 'bezier']);
  });

  it('polygon section gets a closed-mesh volume of area × length on a straight run', () => {
    const bar = sweepOf(empty, {
      path: [
        [0, 0, 0],
        [0, 0, 10],
      ],
      section: [
        [-1, -0.5],
        [1, -0.5],
        [1, 0.5],
        [-1, 0.5],
      ],
    });
    expect(bar.section.shape).toBe('profile');
    expect(volumeOf(bar)).toBeCloseTo(20, 9);
    const b = entityBounds(bar);
    expect(b.max[2] - b.min[2]).toBeCloseTo(10, 9);
  });

  it('sectionId takes a sketched circle (exact arcs) as the section', () => {
    const doc = docWith({ id: 'sec', kind: 'circle', center: [0, 0], radius: 0.5 });
    const rod = sweepOf(doc, { path: L_PATH, sectionId: 'sec', bendRadius: 3 });
    expect(rod.section.shape).toBe('profile');
    expect(rod.section.shape === 'profile' && rod.section.curves?.length).toBe(2);
    expect(volumeOf(rod) / (Math.PI * 0.25 * (14 + 1.5 * Math.PI))).toBeCloseTo(1, 1);
  });

  it.each([
    ['line', { kind: 'line', start: [0, 0], end: [8, 0] }, ['line']],
    ['arc', { kind: 'arc', center: [0, 0], radius: 5, startAngle: 0, endAngle: Math.PI }, ['arc']],
    [
      'polyline (bent)',
      {
        kind: 'polyline',
        closed: false,
        points: [
          [0, 0],
          [8, 0],
          [8, 8],
        ],
      },
      ['line', 'arc', 'line'],
    ],
    [
      'spline',
      {
        kind: 'spline',
        closed: false,
        points: [
          [0, 0],
          [4, 3],
          [8, 0],
        ],
      },
      ['bezier', 'bezier'],
    ],
  ])('pathId %s follows the sketch in its work plane', (_label, shape, types) => {
    const doc = docWith({ id: 'route', position: [0, 0, 2], ...shape });
    const pipe = sweepOf(doc, { pathId: 'route', radius: 0.5, bendRadius: 2 });
    expect(pipe.path.map((s) => s.type)).toEqual(types);
    expect(pipe.position[2]).toBe(2);
  });

  it('a polyline pathId can be smoothed and a rotated sketch is placed by its plane', () => {
    const doc = docWith({
      id: 'route',
      kind: 'polyline',
      closed: false,
      rotation: [Math.PI / 2, 0, 0],
      points: [
        [0, 0],
        [4, 4],
        [8, 0],
      ],
    });
    const pipe = sweepOf(doc, { pathId: 'route', smooth: true, radius: 0.5 });
    expect(pipe.path.every((s) => s.type === 'bezier')).toBe(true);
    const peak = pipe.path[0]?.points[3];
    expect(peak?.[1]).toBeCloseTo(0, 9);
    expect(peak?.[2]).toBeCloseTo(4, 9);
  });

  it('honours explicit id, layer and color', () => {
    const result = execute(empty, 'sweep_profile', {
      path: L_PATH,
      radius: 1,
      id: 'pipe-a',
      color: '#123456',
      layerId: 'missing',
    });
    const pipe = result.document.entities['pipe-a'] as SweepEntity;
    expect(pipe.color).toBe('#123456');
    expect(pipe.layerId).toBe(DEFAULT_LAYER_ID);
  });

  it('is pure', () => {
    const doc = docWith({ id: 'sec', kind: 'rectangle', width: 1, height: 1 });
    const snapshot = JSON.stringify(doc);
    execute(doc, 'sweep_profile', { path: L_PATH, sectionId: 'sec' });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('sweep_profile — failures are no-ops', () => {
  const rect = docWith(
    { id: 'rect', kind: 'rectangle', width: 1, height: 1 },
    {
      id: 'open',
      kind: 'polyline',
      closed: false,
      points: [
        [0, 0],
        [1, 0],
      ],
    },
    { id: 'ring', kind: 'circle', center: [0, 0], radius: 3 },
    { id: 'label', kind: 'text', content: 'x', height: 1 },
  );
  it.each([
    ['no section', { path: L_PATH }, 'exactly one of radius'],
    [
      'two sections',
      {
        path: L_PATH,
        radius: 1,
        section: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      },
      'exactly one',
    ],
    ['radius <= 0', { path: L_PATH, radius: 0 }, 'radius must be > 0'],
    ['bore too big', { path: L_PATH, radius: 1, innerRadius: 1 }, 'innerRadius must be'],
    [
      'bore on a polygon',
      {
        path: L_PATH,
        section: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        innerRadius: 0.1,
      },
      'only applies',
    ],
    ['bad section point', { path: L_PATH, section: [[0, 0], [1], [0, 1]] }, 'section point 1'],
    [
      'short section',
      {
        path: L_PATH,
        section: [
          [0, 0],
          [1, 0],
        ],
      },
      'section needs',
    ],
    [
      'flat section',
      {
        path: L_PATH,
        section: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
      },
      'no area',
    ],
    ['open sectionId', { path: L_PATH, sectionId: 'open' }, 'not closed'],
    ['missing sectionId', { path: L_PATH, sectionId: 'nope' }, 'no entity'],
    ['no path', { radius: 1 }, 'exactly one of path or pathId'],
    ['path and pathId', { path: L_PATH, pathId: 'open', radius: 1 }, 'exactly one of path'],
    [
      'bad path point',
      {
        path: [
          [0, 0, 0],
          [1, 1],
        ],
        radius: 1,
      },
      'path point 1',
    ],
    ['one point', { path: [[0, 0, 0]], radius: 0.1 }, 'path needs'],
    [
      'stations on a loop',
      {
        pathId: 'ring',
        stations: [
          { at: 0, radius: 0.1 },
          { at: 1, radius: 0.2 },
        ],
      },
      'stations need an open path',
    ],
    ['non-curve pathId', { pathId: 'label', radius: 0.1 }, 'not a 2D curve'],
    ['missing pathId', { pathId: 'nope', radius: 0.1 }, 'no entity'],
    [
      'U-turn',
      {
        path: [
          [0, 0, 0],
          [5, 0, 0],
          [0, 0, 0],
        ],
        radius: 0.1,
      },
      'doubles back',
    ],
    ['bend > run', { path: L_PATH, radius: 1, bendRadius: 20 }, 'too large'],
    ['bend too tight', { path: L_PATH, radius: 1, bendRadius: 0.5 }, 'not wider than the section'],
    ['bendRadius <= 0', { path: L_PATH, radius: 1, bendRadius: -1 }, 'bendRadius must be > 0'],
    [
      'pinched loop',
      {
        path: [
          [0, 0, 0],
          [5, 0, 0],
          [0, 0, 0.0000001],
        ],
        smooth: true,
        radius: 0.1,
      },
      'sharp corner',
    ],
  ])('%s', (_label, params, text) => {
    expectNoOp(execute(rect, 'sweep_profile', params), rect, text);
  });

  it('an arc path tighter than the section is rejected; a polyline path gets bends', () => {
    const doc = docWith({
      id: 'zig',
      kind: 'polyline',
      closed: false,
      points: [
        [0, 0],
        [4, 0],
        [4, 4],
      ],
    });
    const kink = docWith({
      id: 'kink',
      kind: 'arc',
      center: [0, 0],
      radius: 0.05,
      startAngle: 0,
      endAngle: Math.PI,
    });
    expectNoOp(execute(kink, 'sweep_profile', { pathId: 'kink', radius: 1 }), kink, 'not wider');
    expect(execute(doc, 'sweep_profile', { pathId: 'zig', radius: 0.2 }).affected).toHaveLength(1);
  });

  it('rejects a duplicate explicit id', () => {
    const first = execute(empty, 'sweep_profile', { path: L_PATH, radius: 1, id: 'p' }).document;
    expectNoOp(execute(first, 'sweep_profile', { path: L_PATH, radius: 1, id: 'p' }), first, 'already exists');
  });
});

describe('sweep entity across the kind dispatch', () => {
  const pipe = sweepOf(empty, {
    id: 'pipe',
    path: L_PATH,
    radius: 1,
    innerRadius: 0.5,
    bendRadius: 2,
  });
  const bar = sweepOf(empty, {
    id: 'bar',
    path: L_PATH,
    smooth: true,
    section: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  });

  it('tessellates watertight with outward winding (hollow and polygon sections)', () => {
    for (const solid of [pipe, bar]) {
      const triangles = solidTriangles(solid);
      expect(triangles.length).toBeGreaterThan(0);
      expect(isWatertight(triangles, 9)).toBe(true);
    }
    expect(tessellateEntity(pipe).length).toBe(solidTriangles(pipe).length);
  });

  it('rotation-minimizing frames stay orthonormal along the path', () => {
    for (const frame of sweepFrames(bar.path)) {
      const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, v, k) => sum + v * (b[k] ?? 0), 0);
      expect(dot(frame.normal, frame.tangent)).toBeCloseTo(0, 9);
      expect(dot(frame.binormal, frame.normal)).toBeCloseTo(0, 9);
      expect(dot(frame.normal, frame.normal)).toBeCloseTo(1, 9);
    }
    expect(sweepTriangles({ path: [], section: { shape: 'circle', radius: 1 } })).toEqual([]);
  });

  it('starts vertical paths with the section +y along world +Y', () => {
    const [first] = sweepFrames([
      {
        type: 'line',
        points: [
          [0, 0, 0],
          [0, 0, 5],
        ],
      },
    ]);
    expect(first?.binormal).toEqual([0, 1, 0]);
  });

  it('scale_entity scales path, radii and section curves', () => {
    const doc = { ...empty, entities: { [pipe.id]: pipe }, order: [pipe.id] };
    const scaled = execute(doc, 'scale_entity', { id: pipe.id, factor: 2 }).document.entities[pipe.id] as SweepEntity;
    expect(scaled.section).toEqual({ shape: 'circle', radius: 2, innerRadius: 1 });
    expect(scaled.path[2]?.points[1]).toEqual([20, 20, 0]);
    expect(volumeOf(scaled)).toBeCloseTo(volumeOf(pipe) * 8, 6);

    const sketched = sweepOf(docWith({ id: 'e', kind: 'ellipse', center: [0, 0], radiusX: 1, radiusY: 0.5 }), {
      path: L_PATH,
      sectionId: 'e',
    });
    const big = execute({ ...empty, entities: { [sketched.id]: sketched }, order: [sketched.id] }, 'scale_entity', {
      id: sketched.id,
      factor: 3,
    }).document.entities[sketched.id] as SweepEntity;
    expect(big.section.shape === 'profile' && big.section.curves?.[0]?.points[0]).toEqual([3, 0]);
  });

  it('round-trips through save → load and rejects a corrupt saved sweep', () => {
    const doc = {
      ...empty,
      entities: { [pipe.id]: pipe, [bar.id]: bar },
      order: [pipe.id, bar.id],
    };
    const loaded = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument(doc),
    });
    expect(loaded.document.entities[pipe.id]).toEqual(pipe);
    expect(loaded.document.entities[bar.id]).toEqual(bar);

    const corrupt = (patch: Record<string, unknown>): string =>
      serializeDocument({ ...doc, entities: { [pipe.id]: { ...pipe, ...patch } as Entity } });
    for (const patch of [
      { path: [] },
      { path: [{ type: 'line', points: [[0, 0]] }] },
      { section: null },
      { section: { shape: 'circle', radius: -1 } },
      { section: { shape: 'circle', radius: 1, innerRadius: 2 } },
      { section: { shape: 'profile', profile: [[0, 0]] } },
      {
        section: {
          shape: 'profile',
          profile: [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          curves: [{ type: 'arc', points: [] }],
        },
      },
    ]) {
      const result = execute(createEmptyDocument(), 'load_document', { json: corrupt(patch) });
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('sweep');
    }
  });

  it('check_model flags a degenerate round section', () => {
    const broken = { ...pipe, section: { shape: 'circle', radius: 0 } } as SweepEntity;
    const doc = { ...empty, entities: { [broken.id]: broken }, order: [broken.id] };
    const report = execute(doc, 'check_model', {}).data as { issues: Array<{ code: string }> };
    expect(report.issues.some((i) => i.code === 'degenerate_size')).toBe(true);
    const fine = { ...empty, entities: { [bar.id]: bar }, order: [bar.id] };
    const ok = execute(fine, 'check_model', {}).data as { issues: Array<{ code: string }> };
    expect(ok.issues.some((i) => i.code === 'degenerate_size')).toBe(false);
  });
});

describe('sweep review fixes', () => {
  it('rejects a smooth spline path that curls tighter than the section', () => {
    const params = {
      path: [
        [0, 0, 0],
        [10, 0, 0],
        [10.5, 0.5, 0],
        [0, 1, 0],
      ],
      smooth: true,
      radius: 2,
    };
    expectNoOp(execute(empty, 'sweep_profile', params), empty, 'spline curvature');
  });

  it('a corrupt saved path that is not connected is refused on load', () => {
    const pipe = sweepOf(empty, { path: L_PATH, radius: 1 });
    const broken = {
      ...pipe,
      path: [
        {
          type: 'line',
          points: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
        {
          type: 'line',
          points: [
            [2, 0, 0],
            [3, 0, 0],
          ],
        },
      ],
    } as unknown as Entity;
    const json = serializeDocument({ ...empty, entities: { [pipe.id]: broken }, order: [pipe.id] });
    const result = execute(createEmptyDocument(), 'load_document', { json });
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('path invalid');
  });

  it('per-segment outline rings follow the continuous frame', () => {
    const pipe = sweepOf(empty, { path: L_PATH, radius: 1, bendRadius: 2 });
    const rings = sweepSegmentRings(pipe);
    expect(rings).toHaveLength(3);
    expect(rings.every((ring) => ring.length > 0)).toBe(true);
  });
});

describe('closed-path sweeps', () => {
  it('a circle pathId makes a torus-like ring with no caps and the exact volume', () => {
    const doc = docWith({ id: 'ring', kind: 'circle', center: [0, 0], radius: 10 });
    const ring = sweepOf(doc, { pathId: 'ring', radius: 2 });
    const triangles = solidTriangles(ring);
    expect(isWatertight(triangles, 9)).toBe(true);
    expect(volumeOf(ring)).toBeCloseTo(2 * Math.PI * Math.PI * 10 * 4, 6);
  });

  it('closed: true bends the closing corner of a point loop (and smooth closes a spline)', () => {
    const square = [
      [0, 0, 0],
      [20, 0, 0],
      [20, 20, 0],
      [0, 20, 0],
    ];
    const frame = sweepOf(empty, { path: square, closed: true, radius: 1, bendRadius: 4 });
    expect(frame.path.filter((s) => s.type === 'arc')).toHaveLength(4);
    expect(isWatertight(solidTriangles(frame), 9)).toBe(true);
    const hose = sweepOf(empty, {
      path: square,
      closed: true,
      smooth: true,
      radius: 0.5,
      innerRadius: 0.3,
    });
    expect(hose.path.every((s) => s.type === 'bezier')).toBe(true);
    expect(isWatertight(solidTriangles(hose), 9)).toBe(true);
  });

  it('a rectangular profile section closes without a twist seam on a 3D loop', () => {
    const loop = sweepOf(empty, {
      path: [
        [0, 0, 0],
        [20, 0, 5],
        [20, 20, 0],
        [0, 20, 5],
      ],
      closed: true,
      smooth: true,
      section: [
        [-1, -0.3],
        [1, -0.3],
        [1, 0.3],
        [-1, 0.3],
      ],
    });
    expect(isWatertight(solidTriangles(loop), 9)).toBe(true);
  });

  it('closed rectangle and polyline sketches get bends at every corner', () => {
    const doc = docWith(
      { id: 'r', kind: 'rectangle', width: 30, height: 20 },
      {
        id: 'p',
        kind: 'polyline',
        closed: true,
        points: [
          [0, 0],
          [30, 0],
          [15, 25],
        ],
      },
    );
    expect(sweepOf(doc, { pathId: 'r', radius: 1 }).path.filter((s) => s.type === 'arc')).toHaveLength(4);
    expect(sweepOf(doc, { pathId: 'p', radius: 1 }).path.filter((s) => s.type === 'arc')).toHaveLength(3);
    expectNoOp(execute(doc, 'sweep_profile', { pathId: 'p', radius: 1, bendRadius: 40 }), doc, 'too large');
  });
});
