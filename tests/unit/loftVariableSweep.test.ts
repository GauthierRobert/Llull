import { describe, it, expect } from 'vitest';
import { type Entity, type LoftEntity, type SweepEntity, type Vec2, type Vec3, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { entityBounds } from '@core/geometry/bounds';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { tessellateEntity } from '@core/commands/render/polygons';
import { SECTION_RING_POINTS, alignRing, resampleRing, sampleRing } from '@core/geometry/sectionRing';
import { skinTriangles } from '@core/geometry/skin';
import { loftRings } from '@core/geometry/loft';
import { frameAtFraction, stationRingAt } from '@core/geometry/sweep';
import { expectNoOp } from '../helpers/expectNoOp';
import { docWith, createdEntity as created, volumeOf, isWatertight } from '../helpers/fixtureDocument';

const empty = createEmptyDocument();

const square: Vec2[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

describe('section rings', () => {
  it('resample to a fixed count, counter-clockwise, starting on the +x side', () => {
    const ring = resampleRing([...square].reverse());
    expect(ring).toHaveLength(SECTION_RING_POINTS);
    expect(ring[0]?.[0]).toBeCloseTo(1, 9);
    expect(ring[0]?.[1]).toBeCloseTo(0, 9);
    expect(ring[1]?.[1]).toBeGreaterThan(0);
  });

  it('align cyclically to the closest start and sample to a fixed density', () => {
    const ring = resampleRing(square);
    const shifted = [...ring.slice(5), ...ring.slice(0, 5)];
    expect(alignRing(shifted, ring)).toEqual(ring);
    expect(sampleRing(ring)).toHaveLength(SECTION_RING_POINTS * 4);
  });
});

describe('skin', () => {
  it('builds a closed outward solid and rejects malformed ring sets', () => {
    const ring = (z: number): Vec3[] => resampleRing(square).map(([x, y]) => [x, y, z]);
    const triangles = skinTriangles([ring(0), ring(2)]);
    expect(isWatertight(triangles)).toBe(true);
    expect(skinTriangles([ring(0)])).toEqual([]);
    expect(skinTriangles([ring(0), ring(1).slice(1)])).toEqual([]);
  });
});

describe('loft_sections', () => {
  const twoCircles = {
    sections: [
      { center: [0, 0, 0], radius: 1 },
      { center: [0, 0, 4], radius: 2 },
    ],
    ruled: true,
  };

  it('a ruled loft of two circles approximates the frustum volume', () => {
    const cone = created<LoftEntity>(empty, 'loft_sections', twoCircles);
    expect(cone.kind).toBe('loft');
    expect(cone.ruled).toBe(true);
    expect(cone.rings).toHaveLength(2);
    cone.position.forEach((c) => expect(c).toBeCloseTo(0, 9));
    expect(volumeOf(cone) / ((Math.PI * 4 * 7) / 3)).toBeCloseTo(1, 1);
    expect(isWatertight(solidTriangles(cone))).toBe(true);
    const b = entityBounds(cone);
    expect(b.max[2] - b.min[2]).toBeCloseTo(4, 6);
  });

  it('a smooth loft blends through three tilted sections without twisting', () => {
    const duct = created<LoftEntity>(empty, 'loft_sections', {
      sections: [
        { center: [0, 0, 0], radius: 1 },
        { center: [0, 0, 3], section: square },
        { center: [1, 0, 6], radiusX: 2, radiusY: 0.5, rotation: [0, 0.3, 0] },
      ],
      color: '#123456',
    });
    expect(duct.ruled).toBe(false);
    expect(loftRings(duct).length).toBeGreaterThan(3);
    expect(isWatertight(solidTriangles(duct))).toBe(true);
    expect(tessellateEntity(duct).length).toBe(solidTriangles(duct).length);
  });

  it('lofts sketched sections placed by their own work planes (reversed winding is fixed)', () => {
    const doc = docWith(
      { id: 'base', kind: 'circle', center: [0, 0], radius: 2 },
      {
        id: 'top',
        kind: 'polyline',
        closed: true,
        points: [...square].reverse(),
        position: [0, 0, 5],
      },
    );
    const body = created<LoftEntity>(doc, 'loft_sections', { sectionIds: ['base', 'top'] });
    expect(isWatertight(solidTriangles(body))).toBe(true);
    expect(volumeOf(body)).toBeGreaterThan(0);
  });

  it.each([
    ['neither', {}, 'exactly one of sectionIds or sections'],
    ['both', { sectionIds: ['a', 'b'], sections: twoCircles.sections }, 'exactly one'],
    ['one section', { sections: [{ center: [0, 0, 0], radius: 1 }] }, '2..200'],
    [
      'same centre',
      {
        sections: [
          { center: [0, 0, 0], radius: 1 },
          { center: [0, 0, 0], radius: 2 },
        ],
      },
      'same centre',
    ],
    ['bad spec', { sections: [{ center: [0, 0, 0], radius: 1 }, { center: [0, 0, 1] }] }, 'section 1: give exactly one'],
    ['missing sketch', { sectionIds: ['nope', 'nope2'] }, 'section 0: no entity'],
    [
      'half an ellipse',
      {
        sections: [
          { center: [0, 0, 0], radiusX: 1 },
          { center: [0, 0, 1], radius: 1 },
        ],
      },
      'radii must be > 0',
    ],
    [
      'bad polygon point',
      {
        sections: [
          { center: [0, 0, 0], section: [[0, 0], [1], [0, 1]] },
          { center: [0, 0, 1], radius: 1 },
        ],
      },
      'section point 1',
    ],
    [
      'short polygon',
      {
        sections: [
          {
            center: [0, 0, 0],
            section: [
              [0, 0],
              [1, 0],
            ],
          },
          { center: [0, 0, 1], radius: 1 },
        ],
      },
      'section needs',
    ],
    [
      'flat polygon',
      {
        sections: [
          {
            center: [0, 0, 0],
            section: [
              [0, 0],
              [1, 0],
              [2, 0],
            ],
          },
          { center: [0, 0, 1], radius: 1 },
        ],
      },
      'no area',
    ],
    [
      'missing section sketch',
      {
        sections: [
          { center: [0, 0, 0], sectionId: 'nope' },
          { center: [0, 0, 1], radius: 1 },
        ],
      },
      'no entity',
    ],
  ])('%s → no-op', (_label, params, text) => {
    expectNoOp(execute(empty, 'loft_sections', params), empty, text);
  });

  it('rejects a duplicate explicit id and is pure', () => {
    const first = execute(empty, 'loft_sections', { ...twoCircles, id: 'L' }).document;
    expectNoOp(execute(first, 'loft_sections', { ...twoCircles, id: 'L' }), first, 'already exists');
    const snapshot = JSON.stringify(first);
    execute(first, 'loft_sections', twoCircles);
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it('scales, round-trips and refuses corrupt saved lofts', () => {
    const cone = created<LoftEntity>(empty, 'loft_sections', twoCircles);
    const doc = { ...empty, entities: { [cone.id]: cone }, order: [cone.id] };
    const big = execute(doc, 'scale_entity', { id: cone.id, factor: 2 }).document.entities[cone.id] as LoftEntity;
    expect(big.rings[1]?.[0]?.[2]).toBeCloseTo(8, 9);
    const loaded = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument(doc),
    });
    expect(loaded.document.entities[cone.id]).toEqual(cone);
    for (const patch of [{ rings: [[[0, 0, 0]]] }, { ruled: 'yes' }]) {
      const json = serializeDocument({
        ...doc,
        entities: { [cone.id]: { ...cone, ...patch } as unknown as Entity },
      });
      const result = execute(createEmptyDocument(), 'load_document', { json });
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('loft');
    }
  });
});

describe('sweep_profile stations (variable section)', () => {
  const path = [
    [0, 0, 0],
    [10, 0, 0],
  ];

  it('tapers between stations with a smoothstep blend', () => {
    const tube = created<SweepEntity>(empty, 'sweep_profile', {
      path,
      stations: [
        { at: 0, radius: 2 },
        { at: 1, radius: 1 },
      ],
    });
    expect(tube.stations).toHaveLength(2);
    expect(tube.section.shape).toBe('profile');
    const mid = stationRingAt(tube.stations ?? [], 0.5);
    expect(Math.hypot(...(mid[0] as Vec2))).toBeCloseTo(1.5, 6);
    // ∫ π r(t)² over a smoothstep taper from 2 to 1 along 10 units.
    const expected = (() => {
      let sum = 0;
      for (let k = 0; k < 1000; k++) {
        const u = (k + 0.5) / 1000;
        const r = 2 - u * u * (3 - 2 * u);
        sum += Math.PI * r * r * 0.01;
      }
      return sum;
    })();
    expect(volumeOf(tube) / expected).toBeCloseTo(1, 1);
    expect(isWatertight(solidTriangles(tube))).toBe(true);
  });

  it('blends round → oval → sketched rectangle along a bent path and scales stations', () => {
    const doc = docWith({
      id: 'rect',
      kind: 'rectangle',
      width: 2,
      height: 1,
      position: [9, 9, 0],
    });
    const tube = created<SweepEntity>(doc, 'sweep_profile', {
      path: [
        [0, 0, 0],
        [20, 0, 0],
        [20, 0, 15],
      ],
      bendRadius: 6,
      stations: [
        { at: 0, radius: 1.5 },
        { at: 0.5, radiusX: 1, radiusY: 2 },
        { at: 1, sectionId: 'rect' },
      ],
    });
    expect(isWatertight(solidTriangles(tube))).toBe(true);
    const frame = frameAtFraction(tube.path, 0);
    expect(frame.point).toEqual([0, 0, 0]);
    const scaled = execute({ ...empty, entities: { [tube.id]: tube }, order: [tube.id] }, 'scale_entity', { id: tube.id, factor: 2 })
      .document.entities[tube.id] as SweepEntity;
    expect(Math.hypot(...((scaled.stations?.[0]?.ring[0] ?? [0, 0]) as Vec2))).toBeCloseTo(3, 6);
  });

  it.each([
    ['one station', { stations: [{ at: 0, radius: 1 }] }, '>= 2'],
    [
      'out of range',
      {
        stations: [
          { at: 0, radius: 1 },
          { at: 1.5, radius: 1 },
        ],
      },
      'must be in [0, 1]',
    ],
    [
      'not increasing',
      {
        stations: [
          { at: 0, radius: 1 },
          { at: 0.5, radius: 1 },
          { at: 0.5, radius: 1 },
        ],
      },
      'greater than the previous',
    ],
    [
      'not spanning',
      {
        stations: [
          { at: 0.1, radius: 1 },
          { at: 1, radius: 1 },
        ],
      },
      'first station must be at 0',
    ],
    [
      'bad spec',
      {
        stations: [
          { at: 0, radius: 1 },
          { at: 1, radius: -1 },
        ],
      },
      'station 1',
    ],
    [
      'mixed with radius',
      {
        radius: 1,
        stations: [
          { at: 0, radius: 1 },
          { at: 1, radius: 1 },
        ],
      },
      'inside its station',
    ],
  ])('%s → no-op', (_label, params, text) => {
    expectNoOp(execute(empty, 'sweep_profile', { path, ...params }), empty, text);
  });

  it('round-trips and refuses corrupt saved stations', () => {
    const tube = created<SweepEntity>(empty, 'sweep_profile', {
      path,
      stations: [
        { at: 0, radius: 2 },
        { at: 1, radius: 1 },
      ],
    });
    const doc = { ...empty, entities: { [tube.id]: tube }, order: [tube.id] };
    expect(execute(createEmptyDocument(), 'load_document', { json: serializeDocument(doc) }).document.entities[tube.id]).toEqual(tube);
    for (const stations of [
      'nope',
      [
        { at: 0.2, ring: tube.stations?.[0]?.ring },
        { at: 1, ring: tube.stations?.[1]?.ring },
      ],
      [
        { at: 0, ring: [[0, 0]] },
        { at: 1, ring: [[0, 0]] },
      ],
    ]) {
      const json = serializeDocument({
        ...doc,
        entities: { [tube.id]: { ...tube, stations } as unknown as Entity },
      });
      expect(execute(createEmptyDocument(), 'load_document', { json }).affected).toHaveLength(0);
    }
  });
});
