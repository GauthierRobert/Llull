/**
 * SC-Q4b judge plans: one `build_project` sketch per constraint family, each ending in `solve_constraints`, with the degrees of freedom
 * the solved sketch must report. Kept beside `plans.ts` (same snapshot + replay-equality treatment) and checked against `sketchOracle.ts`.
 */

import type { GoldenAction } from './plans';
import { xy } from '../helpers/xy';

type Sub = 'start' | 'end' | 'center' | 'mid';

const r = (alias: string, kind?: Sub): Record<string, string> => (kind ? { entityId: `$${alias}`, kind } : { entityId: `$${alias}` });

const line = (as: string, x1: number, y1: number, x2: number, y2: number): GoldenAction => ({
  command: 'draw_polyline',
  params: { points: xy(x1, y1, x2, y2) },
  as,
});

const arc = (as: string, cx: number, cy: number, radius: number, startAngle?: number, endAngle?: number): GoldenAction => ({
  command: 'draw_arc',
  params: { center: [cx, cy], radius, ...(startAngle === undefined ? {} : { startAngle, endAngle }) },
  as,
});

const con = (
  kind: string,
  a: Record<string, string>,
  b?: Record<string, string>,
  extra: { value?: number | string; axis?: Record<string, string> } = {},
): GoldenAction => ({ command: 'add_constraint', params: { constraint: { kind, a, ...(b ? { b } : {}), ...extra } } });

const SOLVE: GoldenAction = { command: 'solve_constraints', params: {} };

export interface SketchPlan {
  readonly actions: GoldenAction[];
  /** Degrees of freedom the solved sketch reports. */
  readonly dof: number;
}

const PI = Math.PI;

export const sketchPlans: Record<string, SketchPlan> = {
  /** Obround slot: two end-cap arcs joined by tangent lines, driven by radius + slot_length (dimensional + tangent family). */
  sketch_slot_fully_constrained: {
    dof: 0,
    actions: [
      arc('left', 0, 0, 4, PI / 2, (3 * PI) / 2),
      arc('right', 21, 1, 6, -PI / 2, PI / 2),
      line('bottom', 0, -4, 21, -5),
      line('top', 21, 7, 0, 4),
      con('coincident', r('left', 'end'), r('bottom', 'start')),
      con('coincident', r('bottom', 'end'), r('right', 'start')),
      con('coincident', r('right', 'end'), r('top', 'start')),
      con('coincident', r('top', 'end'), r('left', 'start')),
      con('tangent', r('bottom'), r('left')),
      con('tangent', r('bottom'), r('right')),
      con('tangent', r('top'), r('right')),
      con('tangent', r('top'), r('left')),
      con('equal', r('left'), r('right')),
      con('radius', r('left'), undefined, { value: 5 }),
      con('slot_length', r('left'), r('right'), { value: 30 }),
      con('horizontal', r('bottom')),
      con('fix', r('left', 'center')),
      SOLVE,
    ],
  },
  /** Line → arc → line with G1 (curvature) joints, arc sweep and arc length (curves family). */
  sketch_tangent_arc_chain: {
    dof: 0,
    actions: [
      line('in', 0, 0, 20, 1),
      arc('bend', 19, 9, 7, -PI / 2, 0.1),
      line('out', 27, 10, 28, 30),
      con('curvature', r('in', 'end'), r('bend', 'start')),
      con('curvature', r('bend', 'end'), r('out', 'start')),
      con('fix', r('in', 'start')),
      con('horizontal', r('in')),
      con('aligned', r('in'), undefined, { value: 20 }),
      con('radius', r('bend'), undefined, { value: 8 }),
      con('arc_sweep', r('bend'), undefined, { value: PI / 2 }),
      con('aligned', r('out'), undefined, { value: 15 }),
      SOLVE,
    ],
  },
  /** Symmetric bracket about a vertical axis: symmetric, perpendicular, midpoint, collinear, equal, point_to_line, distances. */
  sketch_symmetric_bracket: {
    dof: 0,
    actions: [
      line('axis', 0, -2, 0, 30),
      line('base', -14, 7, 15, 6),
      line('leftLeg', -14, 7, -15, 23),
      line('rightLeg', 15, 6, 14, 25),
      line('lip', -3, 30, 4, 31),
      con('fix', r('axis')),
      con('symmetric', r('base', 'start'), r('base', 'end'), { axis: r('axis') }),
      con('coincident', r('leftLeg', 'start'), r('base', 'start')),
      con('coincident', r('rightLeg', 'start'), r('base', 'end')),
      con('symmetric', r('leftLeg', 'end'), r('rightLeg', 'end'), { axis: r('axis') }),
      con('perpendicular', r('base'), r('leftLeg')),
      con('horizontal_distance', r('base', 'start'), r('base', 'end'), { value: 30 }),
      con('point_to_line', r('base', 'start'), r('lip'), { value: 24 }),
      con('vertical_distance', r('base', 'start'), r('leftLeg', 'end'), { value: 18 }),
      con('midpoint', r('axis', 'end'), r('lip')),
      con('horizontal', r('lip')),
      con('aligned', r('lip'), undefined, { value: 8 }),
      SOLVE,
    ],
  },
  /** Concentric / tangent circles, a diameter, an angle between lines and a point held on a circle (round family). */
  sketch_circles_and_angles: {
    dof: 0,
    actions: [
      arc('hub', 0, 0, 9),
      arc('bore', 1, 1, 4),
      arc('boss', 25, 3, 5),
      arc('rim', 0, 1, 14, 0.2, 1.4),
      line('spokeA', 0, 0, 24, 2),
      line('spokeB', 0, 0, 3, 9),
      con('fix', r('hub', 'center')),
      con('diameter', r('hub'), undefined, { value: 20 }),
      con('concentric', r('hub'), r('bore')),
      con('radius', r('bore'), undefined, { value: 3 }),
      con('coincident', r('spokeA', 'start'), r('hub', 'center')),
      con('horizontal', r('spokeA')),
      con('coincident', r('spokeA', 'end'), r('boss', 'center')),
      con('tangent', r('hub'), r('boss')),
      con('radius', r('boss'), undefined, { value: 6 }),
      con('coincident', r('spokeB', 'start'), r('hub', 'center')),
      con('angle', r('spokeA'), r('spokeB'), { value: PI / 3 }),
      con('point_on_curve', r('spokeB', 'end'), r('hub')),
      con('concentric', r('hub'), r('rim')),
      con('radius', r('rim'), undefined, { value: 15 }),
      con('arc_length', r('rim'), undefined, { value: 18 }),
      con('point_on_curve', r('rim', 'start'), r('spokeA')),
      SOLVE,
    ],
  },
  /** Free geometry keeps its degrees of freedom: a parallel pair of lines and one circle with only a radius. */
  sketch_under_constrained_dof: {
    dof: 9,
    actions: [
      line('a', 0, 0, 10, 0),
      line('b', 0, 3, 10, 5),
      arc('c', 20, 0, 3),
      con('parallel', r('a'), r('b')),
      con('radius', r('c'), undefined, { value: 4 }),
      SOLVE,
    ],
  },
};
