/**
 * SC-Q4b judges for the feature history (docs/MUTATION.md): each history meta-command, run on a non-trivial plan, must give the model
 * that the edited plan builds from scratch (replay equality), and an after-the-fact parameter edit must regenerate its dependents.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { BoxEntity, CadDocument, LineEntity } from '@core/model/types';
import type { GoldenAction } from './plans';
import { normalizeRegenerated } from './normalize';
import { runPlan } from './runPlan';
import { xy } from '../helpers/xy';

const parameter = (w: string): GoldenAction => ({ command: 'set_parameter', params: { name: 'w', expression: w } });
const box = (size: unknown[] = ['=w', 4, 2]): GoldenAction => ({ command: 'add_box', params: { size }, as: 'b' });
const cylinder: GoldenAction = { command: 'add_cylinder', params: { radius: 1, height: 5, position: [8, 0, 0] }, as: 'c' };
const sphere: GoldenAction = { command: 'add_sphere', params: { radius: 2, position: [0, 9, 0] } };
const material = (density: number): GoldenAction => ({
  command: 'create_material',
  params: { name: 'steel', density, color: '#808080', metalness: 0.9, roughness: 0.3 },
});
const assign: GoldenAction = { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$b'] } };
const component: GoldenAction = { command: 'create_component', params: { name: 'Peg', entityIds: ['$c'], componentId: 'comp-peg' } };
const instance: GoldenAction = { command: 'insert_instance', params: { componentId: 'comp-peg', position: [0, -6, 0] } };
const shift: GoldenAction = { command: 'move_entities', params: { ids: ['$b'], delta: [0, 0, 3] } };
const edge: GoldenAction = { command: 'draw_polyline', params: { points: xy(0, 20, 10, 21) }, as: 'e' };
const level: GoldenAction = { command: 'add_constraint', params: { constraint: { kind: 'horizontal', a: { entityId: '$e' } } } };
const span = (value: number | string): GoldenAction => ({
  command: 'add_constraint',
  params: { constraint: { kind: 'aligned', a: { entityId: '$e' }, value } },
});
const solve: GoldenAction = { command: 'solve_constraints', params: {} };

const BASE: GoldenAction[] = [
  parameter('10'),
  box(),
  cylinder,
  material(0.00785),
  assign,
  component,
  instance,
  shift,
  edge,
  level,
  span('w * 3'),
  solve,
];

const build = (actions: GoldenAction[]): CadDocument => {
  const outcome = runPlan(actions);
  expect(outcome.failedSteps).toEqual([]);
  return outcome.document;
};

/** Id of the `nth` recorded step running `command` (set_parameter is a meta-command and records no step). */
const stepId = (doc: CadDocument, command: string, nth = 0): string => {
  const step = doc.featureHistory.filter((s) => s.name === command)[nth];
  if (!step) throw new Error(`no step #${nth} running ${command}`);
  return step.id;
};

const edited = (doc: CadDocument, command: string, params: Record<string, unknown>): CadDocument => {
  const result = execute(doc, command, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
};

const expectSameModel = (actual: CadDocument, expected: CadDocument): void =>
  expect(normalizeRegenerated(actual)).toEqual(normalizeRegenerated(expected));

describe('history meta-commands match the edited plan rebuilt from scratch', () => {
  const base = build(BASE);

  it('the base plan records one step per mutating action', () => {
    expect(base.featureHistory.map((s) => s.name)).toEqual(BASE.slice(1).map((a) => a.command));
  });

  it('delete_step of the instance equals the plan without it', () => {
    expectSameModel(edited(base, 'delete_step', { stepId: stepId(base, 'insert_instance') }), build(BASE.filter((a) => a !== instance)));
  });

  it('set_step_suppressed drops the move until it is restored', () => {
    const suppressed = edited(base, 'set_step_suppressed', { stepId: stepId(base, 'move_entities'), suppressed: true });
    expectSameModel(suppressed, build(BASE.filter((a) => a !== shift)));
    expectSameModel(edited(suppressed, 'set_step_suppressed', { stepId: stepId(base, 'move_entities'), suppressed: false }), base);
  });

  it('reorder_step of the cylinder before the box equals the plan in that order', () => {
    const reordered = edited(base, 'reorder_step', { stepId: stepId(base, 'add_cylinder'), newIndex: 0 });
    expect(reordered.featureHistory.map((s) => s.name).slice(0, 2)).toEqual(['add_cylinder', 'add_box']);
    expectSameModel(reordered, build([parameter('10'), cylinder, box(), ...BASE.slice(3)]));
  });

  it('insert_step after the box equals the plan with the sphere there', () => {
    const inserted = edited(base, 'insert_step', { afterStepId: stepId(base, 'add_box'), name: 'add_sphere', params: sphere.params });
    expectSameModel(inserted, build([parameter('10'), box(), sphere, ...BASE.slice(2)]));
  });

  it('edit_step_params of the box size equals the plan built with that size', () => {
    const size = [6, 5, 1];
    expectSameModel(
      edited(base, 'edit_step_params', { stepId: stepId(base, 'add_box'), params: { size } }),
      build(BASE.map((a) => (a.as === 'b' ? box(size) : a))),
    );
  });

  it('edit_step_params of a material that a later step carries regenerates the assigned material', () => {
    const steel = BASE.find((a) => a.command === 'create_material') as GoldenAction;
    const heavier = edited(base, 'edit_step_params', { stepId: stepId(base, 'create_material'), params: material(0.0113).params ?? {} });
    expect(heavier.materials['steel']?.density).toBe(0.0113);
    expectSameModel(heavier, build(BASE.map((a) => (a === steel ? material(0.0113) : a))));
  });

  it('edit_step_params of a dimension re-solves the sketch after it', () => {
    const spanStep = base.featureHistory.filter((s) => s.name === 'add_constraint')[1];
    const recorded = spanStep?.params as { constraint: Record<string, unknown> };
    const params = { ...recorded, constraint: { ...recorded.constraint, value: 42 } };
    const longer = edited(base, 'edit_step_params', { stepId: spanStep?.id ?? '', params });
    expectSameModel(longer, build(BASE.map((a) => (a === BASE[BASE.length - 2] ? span(42) : a))));
    const line = Object.values(longer.entities).find((e): e is LineEntity => e.kind === 'line');
    expect(line && Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1])).toBeCloseTo(42, 9);
  });

  it('replay_history of the base reproduces it', () => {
    expectSameModel(edited(base, 'replay_history', {}), base);
  });
});

describe('a parameter edited after the fact regenerates its dependents', () => {
  it('set_parameter w=25 equals the plan built with w=25: box width and the dimensioned edge follow', () => {
    const base = build(BASE);
    const wide = edited(base, 'set_parameter', { name: 'w', expression: '25' });
    expectSameModel(wide, build([parameter('25'), ...BASE.slice(1)]));
    const boxEntity = Object.values(wide.entities).find((e): e is BoxEntity => e.kind === 'box');
    expect(boxEntity?.size[0]).toBe(25);
    const line = Object.values(wide.entities).find((e): e is LineEntity => e.kind === 'line');
    expect(line && Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1])).toBeCloseTo(75, 9);
    expect(line && line.end[1] - line.start[1]).toBeCloseTo(0, 9);
  });
});
