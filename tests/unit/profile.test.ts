import { describe, it, expect } from 'vitest';
import { createEmptyDocument, DEFAULT_LAYER_ID, type ExtrusionEntity, type RevolutionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { docWith } from '../helpers/fixtureDocument';
import { xy } from '../helpers/xy';

const TRI_POINTS = xy(0, 0, 10, 0, 5, 8);
const sketch = docWith(
  { id: 'circle', kind: 'circle', center: [0, 0], radius: 5, position: [1, 2, 0] },
  { id: 'rect', kind: 'rectangle', width: 4, height: 3 },
  { id: 'tri', kind: 'polyline', points: TRI_POINTS, closed: true },
  { id: 'open', kind: 'polyline', points: TRI_POINTS, closed: false },
  { id: 'line', kind: 'line', start: [0, 0], end: [5, 5] },
  { id: 'short', kind: 'polyline', points: xy(0, 0, 5, 0), closed: true },
);

describe('extrude_profile', () => {
  it.each<[string, number, (e: ExtrusionEntity) => void]>([
    [
      'circle',
      10,
      (e) => {
        expect(e.profile).toHaveLength(32);
        expect(e.position).toEqual([1, 2, 0]);
        for (const [x, y] of e.profile) expect(Math.hypot(x, y)).toBeCloseTo(5, 5);
      },
    ],
    ['rect', 3, (e) => expect(e.profile).toEqual(xy(0, 0, 4, 0, 4, 3, 0, 3))],
    ['tri', 7, (e) => expect(e.profile).toEqual(TRI_POINTS)],
  ])('extrudes the closed %s to depth %d, keeping the source, purely', (id, depth, check) => {
    const r = execute(sketch, 'extrude_profile', { id, depth });
    expect(r.affected).toHaveLength(1);
    const e = r.document.entities[r.affected[0]!] as ExtrusionEntity;
    expect(e).toMatchObject({ kind: 'extrusion', depth });
    expect(r.document.order).toContain(e.id);
    expect(r.document.entities[id]).toEqual(sketch.entities[id]);
    check(e);
    expectPure(sketch, () => execute(sketch, 'extrude_profile', { id, depth }));
  });

  it.each<[string, number, string?]>([
    ['nonexistent', 5, 'nonexistent'],
    ['circle', 0, 'depth'],
    ['circle', -1],
    ['line', 5, 'not a closed 2D profile'],
    ['open', 5, 'not closed'],
    ['short', 5, 'fewer than 3 points'],
  ])('%s at depth %d is a no-op', (id, depth, summary) => expectNoOp(execute(sketch, 'extrude_profile', { id, depth }), sketch, summary));
});

const TRI_PROFILE = xy(1, 0, 3, 0, 2, 2);
const revolve = (p: object): { r: ReturnType<typeof execute>; e: RevolutionEntity } => {
  const r = execute(createEmptyDocument(), 'revolve_profile', { profile: TRI_PROFILE, ...p });
  return { r, e: r.document.entities[r.affected[0]!] as RevolutionEntity };
};
const closeTo = (actual: readonly number[], expected: number[]): void => expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 5));

describe('revolve_profile', () => {
  it('a full revolution defaults to 32 segments about Z, purely, with a factual summary', () => {
    const { r, e } = revolve({});
    expect(r.affected).toHaveLength(1);
    expect(r.document.order).toEqual(r.affected);
    expect(e).toMatchObject({ kind: 'revolution', segments: 32, layerId: DEFAULT_LAYER_ID });
    expect(e.profile).toHaveLength(3);
    expect(e.angle).toBeCloseTo(2 * Math.PI, 5);
    closeTo(e.axis, [0, 0, 1]);
    expect(r.summary).toContain('AABB');
    const s = revolve({ axis: 'z', segments: 16 }).r;
    for (const t of [s.affected[0]!, 'z', '16']) expect(s.summary).toContain(t);
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'revolve_profile', { profile: TRI_PROFILE }));
  });

  it('honours angle, axis, segments clamp, placement, color and layer fallback', () => {
    expect(revolve({ angle: Math.PI }).e.angle).toBeCloseTo(Math.PI, 5);
    closeTo(revolve({ axis: 'x' }).e.axis, [1, 0, 0]);
    expect(revolve({ axis: 'y' }).e.axis[1]).toBeCloseTo(1, 5);
    expect(Math.hypot(...revolve({ axis: [1, 1, 0] }).e.axis)).toBeCloseTo(1, 5);
    expect(revolve({ segments: 1 }).e.segments).toBe(3);
    expect(revolve({ position: [5, 6, 7], color: '#ff0000' }).e).toMatchObject({ position: [5, 6, 7], color: '#ff0000' });
    for (const layerId of [DEFAULT_LAYER_ID, 'nonexistent-layer']) expect(revolve({ layerId }).e.layerId).toBe(DEFAULT_LAYER_ID);
  });

  it.each<[Record<string, unknown>, string?]>([
    [{ profile: xy(1, 0, 2, 1) }, 'at least 3'],
    [{ profile: [] }],
    [{ profile: 'bad' }],
    [{ angle: 0 }, 'angle'],
    [{ angle: -1 }],
    [{ angle: Infinity }],
    [{ axis: 'diagonal' }, 'axis'],
    [{ axis: [0, 0, 0] }],
    [{ axis: 42 }],
  ])('%j is a no-op', (p, summary) => {
    const doc = createEmptyDocument();
    expectNoOp(execute(doc, 'revolve_profile', { profile: TRI_PROFILE, ...p }), doc, summary);
  });
});
