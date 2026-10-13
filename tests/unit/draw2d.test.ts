import { describe, it, expect } from 'vitest';
import { expectPure, expectNoOp } from '../helpers/expectNoOp';
import { createEmptyDocument, is2D, is3D, type ArcEntity, type Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { xy } from '../helpers/xy';
import { add } from '../helpers/addEntity';

type Loose = Entity & Record<string, unknown>;
const empty = createEmptyDocument();
const created = (r: ReturnType<typeof execute>): Loose => r.document.entities[r.affected[0]!] as Loose;

describe('2D draw commands', () => {
  it.each<[string, object, Record<string, unknown>, string[], RegExp?]>([
    [
      'draw_polyline',
      { points: xy(0, 0, 5, 3) },
      { kind: 'line', start: [0, 0], end: [5, 3], position: [0, 0, 0], color: '#4a90d9' },
      [],
      /^line-/,
    ],
    [
      'draw_polyline',
      { points: xy(0, 0, 1, 1), position: [2, 3, 4], color: '#ff0000' },
      { kind: 'line', position: [2, 3, 4], color: '#ff0000' },
      [],
    ],
    ['draw_polyline', { points: xy(0, 0, 5, 3), closed: true }, { kind: 'polyline' }, []],
    ['draw_polyline', { points: xy(0, 0, 2, 0, 2, 2, 0, 2) }, { kind: 'polyline', points: xy(0, 0, 2, 0, 2, 2, 0, 2), closed: false }, []],
    ['draw_polyline', { points: xy(0, 0, 1, 0, 0, 1), closed: true }, { kind: 'polyline', closed: true }, ['closed']],
    [
      'draw_arc',
      { center: [1, 2], radius: 5, startAngle: 0, endAngle: Math.PI },
      { kind: 'arc', center: [1, 2], radius: 5, startAngle: 0 },
      ['5'],
    ],
    ['draw_arc', { center: [3, 4], radius: 7 }, { kind: 'circle', center: [3, 4], radius: 7 }, ['7'], /^circ-/],
    ['draw_rectangle', { width: 10, height: 5 }, { kind: 'rectangle', width: 10, height: 5 }, ['10', '5']],
    ['draw_point', { position: [1, 2, 3] }, { kind: 'point', position: [1, 2, 3] }, []],
    ['draw_point', {}, { kind: 'point', position: [0, 0, 0] }, []],
  ])('%s %j creates one 2D entity, purely', (name, p, shape, summary, idPattern) => {
    const r = execute(empty, name, p);
    expect(r.affected).toHaveLength(1);
    const id = r.affected[0]!;
    const e = created(r);
    expect(e).toMatchObject(shape);
    expect([is2D(e), is3D(e)]).toEqual([true, false]);
    expect(r.document.order).toContain(id);
    for (const s of [id, ...summary]) expect(r.summary).toContain(s);
    if (idPattern) expect(id).toMatch(idPattern);
    if (shape['kind'] === 'arc') expect(e['endAngle']).toBeCloseTo(Math.PI);
    expectPure(empty, () => execute(empty, name, p));
  });

  it.each<[string, object, string?]>([
    ['draw_polyline', { points: [null, [1, 1]] }, 'draw_polyline'],
    ['draw_polyline', { points: [[0, 0]] }, 'draw_polyline'],
    ['draw_polyline', { points: [] }],
    ['draw_arc', { center: [0, 0], radius: 0, startAngle: 0, endAngle: 1 }, 'draw_arc'],
    ['draw_arc', { center: [0, 0], radius: -3, startAngle: 0, endAngle: 1 }],
    ['draw_arc', { center: [0, 0], radius: 2, startAngle: 0 }, 'both startAngle and endAngle'],
    ['draw_arc', { center: [0, 0], radius: 0 }, 'draw_arc'],
    ['draw_arc', { center: [0, 0], radius: -1 }],
    ['draw_arc', { center: [0, 0], radius: 2, startAngle: 0, endAngle: Number.NaN }],
    ['draw_rectangle', { width: 0, height: 5 }, 'draw_rectangle'],
    ['draw_rectangle', { width: 3, height: -2 }],
  ])('%s %j is a no-op', (name, p, summary) => expectNoOp(execute(empty, name, p), empty, summary));

  it('draw_arc wraps a sweep over 2π into (0, 2π] and keeps CCW wrap and full sweeps', () => {
    const sweep = (startAngle: number, endAngle: number): { s: number; summary: string; arc: ArcEntity } => {
      const r = execute(empty, 'draw_arc', { center: [0, 0], radius: 2, startAngle, endAngle });
      const arc = created(r) as unknown as ArcEntity;
      return { s: arc.endAngle - arc.startAngle, summary: r.summary, arc };
    };
    const over = sweep(-2.04, 4.71);
    expect(over.s).toBeCloseTo(6.75 - 2 * Math.PI, 9);
    expect(over.summary).toContain('wrapped');
    expect(sweep(4.71, -2.04).s).toBeCloseTo(4 * Math.PI - 6.75, 9);
    const wrap = sweep(5, 1);
    expect(wrap.arc).toMatchObject({ startAngle: 5, endAngle: 1 });
    expect(wrap.summary).not.toContain('wrapped');
    expect(sweep(0, 2 * Math.PI).arc.endAngle).toBeCloseTo(2 * Math.PI, 12);
    const s0 = 5.886628178167261;
    for (const turns of [2, 5]) expect(sweep(s0, s0 + turns * 2 * Math.PI).s).toBeCloseTo(2 * Math.PI, 9);
    expect(sweep(1, 1 + 2 * Math.PI + 2e-9).s).toBeCloseTo(2 * Math.PI, 9);
  });

  it('is3D is true and is2D false for solids', () => {
    const box = created(execute(empty, 'add_box', { size: [1, 1, 1] }));
    expect([is3D(box), is2D(box)]).toEqual([true, false]);
  });

  it.each<[string, object, number, Record<string, unknown>]>([
    ['draw_polyline', { points: xy(1, 2, 3, 4) }, 2, { kind: 'line', start: [2, 4], end: [6, 8] }],
    ['draw_polyline', { points: xy(1, 0, 2, 0, 2, 1) }, 3, { points: xy(3, 0, 6, 0, 6, 3) }],
    ['draw_arc', { center: [2, 4], radius: 5, startAngle: 0, endAngle: Math.PI }, 2, { center: [4, 8], radius: 10 }],
    ['draw_arc', { center: [1, 2], radius: 4 }, 0.5, { center: [0.5, 1], radius: 2 }],
    ['draw_rectangle', { width: 4, height: 6 }, 3, { width: 12, height: 18 }],
    ['draw_point', { position: [1, 2, 3] }, 5, { kind: 'point', position: [1, 2, 3] }],
  ])('scale_entity scales %s %j by %d (local geometry only), purely', (name, p, factor, shape) => {
    const { doc, id } = add(empty, name, p);
    const r = execute(doc, 'scale_entity', { id, factor });
    expect(r.affected).toEqual([id]);
    expect(r.document.entities[id]).toMatchObject(shape);
    expectPure(doc, () => execute(doc, 'scale_entity', { id, factor }));
  });
});
