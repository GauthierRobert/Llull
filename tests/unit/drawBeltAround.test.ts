import { describe, it, expect } from 'vitest';
import { type PolylineEntity, createEmptyDocument } from '@core/model/types';
import { execute, listCommands, toToolSchemas } from '@core/commands/registry';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

type Pulley = { center: [number, number]; radius: number };
const TWO_EQUAL: Pulley[] = [
  { center: [0, 0], radius: 5 },
  { center: [20, 0], radius: 5 },
];

const belt = (
  pulleys: Pulley[] = TWO_EQUAL,
  extra: Record<string, unknown> = {},
  doc = createEmptyDocument(),
): ReturnType<typeof execute> => execute(doc, 'draw_belt_around', { pulleys, ...extra });

const beltPoly = (result: ReturnType<typeof execute>): PolylineEntity => result.document.entities[result.affected[0]!] as PolylineEntity;

const triangle = (r: number, side: number): Pulley[] => [
  { center: [0, 0], radius: r },
  { center: [side, 0], radius: r },
  { center: [side / 2, (side * Math.sqrt(3)) / 2], radius: r },
];

describe('draw_belt_around', () => {
  it('2 equal-radius pulleys: creates one closed polyline entity', () => {
    const result = belt();
    expect(result.affected).toHaveLength(1);
    const entity = result.document.entities[result.affected[0]!]!;
    expect(entity.kind).toBe('polyline');
    expect((entity as PolylineEntity).closed).toBe(true);
  });
  it('2 equal-radius pulleys: tangent lines are horizontal at y=±5', () => {
    const yValues = beltPoly(belt(TWO_EQUAL, { arcSamples: 2 })).points.map(([, y]) => y);
    expect(yValues.some((y) => Math.abs(y - 5) < 1e-9)).toBe(true);
    expect(yValues.some((y) => Math.abs(y + 5) < 1e-9)).toBe(true);
  });
  it('2 equal-radius pulleys: each pulley contributes a 180° wrap arc', () => {
    // Total polyline points: 2 tangent-start pts + 2 arcs × 36 points each = 74
    expect(beltPoly(belt(TWO_EQUAL, { arcSamples: 36 })).points).toHaveLength(74);
  });
  it('2 different-radius pulleys: first polyline point is the outgoing TP on pulley 0', () => {
    const [r1, r2, cx2, cy2, d] = [5, 3, 20, 0, 20];
    const expectedAngle = 0 + Math.PI / 2 + Math.asin((r1 - r2) / d);
    const pts = beltPoly(
      belt(
        [
          { center: [0, 0], radius: r1 },
          { center: [cx2, cy2], radius: r2 },
        ],
        { arcSamples: 2 },
      ),
    ).points;
    const tp1 = pts[0]!;
    expect(tp1[0]).toBeCloseTo(r1 * Math.cos(expectedAngle), 9);
    expect(tp1[1]).toBeCloseTo(r1 * Math.sin(expectedAngle), 9);
    // arcSamples=2 means 2 arc pts per pulley; pts indices for pulley-1 arc are 1 and 2.
    for (const pt of [pts[1]!, pts[2]!]) {
      expect(Math.sqrt((pt[0] - cx2) ** 2 + (pt[1] - cy2) ** 2)).toBeCloseTo(r2, 9);
    }
  });
  it('2 different-radius pulleys: summary reports a positive length', () => {
    const result = belt(
      [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 3 },
      ],
      { arcSamples: 2 },
    );
    expect(result.summary).toContain('belt');
    expect(result.summary).toMatch(/length ≈ \d/);
  });
  it('3-pulley equilateral: creates closed polyline with 3 tangent segs + 3 arcs', () => {
    const result = belt(triangle(3, 30), { arcSamples: 12 });
    expect(result.affected).toHaveLength(1);
    // 3 pulleys, each contributing 1 tangent-start point + 12 arc samples = 3*(1+12) = 39 pts
    expect(beltPoly(result).points).toHaveLength(39);
    expect(beltPoly(result).closed).toBe(true);
  });
  it('3-pulley equilateral: total length ≈ 3 * tangentLen + full circumference of one pulley', () => {
    const result = belt(triangle(3, 30));
    // Equal radii: tangent length = side; wrap = 3 arcs of 120° = 2π*r.
    const expectedLength = 3 * 30 + 2 * Math.PI * 3;
    const match = result.summary.match(/length ≈ ([\d.]+)/);
    expect(match).not.toBeNull();
    expect(Math.abs(parseFloat(match![1]!) - expectedLength)).toBeLessThan(0.01);
  });
  it('default arcSamples=12: 2-pulley belt has 2*(1+12)=26 points', () => {
    expect(beltPoly(belt()).points).toHaveLength(26);
  });
  it('arcSamples=4: coarser but still closed polyline', () => {
    const poly = beltPoly(belt(TWO_EQUAL, { arcSamples: 4 }));
    expect(poly.points).toHaveLength(10); // 2*(1+4)
    expect(poly.closed).toBe(true);
  });
  it('position is stored on the entity', () => {
    expect(beltPoly(belt(TWO_EQUAL, { position: [10, 20, 5] })).position).toEqual([10, 20, 5]);
  });
  it('rotation is stored on the entity', () => {
    const entity = beltPoly(belt(TWO_EQUAL, { rotation: [0, 0, Math.PI / 4] }));
    expect(entity.rotation[2]).toBeCloseTo(Math.PI / 4, 9);
  });
  it('different positions produce distinct entity placements', () => {
    const pulleys: Pulley[] = [
      { center: [0, 0], radius: 4 },
      { center: [10, 0], radius: 4 },
    ];
    expect(beltPoly(belt(pulleys, { position: [100, 0, 0] })).position[0]).toBe(100);
    expect(beltPoly(belt(pulleys, { position: [0, 0, 0] })).position[0]).toBe(0);
  });
  it('summary contains entity id, pulley count, and length', () => {
    const result = belt();
    expect(result.summary).toContain(result.affected[0]!);
    expect(result.summary).toContain('2 pulleys');
    expect(result.summary).toMatch(/length ≈/);
    expect(result.summary).toMatch(/bounds/);
  });
  // Failure paths: unchanged doc, affected:[]
  const p = (cx: number, cy: number, radius: number): Pulley => ({ center: [cx, cy], radius });
  const failures: Array<[string, Pulley[], Record<string, unknown>, RegExp?]> = [
    ['pulleys.length < 2', [p(0, 0, 5)], {}, /at least 2/i],
    ['empty pulleys array', [], {}],
    ['pulley with non-positive radius', [p(0, 0, 0), p(20, 0, 5)], {}, /radius/i],
    ['negative radius', [p(0, 0, -3), p(20, 0, 5)], {}],
    ['coincident centers', [p(5, 5, 2), p(5, 5, 3)], {}, /coincident/i],
    // d=3, r1=10, r2=1 → |r1-r2|=9 > d=3
    ['pulley-inside-pulley (d < |r1 - r2|)', [p(0, 0, 10), p(3, 0, 1)], {}, /inside|tangent/i],
    ['non-finite center coordinate', [p(NaN, 0, 5), p(20, 0, 5)], {}, /non-finite/i],
    ['Infinity in center', [p(0, Infinity, 5), p(20, 0, 5)], {}],
    ['NaN radius', [p(0, 0, NaN), p(20, 0, 5)], {}],
    ['arcSamples < 2', TWO_EQUAL, { arcSamples: 1 }, /arcSamples/i],
    ['arcSamples=NaN', TWO_EQUAL, { arcSamples: NaN }],
  ];
  it.each(failures)('%s -> no-op, affected:[]', (_label, pulleys, extra, summaryRe) => {
    const doc = createEmptyDocument();
    const result = belt(pulleys, extra, doc);
    expectNoOp(result, doc);
    if (summaryRe) expect(result.summary).toMatch(summaryRe);
  });
  it('is pure — happy path does not mutate input doc', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => belt(TWO_EQUAL, {}, doc));
  });
  it('is pure — failure path does not mutate input doc', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => belt([p(0, 0, 5)], {}, doc));
  });
  it('toToolSchemas().length === listCommands().length', () => {
    expect(toToolSchemas().length).toBe(listCommands().length);
  });
  it('draw_belt_around is registered in listCommands', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('draw_belt_around');
  });
});
