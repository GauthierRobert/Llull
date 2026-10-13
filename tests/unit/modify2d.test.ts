import { describe, it, expect } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { cross2, dot2, len2, normalize2, perp2, lerp2 as evalLine } from '@lib/vec2';
import { offsetSegment, miterJoin } from '@core/commands/modify2d/geometry';
import { lineIntersectionParams as segIntersect } from '@lib/polygon';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { build, pline } from '../helpers/addEntity';
import { xy } from '../helpers/xy';

type Loose = Record<string, unknown> & { position: number[] };
const ent = (doc: CadDocument, id: string): Loose => doc.entities[id] as unknown as Loose;
const close = (actual: unknown, expected: number[]): void => expected.forEach((v, i) => expect((actual as number[])[i]).toBeCloseTo(v));

describe('geometry helpers', () => {
  it('cross2 / dot2 / len2 / normalize2 / perp2 / evalLine', () => {
    expect(cross2([1, 0], [0, 1])).toBeCloseTo(1);
    expect(cross2([0, 1], [1, 0])).toBeCloseTo(-1);
    expect(cross2([2, 0], [4, 0])).toBeCloseTo(0);
    expect(dot2([3, 4], [1, 2])).toBeCloseTo(11);
    expect(dot2([1, 0], [0, 1])).toBeCloseTo(0);
    expect([len2([3, 4]), len2([1, 0]), len2([0, 1])]).toEqual([5, 1, 1]);
    close(normalize2([3, 4]), [0.6, 0.8]);
    expect(normalize2([0, 0])).toEqual([0, 0]);
    close(perp2([1, 0]), [0, 1]);
    expect(dot2([3, 4], perp2([3, 4]))).toBeCloseTo(0);
    close(evalLine([1, 2], [4, 6], 0), [1, 2]);
    close(evalLine([1, 2], [4, 6], 1), [4, 6]);
    close(evalLine([0, 0], [4, 4], 0.5), [2, 2]);
  });

  it.each<[number[][], { t: number; u: number } | null]>([
    [xy(-1, 0, 1, 0, 0, -1, 0, 1), { t: 0.5, u: 0.5 }],
    [xy(0, 0, 1, 0, 0, 1, 1, 1), null],
    [xy(0, 0, 2, 0, 1, 0, 3, 0), null],
    [xy(0, 0, 2, 0, 1, 1, 1, 2), { t: 0.5, u: -1 }],
    [xy(0, 0, 2, 2, 2, 0, 0, 2), { t: 0.5, u: 0.5 }],
  ])('segIntersect %j', (pts, hit) => {
    const r = segIntersect(...(pts as [[number, number], [number, number], [number, number], [number, number]]));
    if (!hit) return expect(r).toBeNull();
    expect(r!.t).toBeCloseTo(hit.t);
    expect(r!.u).toBeCloseTo(hit.u);
  });

  it('offsetSegment shifts left for +d, right for -d, by |d|; miterJoin intersects or falls back to a1', () => {
    const [oa, ob] = offsetSegment([0, 0], [2, 0], 1);
    close([...oa, ...ob], [0, 1, 2, 1]);
    const [na, nb] = offsetSegment([0, 0], [2, 0], -1);
    close([na[1], nb[1]], [-1, -1]);
    const [da, db] = offsetSegment([0, 0], [3, 4], 2);
    close([...da, ...db], [-1.6, 1.2, 3 - 1.6, 4 + 1.2]);
    close(miterJoin([0, 1], [2, 1], [1, 0], [1, 2]), [1, 1]);
    close(miterJoin([0, 0], [1, 0], [0, 1], [1, 1]), [1, 0]);
  });
});

describe('2D modify commands', () => {
  it('all modify commands are pure', () => {
    const {
      doc,
      ids: [poly, a, b],
    } = build(pline([0, 0, 4, 0, 4, 4, 0, 4]), pline([0, 0, 10, 0]), pline([5, -5, 5, 5]));
    for (const [name, p] of [
      ['explode_polyline', { id: poly }],
      ['offset_2d', { id: poly, distance: 1 }],
      ['trim', { id: a, boundaryId: b }],
      ['extend', { id: a, boundaryId: b }],
      ['fillet_2d', { id: poly, radius: 0.5, vertexIndex: 1 }],
      ['chamfer_2d', { id: poly, distance: 0.5, vertexIndex: 1 }],
    ] as const)
      expectPure(doc, () => execute(doc, name, p));
  });

  it.each<[string, Array<readonly [string, unknown]>, (ids: string[]) => object, string?]>([
    ['explode_polyline', [], () => ({ id: 'ghost' }), 'ghost'],
    ['explode_polyline', [pline([0, 0, 1, 1])], ([id]) => ({ id }), "'line'"],
    ['explode_polyline', [pline([0, 0, 1, 0])], ([id]) => ({ id })],
    ['offset_2d', [], () => ({ id: 'ghost', distance: 1 })],
    ['offset_2d', [pline([0, 0, 1, 0])], ([id]) => ({ id, distance: 0 })],
    ['offset_2d', [['draw_arc', { center: [0, 0], radius: 2 }]], ([id]) => ({ id, distance: -3 })],
    ['offset_2d', [['draw_rectangle', { width: 2, height: 2 }]], ([id]) => ({ id, distance: -2 })],
    [
      'offset_2d',
      [['draw_arc', { center: [0, 0], radius: 5, startAngle: 0, endAngle: Math.PI }]],
      ([id]) => ({ id, distance: 1 }),
      "'arc'",
    ],
    ['trim', [], () => ({ id: 'ghost', boundaryId: 'also-ghost' })],
    ['trim', [pline([0, 0, 5, 0])], ([id]) => ({ id, boundaryId: 'missing' })],
    ['trim', [pline([0, 0, 5, 0, 5, 5]), pline([2, -5, 2, 5])], ([id, boundaryId]) => ({ id, boundaryId })],
    ['trim', [pline([0, 0, 5, 0]), pline([0, 1, 5, 1])], ([id, boundaryId]) => ({ id, boundaryId }), 'parallel'],
    ['trim', [pline([0, 0, 1, 0]), pline([5, -1, 5, 1])], ([id, boundaryId]) => ({ id, boundaryId })],
    ['trim', [pline([0, 0, 5, 0])], ([id]) => ({ id, boundaryId: id })],
    ['extend', [], () => ({ id: 'ghost', boundaryId: 'also-ghost' })],
    ['extend', [pline([0, 0, 5, 0]), pline([0, 2, 5, 2])], ([id, boundaryId]) => ({ id, boundaryId }), 'parallel'],
    ['extend', [['draw_arc', { center: [0, 0], radius: 3 }], pline([0, -5, 0, 5])], ([id, boundaryId]) => ({ id, boundaryId })],
    ['extend', [pline([0, 0, 5, 0])], ([id]) => ({ id, boundaryId: id })],
    ['fillet_2d', [], () => ({ id: 'ghost', radius: 1, vertexIndex: 1 })],
    ['fillet_2d', [pline([0, 0, 5, 0])], ([id]) => ({ id, radius: 1, vertexIndex: 0 })],
    ['fillet_2d', [pline([0, 0, 4, 0, 4, 4])], ([id]) => ({ id, radius: 0, vertexIndex: 1 })],
    ['fillet_2d', [pline([0, 0, 4, 0, 4, 4])], ([id]) => ({ id, radius: 0.5, vertexIndex: 0 }), 'out of range'],
    ['fillet_2d', [pline([0, 0, 1, 0, 1, 1])], ([id]) => ({ id, radius: 2, vertexIndex: 1 }), 'too large'],
    ['fillet_2d', [pline([0, 0, 4, 0], { closed: false })], ([id]) => ({ id, radius: 0.5, vertexIndex: 1 })],
    ['chamfer_2d', [], () => ({ id: 'ghost', distance: 1, vertexIndex: 1 })],
    ['chamfer_2d', [pline([0, 0, 5, 0])], ([id]) => ({ id, distance: 1, vertexIndex: 0 })],
    ['chamfer_2d', [pline([0, 0, 4, 0, 4, 4])], ([id]) => ({ id, distance: -1, vertexIndex: 1 })],
    ['chamfer_2d', [pline([0, 0, 4, 0, 4, 4])], ([id]) => ({ id, distance: 0.5, vertexIndex: 2 }), 'out of range'],
    ['chamfer_2d', [pline([0, 0, 1, 0, 1, 1])], ([id]) => ({ id, distance: 1.5, vertexIndex: 1 }), 'too large'],
    ['chamfer_2d', [pline([0, 0, 4, 0], { closed: false })], ([id]) => ({ id, distance: 0.5, vertexIndex: 1 })],
  ])('%s is a no-op (%#)', (name, steps, p, summary) => {
    const { doc, ids } = build(...steps);
    expectNoOp(execute(doc, name, p(ids)), doc, summary);
  });

  describe('explode_polyline', () => {
    it('open polyline → N-1 lines replacing it', () => {
      const {
        doc,
        ids: [id],
      } = build(pline([0, 0, 1, 0, 1, 1]));
      const r = execute(doc, 'explode_polyline', { id });
      expect(r.document.entities[id!]).toBeUndefined();
      expect(r.document.order).not.toContain(id);
      expect(r.document.order).toEqual(r.affected);
      expect(r.affected.map((l) => ent(r.document, l))).toMatchObject([
        { kind: 'line', start: [0, 0], end: [1, 0] },
        { kind: 'line', start: [1, 0], end: [1, 1] },
      ]);
      expect(r.summary).toContain(id);
    });

    it('closed polyline → N lines incl. the closing one; color is inherited', () => {
      const {
        doc,
        ids: [id],
      } = build(pline([0, 0, 2, 0, 2, 2], { closed: true, color: '#ff0000' }));
      const r = execute(doc, 'explode_polyline', { id });
      expect(r.affected).toHaveLength(3);
      expect(ent(r.document, r.affected[2]!)).toMatchObject({ start: [2, 2], end: [0, 0] });
      for (const l of r.affected) expect(ent(r.document, l).color).toBe('#ff0000');
    });
  });

  describe('offset_2d', () => {
    it.each<[readonly [string, unknown], number, Record<string, unknown>, (e: Loose) => void]>([
      [pline([0, 0, 4, 0]), 2, { kind: 'line' }, (e) => close([(e['start'] as number[])[1]!, (e['end'] as number[])[1]!], [2, 2])],
      [pline([0, 0, 4, 0]), -1, { kind: 'line' }, (e) => expect((e['start'] as number[])[1]).toBeCloseTo(-1)],
      [
        pline([0, 0, 4, 0, 4, 4]),
        1,
        { kind: 'polyline', closed: false },
        (e) => close([(e['points'] as number[][])[0]![1]!, (e['points'] as number[][])[2]![0]!], [1, 3]),
      ],
      [['draw_arc', { center: [0, 0], radius: 5 }], 3, { kind: 'circle' }, (e) => expect(e['radius']).toBeCloseTo(8)],
      [
        ['draw_rectangle', { width: 4, height: 3 }],
        1,
        { kind: 'rectangle' },
        (e) => close([e['width'], e['height'], ...e.position] as number[], [6, 5, -1, -1]),
      ],
    ])('offsets %j by %d, keeping the source', (step, distance, shape, check) => {
      const {
        doc,
        ids: [id],
      } = build(step);
      const r = execute(doc, 'offset_2d', { id, distance });
      expect(r.affected).toHaveLength(1);
      const e = ent(r.document, r.affected[0]!);
      expect(e).toMatchObject(shape);
      if (shape['kind'] === 'polyline') expect(e['points']).toHaveLength(3);
      check(e);
      expect(r.document.entities[id!]).toEqual(doc.entities[id!]);
    });
  });

  describe('trim / extend', () => {
    it.each<[string, number[], number[], 'start' | 'end', number, number[]]>([
      ['trim', [0, 0, 10, 0], [3, -5, 3, 5], 'start', 3, [10, 0]],
      ['trim', [0, 0, 10, 0], [8, -5, 8, 5], 'end', 8, [0, 0]],
      ['extend', [2, 0, 4, 0], [0, -5, 0, 5], 'start', 0, [4, 0]],
      ['extend', [0, 0, 3, 0], [10, -5, 10, 5], 'end', 10, [0, 0]],
    ])('%s moves the %3$s nearest the boundary', (name, line, boundary, moved, x, kept) => {
      const {
        doc,
        ids: [id, boundaryId],
      } = build(pline(line), pline(boundary));
      const r = execute(doc, name, { id, boundaryId });
      expect(r.affected).toEqual([id]);
      const e = ent(r.document, id!);
      close(e[moved] as number[], [x, 0]);
      expect(e[moved === 'start' ? 'end' : 'start']).toEqual(kept);
    });
  });

  describe('fillet_2d / chamfer_2d', () => {
    const corner = (name: string, pts: number[], p: object, closed = false): ReturnType<typeof execute> & { id: string } => {
      const {
        doc,
        ids: [id],
      } = build(pline(pts, { closed, color: '#abcdef' }));
      return { ...execute(doc, name, { id, ...p }), id: id! };
    };
    const dist = (c: number[], p: number[]): number => Math.hypot(c[0]! - p[0]!, c[1]! - p[1]!);

    it('fillet replaces a right-turn corner by tangent points and an arc', () => {
      const r = corner('fillet_2d', [0, 0, 4, 0, 4, 8], { radius: 1, vertexIndex: 1 });
      expect(r.affected).toEqual([r.id, expect.any(String)]);
      const arc = ent(r.document, r.affected[1]!);
      expect(ent(r.document, r.id)['points']).toHaveLength(4);
      expect(arc).toMatchObject({ kind: 'arc', radius: expect.closeTo(1, 5) });
      close(arc['center'] as number[], [3, 1]);
      for (const t of xy(3, 0, 4, 1)) expect(dist(arc['center'] as number[], t)).toBeCloseTo(1);
      expect(r.summary).toContain(r.id);
      expect(r.summary).toContain(r.affected[1]);
    });

    it('fillet on a left-turn corner mirrors the centre and swaps the sweep', () => {
      const r = corner('fillet_2d', [0, 8, 4, 8, 4, 0], { radius: 1, vertexIndex: 1 });
      expect(r.affected).toHaveLength(2);
      const arc = ent(r.document, r.affected[1]!);
      close(arc['center'] as number[], [3, 7]);
      expect(arc['radius']).toBeCloseTo(1);
      for (const t of xy(3, 8, 4, 7)) expect(dist(arc['center'] as number[], t)).toBeCloseTo(1);
      close([arc['startAngle'], arc['endAngle']] as number[], [0, Math.PI / 2]);
    });

    it('chamfer replaces a corner by two bevel points and an inheriting bevel line', () => {
      const r = corner('chamfer_2d', [0, 0, 4, 0, 4, 8], { distance: 1, vertexIndex: 1 });
      expect(r.affected).toEqual([r.id, expect.any(String)]);
      const pts = ent(r.document, r.id)['points'] as number[][];
      expect(pts).toHaveLength(4);
      close([...pts[1]!, ...pts[2]!], [3, 0, 4, 1]);
      const bevel = ent(r.document, r.affected[1]!);
      expect(bevel).toMatchObject({ kind: 'line', color: '#abcdef' });
      close([...(bevel['start'] as number[]), ...(bevel['end'] as number[])], [3, 0, 4, 1]);
    });

    it.each([
      ['fillet_2d', { radius: 0.5, vertexIndex: 0 }],
      ['chamfer_2d', { distance: 0.5, vertexIndex: 2 }],
    ])('%s on a closed polyline adds one vertex', (name, p) => {
      const r = corner(name, [0, 0, 4, 0, 4, 4, 0, 4], p, true);
      expect(r.affected).toHaveLength(2);
      expect(ent(r.document, r.id)['points']).toHaveLength(5);
    });
  });
});
