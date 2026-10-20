import { describe, expect, it } from 'vitest';
import { expectPure } from '../helpers/expectNoOp';
import { execute } from '@core/commands/registry';
import {
  addArc,
  addCircle,
  addLine,
  arcOf,
  circleOf,
  constrain,
  emptySketch,
  length,
  lineOf,
  ref,
  solve,
  type Sketch,
} from './helpers/sketch';

const near = (actual: number, expected: number, digits = 6): void => expect(actual).toBeCloseTo(expected, digits);

function solved(sketch: Sketch): ReturnType<typeof solve> {
  const data = solve(sketch);
  expect(data.converged).toBe(true);
  return data;
}

describe('geometric constraint kinds', () => {
  it('horizontal on one line levels its end points; vertical on two points aligns their x', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 3]);
    expect(constrain(s, 'horizontal', ref(line)).id).toBeDefined();
    const c1 = addCircle(s, [20, 0], 1);
    const c2 = addCircle(s, [25, 7], 1);
    expect(constrain(s, 'vertical', ref(c1, 'center'), ref(c2, 'center')).id).toBeDefined();
    solved(s);
    near(lineOf(s, line).start[1], lineOf(s, line).end[1]);
    near(circleOf(s, c1).center[0] + circleOf(s, c1).position[0], circleOf(s, c2).center[0] + circleOf(s, c2).position[0]);
  });

  it('horizontal needs a line or two points', () => {
    const s = emptySketch();
    const circle = addCircle(s, [0, 0], 1);
    expect(constrain(s, 'horizontal', ref(circle)).refused).toContain("'horizontal' needs");
  });

  it('equal makes two lines the same length and two circles the same radius', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [0, 5], [4, 5]);
    const c = addCircle(s, [0, 20], 2);
    const d = addCircle(s, [10, 20], 5);
    constrain(s, 'equal', ref(a), ref(b));
    constrain(s, 'equal', ref(c), ref(d));
    solved(s);
    near(length(lineOf(s, a)), length(lineOf(s, b)));
    near(circleOf(s, c).radius, circleOf(s, d).radius);
    expect(constrain(s, 'equal', ref(a), ref(c)).refused).toContain("'equal' needs");
  });

  it('concentric moves one circle onto the other', () => {
    const s = emptySketch();
    const a = addCircle(s, [0, 0], 5);
    const b = addCircle(s, [3, 4], 2);
    constrain(s, 'concentric', ref(a), ref(b));
    solved(s);
    expect(circleOf(s, b).center[0]).toBeCloseTo(circleOf(s, a).center[0], 6);
    expect(circleOf(s, b).center[1]).toBeCloseTo(circleOf(s, a).center[1], 6);
    expect(constrain(s, 'concentric', ref(a), ref(addLine(s, [0, 0], [1, 1]))).refused).toContain("'concentric' needs");
  });

  it('collinear lays line b on the infinite line a', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [12, 2], [20, 3]);
    constrain(s, 'collinear', ref(a), ref(b));
    solved(s);
    near(lineOf(s, b).start[1], 0);
    near(lineOf(s, b).end[1], 0);
    expect(constrain(s, 'collinear', ref(a), ref(addCircle(s, [0, 9], 1))).refused).toContain("'collinear' needs");
  });

  it('midpoint puts a point on the middle of a line', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    const circle = addCircle(s, [3, 4], 1);
    constrain(s, 'midpoint', ref(circle, 'center'), ref(line));
    solved(s);
    near(circleOf(s, circle).center[0], 5);
    near(circleOf(s, circle).center[1], 0);
    expect(constrain(s, 'midpoint', ref(circle, 'center'), ref(circle)).refused).toContain("'midpoint' needs");
  });

  it('symmetric mirrors two points about a line, or about a point', () => {
    const s = emptySketch();
    const axis = addLine(s, [0, 0], [0, 10]);
    const p = addCircle(s, [-3, 2], 0.5);
    const q = addCircle(s, [4, 3], 0.5);
    constrain(s, 'symmetric', ref(p, 'center'), ref(q, 'center'), { axis: ref(axis) });
    const hub = addCircle(s, [20, 20], 1);
    const r = addCircle(s, [30, 21], 0.5);
    const t = addCircle(s, [10, 18], 0.5);
    constrain(s, 'symmetric', ref(r, 'center'), ref(t, 'center'), { axis: ref(hub, 'center') });
    solved(s);
    const centerOf = (id: string): readonly [number, number] => circleOf(s, id).center;
    near(centerOf(p)[0], -centerOf(q)[0]);
    near(centerOf(p)[1], centerOf(q)[1]);
    near((centerOf(r)[0] + centerOf(t)[0]) / 2, centerOf(hub)[0]);
    near((centerOf(r)[1] + centerOf(t)[1]) / 2, centerOf(hub)[1]);
  });

  it('symmetric needs an axis', () => {
    const s = emptySketch();
    const p = addCircle(s, [0, 0], 1);
    const q = addCircle(s, [5, 0], 1);
    expect(constrain(s, 'symmetric', ref(p, 'center'), ref(q, 'center')).refused).toContain("requires an 'axis'");
  });

  it('fix keeps a point or a whole curve where it is while the rest moves', () => {
    const s = emptySketch();
    const a = addLine(s, [0, 0], [10, 0]);
    const b = addLine(s, [12, 1], [20, 4]);
    constrain(s, 'fix', ref(a));
    constrain(s, 'coincident', ref(a, 'end'), ref(b, 'start'));
    const c = addCircle(s, [30, 0], 2);
    constrain(s, 'fix', ref(c, 'center'));
    constrain(s, 'distance', ref(c, 'center'), ref(b, 'end'), { value: 6 });
    const before = lineOf(s, a);
    const data = solved(s);
    expect(lineOf(s, a)).toEqual(before);
    near(lineOf(s, b).start[0], 10);
    near(lineOf(s, b).start[1], 0);
    expect(circleOf(s, c).center).toEqual([30, 0]);
    expect(data.fullyConstrained).toContain(a);
    expect(constrain(s, 'fix', ref('ghost')).refused).toContain('does not exist');
  });

  it('point_on_curve puts a point on a line or a circle', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    const circle = addCircle(s, [30, 30], 2);
    const onLine = addCircle(s, [4, 3], 0.5);
    const onCircle = addCircle(s, [36, 31], 0.5);
    constrain(s, 'point_on_curve', ref(onLine, 'center'), ref(line));
    constrain(s, 'point_on_curve', ref(onCircle, 'center'), ref(circle));
    solved(s);
    near(circleOf(s, onLine).center[1], 0);
    near(Math.hypot(circleOf(s, onCircle).center[0] - 30, circleOf(s, onCircle).center[1] - 30), 2);
    expect(constrain(s, 'point_on_curve', ref(onLine, 'center'), ref('ghost')).refused).toContain('does not exist');
  });

  it('tangent keeps the side a circle is on and moves the circle, not the line', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    const circle = addCircle(s, [5, -4], 1);
    constrain(s, 'tangent', ref(line), ref(circle));
    const before = lineOf(s, line);
    solved(s);
    expect(lineOf(s, line)).toEqual(before);
    near(circleOf(s, circle).center[1], -1);
    near(circleOf(s, circle).radius, 1);
  });

  it('tangent between circles keeps external contact', () => {
    const s = emptySketch();
    const a = addCircle(s, [0, 0], 3);
    const b = addCircle(s, [8, 0], 2);
    constrain(s, 'tangent', ref(a), ref(b));
    solved(s);
    near(Math.hypot(circleOf(s, b).center[0] - circleOf(s, a).center[0], circleOf(s, b).center[1] - circleOf(s, a).center[1]), 5);
  });

  it('curvature joins two arcs with equal radius and a common tangent (G2)', () => {
    const s = emptySketch();
    const a = addArc(s, [0, 0], 5, 0, Math.PI / 2);
    const b = addArc(s, [0.3, 0.2], 5.2, 1.5, 3);
    expect(constrain(s, 'curvature', ref(a, 'end'), ref(b, 'start')).id).toBeDefined();
    solved(s);
    const arcA = arcOf(s, a);
    const arcB = arcOf(s, b);
    near(arcA.center[0] + arcA.radius * Math.cos(arcA.endAngle), arcB.center[0] + arcB.radius * Math.cos(arcB.startAngle));
    near(arcA.center[1] + arcA.radius * Math.sin(arcA.endAngle), arcB.center[1] + arcB.radius * Math.sin(arcB.startAngle));
    near(Math.sin(arcA.endAngle - arcB.startAngle), 0);
    near(arcA.radius, arcB.radius);
  });

  it('curvature between a line and an arc gives tangent continuity (G1)', () => {
    const s = emptySketch();
    const line = addLine(s, [10, 5.5], [0.3, 5.1]);
    const arc = addArc(s, [0, 0], 5, Math.PI / 2, Math.PI);
    constrain(s, 'curvature', ref(line, 'end'), ref(arc, 'start'));
    solved(s);
    const l = lineOf(s, line);
    const a = arcOf(s, arc);
    near(l.end[0], a.center[0] + a.radius * Math.cos(a.startAngle));
    near(l.end[1], a.center[1] + a.radius * Math.sin(a.startAngle));
    const direction = [l.end[0] - l.start[0], l.end[1] - l.start[1]];
    const tangent = [-Math.sin(a.startAngle), Math.cos(a.startAngle)];
    near((direction[0]! * tangent[1]! - direction[1]! * tangent[0]!) / Math.hypot(direction[0]!, direction[1]!), 0);
  });

  it('curvature needs line/arc ends and refuses splines', () => {
    const s = emptySketch();
    const arc = addArc(s, [0, 0], 5, 0, 1);
    const spline = execute(s.doc, 'draw_spline', {
      points: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    });
    s.doc = spline.document;
    expect(constrain(s, 'curvature', ref(arc), ref(arc, 'start')).refused).toContain("'curvature' needs");
    expect(constrain(s, 'curvature', ref(arc, 'end'), ref(spline.affected[0]!, 'start')).refused).toContain("'curvature' needs");
  });
});

describe('driving dimensions', () => {
  it('radius and diameter size circles and arcs', () => {
    const s = emptySketch();
    const c = addCircle(s, [0, 0], 1);
    const a = addArc(s, [10, 0], 1, 0, 1);
    constrain(s, 'radius', ref(c), undefined, { value: 7 });
    constrain(s, 'diameter', ref(a), undefined, { value: 9 });
    solved(s);
    near(circleOf(s, c).radius, 7);
    near(arcOf(s, a).radius, 4.5);
    expect(constrain(s, 'radius', ref(c), undefined, { value: -1 }).refused).toContain('must be > 0');
    expect(constrain(s, 'radius', ref(addLine(s, [0, 0], [1, 0])), undefined, { value: 2 }).refused).toContain('needs a circle or arc');
  });

  it('aligned sets a line length or a point distance', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [3, 4]);
    const p = addCircle(s, [0, 20], 1);
    const q = addCircle(s, [10, 20], 1);
    constrain(s, 'aligned', ref(line), undefined, { value: 12 });
    constrain(s, 'aligned', ref(p, 'center'), ref(q, 'center'), { value: 4 });
    solved(s);
    near(length(lineOf(s, line)), 12);
    near(Math.hypot(circleOf(s, q).center[0] - circleOf(s, p).center[0], circleOf(s, q).center[1] - circleOf(s, p).center[1]), 4);
  });

  it('horizontal_distance and vertical_distance keep the side as drawn and take magnitudes', () => {
    const s = emptySketch();
    const line = addLine(s, [10, 8], [2, 3]);
    constrain(s, 'horizontal_distance', ref(line, 'start'), ref(line, 'end'), { value: 5 });
    constrain(s, 'vertical_distance', ref(line, 'start'), ref(line, 'end'), { value: -4 });
    solved(s);
    const l = lineOf(s, line);
    near(l.end[0] - l.start[0], -5);
    near(l.end[1] - l.start[1], -4);
  });

  it('point_to_line holds a perpendicular distance on the current side', () => {
    const s = emptySketch();
    const line = addLine(s, [0, 0], [10, 0]);
    const p = addCircle(s, [4, -3], 0.5);
    constrain(s, 'point_to_line', ref(p, 'center'), ref(line), { value: 6 });
    solved(s);
    near(circleOf(s, p).center[1], -6);
  });

  it('arc_sweep and arc_length drive the angle span and the arc length', () => {
    const s = emptySketch();
    const a = addArc(s, [0, 0], 2, 0, 1);
    const b = addArc(s, [10, 0], 3, 0, 1);
    constrain(s, 'arc_sweep', ref(a), undefined, { value: Math.PI / 2 });
    constrain(s, 'arc_length', ref(b), undefined, { value: 6 });
    constrain(s, 'radius', ref(b), undefined, { value: 3 });
    solved(s);
    near(arcOf(s, a).endAngle - arcOf(s, a).startAngle, Math.PI / 2);
    near(arcOf(s, b).radius * (arcOf(s, b).endAngle - arcOf(s, b).startAngle), 6);
    expect(constrain(s, 'arc_sweep', ref(addCircle(s, [0, 9], 1)), undefined, { value: 1 }).refused).toContain('needs an arc');
  });

  it('slot_length sets the center distance between the two end caps', () => {
    const s = emptySketch();
    const a = addArc(s, [0, 0], 1, Math.PI / 2, (3 * Math.PI) / 2);
    const b = addArc(s, [5, 0], 1, -Math.PI / 2, Math.PI / 2);
    constrain(s, 'slot_length', ref(a), ref(b), { value: 12 });
    constrain(s, 'horizontal', ref(a, 'center'), ref(b, 'center'));
    solved(s);
    const gap = Math.hypot(arcOf(s, b).center[0] - arcOf(s, a).center[0], arcOf(s, b).center[1] - arcOf(s, a).center[1]);
    near(gap, 12);
  });

  it('dimensions accept parameter expressions and follow the parameter', () => {
    const s = emptySketch();
    s.doc = execute(s.doc, 'set_parameter', { name: 'w', expression: '8' }).document;
    const line = addLine(s, [0, 0], [3, 0]);
    constrain(s, 'aligned', ref(line), undefined, { value: 'w * 2' });
    solved(s);
    near(length(lineOf(s, line)), 16);
    s.doc = execute(s.doc, 'set_parameter', { name: 'w', expression: '5' }).document;
    solved(s);
    near(length(lineOf(s, line)), 10);
  });

  it('every dimension kind requires a value', () => {
    const s = emptySketch();
    const c = addCircle(s, [0, 0], 1);
    for (const kind of [
      'radius',
      'diameter',
      'aligned',
      'horizontal_distance',
      'vertical_distance',
      'point_to_line',
      'arc_sweep',
      'arc_length',
      'slot_length',
    ]) {
      expect(constrain(s, kind, ref(c)).refused).toContain("requires a numeric or string 'value'");
    }
  });

  it('update_constraint changes a new dimension and refuses `value` on geometric kinds', () => {
    const s = emptySketch();
    const c = addCircle(s, [0, 0], 1);
    const id = constrain(s, 'radius', ref(c), undefined, { value: 3 }).id!;
    const updated = execute(s.doc, 'update_constraint', { id, patch: { value: 6 } });
    expect(updated.affected).toEqual([id]);
    s.doc = updated.document;
    solved(s);
    near(circleOf(s, c).radius, 6);
    const fixId = constrain(s, 'fix', ref(c, 'center')).id!;
    expect(execute(s.doc, 'update_constraint', { id: fixId, patch: { value: 2 } }).summary).toContain("no 'value'");
    expect(execute(s.doc, 'update_constraint', { id, patch: { axis: ref(c) } }).summary).toContain("no 'axis'");
  });

  it('is pure', () => {
    const s = emptySketch();
    const c = addCircle(s, [0, 0], 1);
    constrain(s, 'radius', ref(c), undefined, { value: 3 });
    expectPure(s.doc, () => execute(s.doc, 'solve_constraints', {}));
    expectPure(s.doc, () => execute(s.doc, 'add_constraint', { constraint: { kind: 'diameter', a: ref(c), value: 9 } }));
  });
});
