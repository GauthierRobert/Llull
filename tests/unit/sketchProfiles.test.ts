import { describe, it, expect } from 'vitest';
import { type Entity, type ExtrusionEntity, type RevolutionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { entityCurves } from '@core/geometry/entityCurves';
import { segmentPoint } from '@core/geometry/curveSegments';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { docWith, createdEntity as created } from '../helpers/fixtureDocument';
import { xy } from '../helpers/xy';

const empty = createEmptyDocument();

/** Half bell-nozzle contour: a spline wall closed by straight lines to/along the axis. */
const NOZZLE = docWith(
  { id: 'wall', kind: 'spline', closed: false, points: xy(3, 0, 1.5, 3, 4, 7, 6, 10) },
  { id: 'lip', kind: 'line', start: [6, 10], end: [5.5, 10] },
  { id: 'inner', kind: 'spline', closed: false, points: xy(5.5, 10, 3.6, 7, 1.2, 3, 2.5, 0) },
  { id: 'base', kind: 'line', start: [2.5, 0], end: [3, 0] },
);

describe('revolve_profile with profileIds', () => {
  it('revolves a closed spline + line loop and keeps its exact curves', () => {
    const result = execute(NOZZLE, 'revolve_profile', { profileIds: ['inner', 'wall', 'base', 'lip'] });
    expect(result.affected).toHaveLength(1);
    const bell = result.document.entities[result.affected[0] as string] as RevolutionEntity;
    expect(bell.curves?.map((s) => s.type).sort()).toEqual(['bezier', 'bezier', 'bezier', 'bezier', 'bezier', 'bezier', 'line', 'line']);
    expect(bell.profile.length).toBeGreaterThan(50);
    expect(result.summary).toContain('6 exact curve segment(s)');
    // Profile polygon samples lie on the exact curves (same chain, same parameterisation).
    const first = bell.curves?.[0];
    expect(first).toBeDefined();
    const start = segmentPoint(first as NonNullable<typeof first>, 0);
    expect(bell.profile.some(([x, y]) => Math.hypot(x - start[0], y - start[1]) < 1e-9)).toBe(true);
  });
  it('reads sketch-plane coordinates, including a sketch drawn away from the origin', () => {
    const doc = docWith({ id: 'c', kind: 'circle', center: [0, 0], radius: 1, position: [5, 2, 0] });
    const torus = created<RevolutionEntity>(doc, 'revolve_profile', { profileIds: ['c'] });
    const xs = torus.profile.map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(4, 9);
    expect(Math.max(...xs)).toBeCloseTo(6, 9);
    const volume = (
      execute({ ...empty, entities: { [torus.id]: torus }, order: [torus.id] }, 'mass_properties', { entityId: torus.id }).data as {
        volume: number;
      }
    ).volume;
    expect(volume / (2 * Math.PI * Math.PI * 5)).toBeCloseTo(1, 1);
  });
  it('a pure polygon loop stores no curves', () => {
    const doc = docWith({ id: 'r', kind: 'rectangle', width: 2, height: 3, position: [1, 0, 0] });
    const ring = created<RevolutionEntity>(doc, 'revolve_profile', { profileIds: ['r'] });
    expect(ring.curves).toBeUndefined();
    expect(ring.profile[0]).toEqual([1, 0]);
  });
  it.each([
    ['both profile and profileIds', { profile: xy(0, 0, 1, 0, 0, 1), profileIds: ['wall'] }, 'not both'],
    ['missing id', { profileIds: ['nope'] }, 'no entity "nope"'],
    ['empty ids', { profileIds: [] }, 'no profile ids'],
    ['open loop', { profileIds: ['wall', 'lip'] }, 'not closed'],
    ['gap', { profileIds: ['wall', 'base'] }, 'do not join'],
  ])('%s → no-op', (_label, params, text) => {
    expectNoOp(execute(NOZZLE, 'revolve_profile', params), NOZZLE, text);
  });
  it('is pure', () => {
    expectPure(NOZZLE, () => execute(NOZZLE, 'revolve_profile', { profileIds: ['wall', 'lip', 'inner', 'base'] }));
  });
});

describe('extrude_profile with curved sketches', () => {
  it.each([
    ['circle', { kind: 'circle', center: [0, 0], radius: 2 }, 2],
    ['ellipse', { kind: 'ellipse', center: [0, 0], radiusX: 3, radiusY: 1 }, 4],
    ['closed spline', { kind: 'spline', closed: true, points: xy(0, 0, 4, 0, 2, 3) }, 3],
  ])('%s keeps %#: exact curves', (_label, shape, count) => {
    const doc = docWith({ id: 's', ...shape });
    const ext = created<ExtrusionEntity>(doc, 'extrude_profile', { id: 's', depth: 2 });
    expect(ext.curves).toHaveLength(count);
  });
  it('joins open pieces given in any order and direction into one loop (D shape)', () => {
    const doc = docWith(
      { id: 'arc', kind: 'arc', center: [0, 0], radius: 2, startAngle: -Math.PI / 2, endAngle: Math.PI / 2 },
      { id: 'flat', kind: 'line', start: [0, -2], end: [0, 2] },
    );
    const result = execute(doc, 'extrude_profile', { ids: ['flat', 'arc'], depth: 1 });
    const ext = result.document.entities[result.affected[0] as string] as ExtrusionEntity;
    expect(ext.curves?.map((s) => s.type)).toEqual(['line', 'arc']);
    expect(result.summary).toContain('[flat, arc]');
    const volume = (execute(result.document, 'mass_properties', { entityId: ext.id }).data as { volume: number }).volume;
    expect(volume).toBeCloseTo(2 * Math.PI, 1);
  });
  it('pieces in a shifted (but same) plane are offset into the first piece frame', () => {
    const doc = docWith(
      { id: 'a', kind: 'line', start: [0, 0], end: [4, 0], position: [10, 0, 1] },
      { id: 'b', kind: 'polyline', closed: false, points: xy(0, 0, 0, 3, -4, 0), position: [14, 0, 1] },
    );
    const ext = created<ExtrusionEntity>(doc, 'extrude_profile', { ids: ['a', 'b'], depth: 1 });
    expect(ext.position).toEqual([10, 0, 1]);
    expect(ext.curves).toBeUndefined();
    expect(ext.profile).toEqual(xy(0, 0, 4, 0, 4, 3));
  });
  it.each([
    ['neither profile, id nor ids', { depth: 1 }, 'give profile'],
    ['open spline', { id: 'open', depth: 1 }, 'not closed'],
    ['different rotation', { ids: ['a', 'tilted'], depth: 1 }, 'different rotation'],
    ['off-plane piece', { ids: ['a', 'lifted'], depth: 1 }, 'off the plane'],
    ['non-curve piece', { ids: ['a', 'note'], depth: 1 }, 'not a 2D curve'],
    ['missing piece', { ids: ['a', 'nope'], depth: 1 }, 'no entity "nope"'],
    ['point source', { id: 'pt', depth: 1 }, 'not a closed 2D profile'],
  ])('%s → no-op', (_label, params, text) => {
    const doc = docWith(
      { id: 'open', kind: 'spline', closed: false, points: xy(0, 0, 1, 1, 2, 0) },
      { id: 'a', kind: 'line', start: [0, 0], end: [1, 0] },
      { id: 'tilted', kind: 'line', start: [1, 0], end: [0, 1], rotation: [0.3, 0, 0] },
      { id: 'lifted', kind: 'line', start: [1, 0], end: [0, 1], position: [0, 0, 2] },
      { id: 'note', kind: 'text', content: 'x', height: 1 },
      { id: 'pt', kind: 'point' },
    );
    expectNoOp(execute(doc, 'extrude_profile', params), doc, text);
  });
  it('a closed polyline that repeats its first point still extrudes', () => {
    const doc = docWith({ id: 'p', kind: 'polyline', closed: true, points: xy(0, 0, 2, 0, 2, 2, 0, 0) });
    const ext = created<ExtrusionEntity>(doc, 'extrude_profile', { id: 'p', depth: 1 });
    expect(ext.profile).toHaveLength(3);
  });
});

describe('exact curves survive edits and persistence', () => {
  const doc = docWith({ id: 'c', kind: 'circle', center: [0, 0], radius: 2 });
  const ext = created<ExtrusionEntity>(doc, 'extrude_profile', { id: 'c', depth: 2 });
  const withExt = { ...empty, entities: { [ext.id]: ext }, order: [ext.id] };
  it('scale_entity scales the polygon and its curves together', () => {
    const scaled = execute(withExt, 'scale_entity', { id: ext.id, factor: 2 }).document.entities[ext.id] as ExtrusionEntity;
    expect(scaled.curves?.[0]?.points[0]).toEqual([4, 0]);
    expect(scaled.profile[0]?.[0]).toBeCloseTo(4, 9);
    const rev = created<RevolutionEntity>(
      docWith({ id: 'c', kind: 'circle', center: [0, 0], radius: 1, position: [3, 0, 0] }),
      'revolve_profile',
      { profileIds: ['c'] },
    );
    const bigger = execute({ ...empty, entities: { [rev.id]: rev }, order: [rev.id] }, 'scale_entity', { id: rev.id, factor: 2 }).document
      .entities[rev.id] as RevolutionEntity;
    expect(bigger.curves?.[0]?.points[0]).toEqual([8, 0]);
  });
  it('round-trips through save → load; corrupt curves are rejected', () => {
    const loaded = execute(createEmptyDocument(), 'load_document', { json: serializeDocument(withExt) });
    expect(loaded.document.entities[ext.id]).toEqual(ext);
    for (const kind of ['extrusion', 'revolution'] as const) {
      const broken = {
        ...ext,
        kind,
        segments: 8,
        axis: [0, 1, 0],
        angle: 1,
        curves: [{ type: 'bezier', points: [[0, 0]] }],
      } as unknown as Entity;
      const result = execute(createEmptyDocument(), 'load_document', {
        json: serializeDocument({ ...withExt, entities: { [ext.id]: broken } }),
      });
      expect(result.affected).toHaveLength(0);
      expect(result.summary).toContain('curves must be');
    }
  });
  it('entityCurves has no curve for non-sketch kinds and an empty one-point spline', () => {
    expect(entityCurves(ext)).toBeNull();
    const lonely = docWith({ id: 'sp', kind: 'spline', closed: false, points: [[0, 0]] }).entities['sp'];
    expect(entityCurves(lonely as Entity)?.curves).toEqual([]);
  });
});

describe('sketch loop review fixes', () => {
  it('extrude_profile refuses id and ids together', () => {
    const doc = docWith({ id: 'c', kind: 'circle', center: [0, 0], radius: 1 });
    expectNoOp(execute(doc, 'extrude_profile', { id: 'c', ids: ['c'], depth: 1 }), doc, 'not both');
  });
  it('snaps near-coincident joints so the exact chain is watertight', () => {
    const doc = docWith(
      { id: 'a', kind: 'line', start: [0, 0], end: [4, 0] },
      { id: 'b', kind: 'line', start: [4.0000005, 0], end: [0, 3] },
      { id: 'c', kind: 'arc', center: [0, 1.5], radius: 1.5, startAngle: Math.PI / 2, endAngle: (3 * Math.PI) / 2 + 1e-7 },
    );
    const ext = created<ExtrusionEntity>(doc, 'extrude_profile', { ids: ['a', 'b', 'c'], depth: 1 });
    const curves = ext.curves ?? [];
    curves.forEach((segment, i) => {
      const next = curves[(i + 1) % curves.length];
      expect(next?.points[0]).toEqual(segment.points[segment.points.length - 1]);
    });
  });
  it('a saved profile whose curves do not close is refused', () => {
    const doc = docWith({ id: 'c', kind: 'circle', center: [0, 0], radius: 1 });
    const ext = created<ExtrusionEntity>(doc, 'extrude_profile', { id: 'c', depth: 1 });
    const broken = { ...ext, curves: ext.curves?.slice(0, 1) } as Entity;
    const result = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument({ ...empty, entities: { [ext.id]: broken }, order: [ext.id] }),
    });
    expect(result.affected).toHaveLength(0);
    expect(result.summary).toContain('closed loop');
  });
});
