/**
 * SC-Q4b golden plans: one `build_project` plan per constraint / dimension family of the sketch solver (the 25 kinds of
 * `CONSTRAINT_KINDS`). Every plan ends in `solve_constraints`; the snapshot pins the solved coordinates, `CONSTRAINT_DOF` pins the
 * degrees of freedom the solver reports on the finished sketch.
 */

import type { GoldenAction } from './plans';
import { xy } from '../helpers/xy';

type Ref = { entityId: string; kind?: 'start' | 'end' | 'center' | 'mid' };

const at = (alias: string, kind?: Ref['kind']): Ref => ({ entityId: `$${alias}`, ...(kind ? { kind } : {}) });

const constraint = (kind: string, a: Ref, b?: Ref, extra: { value?: number | string; axis?: Ref } = {}): GoldenAction => ({
  command: 'add_constraint',
  params: { constraint: { kind, a, ...(b ? { b } : {}), ...extra } },
});

const line = (alias: string, ...points: number[]): GoldenAction => ({
  command: 'draw_polyline',
  params: { points: xy(...points) },
  as: alias,
});
const circle = (alias: string, center: [number, number], radius: number): GoldenAction => ({
  command: 'draw_arc',
  params: { center, radius },
  as: alias,
});
const arc = (alias: string, center: [number, number], radius: number, startAngle: number, endAngle: number): GoldenAction => ({
  command: 'draw_arc',
  params: { center, radius, startAngle, endAngle },
  as: alias,
});
const solve: GoldenAction = { command: 'solve_constraints', params: {} };

export const constraintPlans: Record<string, GoldenAction[]> = {
  constraints_coincident_horizontal_vertical_fix: [
    line('a', 0, 0, 9, 2),
    line('b', 10, 1, 13, 8),
    line('c', 12, 9, 2, 7),
    constraint('coincident', at('a', 'end'), at('b', 'start')),
    constraint('coincident', at('b', 'end'), at('c', 'start')),
    constraint('fix', at('a', 'start')),
    constraint('horizontal', at('a')),
    constraint('vertical', at('b')),
    constraint('horizontal', at('c', 'start'), at('c', 'end')),
    constraint('aligned', at('a'), undefined, { value: 10 }),
    constraint('aligned', at('b'), undefined, { value: 6 }),
    constraint('aligned', at('c'), undefined, { value: 8 }),
    solve,
  ],
  constraints_parallel_perpendicular_collinear_equal: [
    line('a', 0, 0, 10, 1),
    line('b', 0, 4, 9, 6),
    line('c', 10, 1, 11, 9),
    line('d', 14, 3, 20, 4),
    line('e', 0, 20, 3, 21),
    constraint('fix', at('a')),
    constraint('parallel', at('a'), at('b')),
    constraint('distance', at('a', 'start'), at('b', 'start'), { value: 4 }),
    constraint('coincident', at('a', 'end'), at('c', 'start')),
    constraint('perpendicular', at('a'), at('c')),
    constraint('collinear', at('a'), at('d')),
    constraint('equal', at('a'), at('e')),
    constraint('coincident', at('c', 'end'), at('e', 'start')),
    solve,
  ],
  constraints_tangent_point_on_curve_concentric: [
    line('floor', 0, 2, 20, 2),
    circle('wheel', [6, -1], 1),
    circle('cap', [15, -4], 1.5),
    circle('dot', [3, 4], 0.5),
    circle('ring', [30, 5], 4),
    circle('inner', [31, 6], 1),
    constraint('fix', at('floor')),
    constraint('tangent', at('floor'), at('wheel')),
    constraint('radius', at('wheel'), undefined, { value: 2.5 }),
    constraint('tangent', at('wheel'), at('cap')),
    constraint('radius', at('cap'), undefined, { value: 1 }),
    constraint('point_on_curve', at('dot', 'center'), at('floor')),
    constraint('fix', at('ring')),
    constraint('concentric', at('ring'), at('inner')),
    solve,
  ],
  constraints_midpoint_symmetric: [
    line('axis', 0, -5, 0, 10),
    circle('p', [-3, 2], 0.5),
    circle('q', [4, 3], 0.5),
    line('span', 8, 0, 16, 1),
    circle('mid', [11, 4], 0.5),
    circle('hub', [30, 30], 1),
    circle('r', [34, 31], 0.5),
    circle('t', [27, 28], 0.5),
    constraint('fix', at('axis')),
    constraint('symmetric', at('p', 'center'), at('q', 'center'), { axis: at('axis') }),
    constraint('fix', at('p', 'center')),
    constraint('fix', at('span')),
    constraint('midpoint', at('mid', 'center'), at('span')),
    constraint('fix', at('hub', 'center')),
    constraint('symmetric', at('r', 'center'), at('t', 'center'), { axis: at('hub', 'center') }),
    constraint('fix', at('r', 'center')),
    solve,
  ],
  constraints_distance_angle_point_to_line: [
    line('base', 5, 7, 17, 7),
    line('arm', 6, 8, 14, 13),
    line('ruler', 20, 0, 28, 3),
    circle('pin', [24, 6], 0.5),
    constraint('fix', at('base')),
    constraint('coincident', at('arm', 'start'), at('base', 'start')),
    constraint('angle', at('base'), at('arm'), { value: Math.PI / 5 }),
    constraint('aligned', at('arm'), undefined, { value: 9 }),
    constraint('fix', at('ruler', 'start')),
    constraint('distance', at('ruler', 'start'), at('ruler', 'end'), { value: 7 }),
    constraint('horizontal_distance', at('ruler', 'start'), at('ruler', 'end'), { value: 6 }),
    constraint('point_to_line', at('pin', 'center'), at('ruler'), { value: 4 }),
    solve,
  ],
  constraints_vertical_distance_horizontal_distance: [
    line('hook', 3, 2, 10, 9),
    constraint('fix', at('hook', 'start')),
    constraint('horizontal_distance', at('hook', 'start'), at('hook', 'end'), { value: 5 }),
    constraint('vertical_distance', at('hook', 'start'), at('hook', 'end'), { value: 12 }),
    solve,
  ],
  constraints_radius_diameter_arc_dimensions: [
    circle('boss', [0, 0], 1),
    arc('fillet', [10, 0], 1, 0, 1),
    arc('bend', [20, 0], 2, 0.2, 1.1),
    arc('capL', [0, 20], 1, Math.PI / 2, (3 * Math.PI) / 2),
    arc('capR', [5, 20], 1, -Math.PI / 2, Math.PI / 2),
    constraint('radius', at('boss'), undefined, { value: 7 }),
    constraint('diameter', at('fillet'), undefined, { value: 9 }),
    constraint('arc_sweep', at('fillet'), undefined, { value: Math.PI / 2 }),
    constraint('radius', at('bend'), undefined, { value: 3 }),
    constraint('arc_length', at('bend'), undefined, { value: 6 }),
    constraint('slot_length', at('capL'), at('capR'), { value: 12 }),
    constraint('horizontal', at('capL', 'center'), at('capR', 'center')),
    solve,
  ],
  constraints_curvature_arc_chain: [
    arc('a', [2, 3], 5, 0, Math.PI / 2),
    arc('b', [2.3, 3.2], 5.2, 1.5, 3),
    line('tail', 12, 8.5, 2.3, 8.1),
    arc('c', [2, 3], 5, Math.PI / 2, Math.PI),
    constraint('fix', at('a')),
    constraint('curvature', at('a', 'end'), at('b', 'start')),
    constraint('curvature', at('tail', 'end'), at('c', 'start')),
    solve,
  ],
  constraints_parameter_driven_dimension: [
    { command: 'set_parameter', params: { name: 'w', expression: '8' } },
    line('bar', 0, 0, 3, 0),
    constraint('fix', at('bar', 'start')),
    constraint('horizontal', at('bar')),
    constraint('aligned', at('bar'), undefined, { value: 'w * 2' }),
    solve,
    { command: 'set_parameter', params: { name: 'w', expression: '5' } },
    solve,
  ],
  constraints_update_delete_resolve: [
    line('a', 0, 0, 10, 0),
    line('b', 0, 3, 8, 5),
    constraint('fix', at('a')),
    { ...constraint('parallel', at('a'), at('b')), as: 'par' },
    { ...constraint('point_to_line', at('b', 'start'), at('a'), { value: 3 }), as: 'dist' },
    solve,
    { command: 'update_constraint', params: { id: '$dist', patch: { value: 6 } } },
    solve,
    { command: 'delete_constraint', params: { id: '$par' } },
    solve,
  ],
};

/** Degrees of freedom `solve_constraints` reports on the finished plan (unknowns minus the rank of the constraint Jacobian). */
export const CONSTRAINT_DOF: Record<string, number> = {
  constraints_coincident_horizontal_vertical_fix: 0, // 3 lines = 12 unknowns; 4 + 2 + 3 + 3 rows
  constraints_parallel_perpendicular_collinear_equal: 6, // 5 lines = 20; 4 + 1 + 1 + 2 + 1 + 2 + 1 + 2 = 14 rows
  constraints_tangent_point_on_curve_concentric: 5, // line 4 + 5 circles 15 = 19; 4 + 1 + 1 + 1 + 1 + 1 + 3 + 2 = 14 rows
  constraints_midpoint_symmetric: 6, // 26 unknowns, 20 rows: the six free radii
  constraints_distance_angle_point_to_line: 2, // 15 unknowns, 13 rows: the pin centre slides along the offset line, its radius is free
  constraints_vertical_distance_horizontal_distance: 0, // one line: 4 unknowns, 2 + 1 + 1 rows
  constraints_radius_diameter_arc_dimensions: 16, // circle 3 + 4 arcs 20 = 23; 7 rows
  constraints_curvature_arc_chain: 7, // 19 unknowns; fix 5 + G2 4 + G1 3 rows
  constraints_parameter_driven_dimension: 0, // one line: 4 unknowns, 2 + 1 + 1 rows
  constraints_update_delete_resolve: 3, // 8 unknowns; the parallel constraint was deleted, 4 + 1 rows remain
};
