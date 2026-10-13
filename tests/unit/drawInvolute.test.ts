import { describe, it, expect } from 'vitest';
import { type PolylineEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { sampleInvolute } from '@lib/gearOutline';
import { expectSingleEntity, expectNoOp, expectPure } from '../helpers/expectNoOp';

const doc = createEmptyDocument();
const involute = (p: object): { r: ReturnType<typeof execute>; poly: PolylineEntity } => {
  const r = execute(doc, 'draw_involute', p);
  return { r, poly: r.document.entities[r.affected[0]!] as PolylineEntity };
};

describe('draw_involute', () => {
  it('creates one open polyline of 24 default samples from (baseRadius, 0) to radius baseR·√(1+t²), purely', () => {
    const { r, poly } = involute({ baseRadius: 4, endAngle: Math.PI });
    expectSingleEntity(r, 'polyline');
    expect(poly.closed).toBe(false);
    expect(poly.points).toHaveLength(24);
    expect(poly.points[0]![0]).toBeCloseTo(4, 9);
    expect(poly.points[0]![1]).toBeCloseTo(0, 9);
    const last = poly.points.at(-1)!;
    expect(Math.abs(Math.hypot(last[0], last[1]) - 4 * Math.sqrt(1 + Math.PI ** 2))).toBeLessThan(1e-9);
    expectPure(doc, () => [
      execute(doc, 'draw_involute', { baseRadius: 4, endAngle: Math.PI }),
      execute(doc, 'draw_involute', { baseRadius: -1, endAngle: 1 }),
    ]);
  });

  it('shares sampleInvolute with add_spur_gear: the flank reaches the gear outer radius', () => {
    const [pitch, base] = [42, 42 * Math.cos(Math.PI / 9)];
    const last = sampleInvolute(base, 0, Math.sqrt(((pitch + 2) / base) ** 2 - 1), 14).at(-1)!;
    expect(Math.abs(Math.hypot(last[0], last[1]) - (pitch + 2))).toBeLessThan(1e-9);
  });

  it('honours samples, startAngle default, placement and reports the sweep', () => {
    expect(involute({ baseRadius: 3, endAngle: 2, samples: 10 }).poly.points).toHaveLength(10);
    expect(involute({ baseRadius: 5, endAngle: 1, samples: 2 }).poly.points).toHaveLength(2);
    const p1 = involute({ baseRadius: 4, endAngle: 2 }).poly.points;
    const p2 = involute({ baseRadius: 4, startAngle: 0, endAngle: 2 }).poly.points;
    expect(p1.length).toBe(p2.length);
    p1.forEach((p, i) => p.forEach((v, k) => expect(v).toBeCloseTo(p2[i]![k]!, 12)));
    const placed = involute({ baseRadius: 3, endAngle: 1, position: [5, -2, 7], rotation: [0, 0, Math.PI] }).poly;
    expect(placed.position).toEqual([5, -2, 7]);
    expect(placed.rotation[2]).toBeCloseTo(Math.PI, 9);
    expect(involute({ baseRadius: 3, endAngle: 1, position: [10, 0, 0] }).poly.position[0]).toBe(10);
    const { r } = involute({ baseRadius: 4, startAngle: 0.5, endAngle: 2.5, samples: 12 });
    for (const s of [r.affected[0]!, '4', '0.5', '2.5', '12']) expect(r.summary).toContain(s);
  });

  it.each<[object, RegExp?]>([
    [{ baseRadius: 0, endAngle: 1 }, /baseRadius/i],
    [{ baseRadius: -3, endAngle: 1 }],
    [{ baseRadius: 4, endAngle: 1, samples: 1 }, /samples/i],
    [{ baseRadius: 4, startAngle: 2, endAngle: 1 }, /endAngle/i],
    [{ baseRadius: 4, startAngle: 1, endAngle: 1 }],
    [{ baseRadius: NaN, endAngle: 1 }],
    [{ baseRadius: 4, endAngle: Infinity }],
    [{ baseRadius: 4, startAngle: NaN, endAngle: 1 }],
    [{ baseRadius: 4, endAngle: 1, samples: NaN }],
  ])('%j is a no-op', (p, summary) => {
    const r = execute(doc, 'draw_involute', p);
    expectNoOp(r, doc);
    if (summary) expect(r.summary).toMatch(summary);
  });
});
