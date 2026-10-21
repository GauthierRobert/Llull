/**
 * SC-Q4b: replay-equality judges for the history meta-commands. Applying a meta-command to a recorded document must give the same
 * entities / order / materials / parameters as building the edited recipe from scratch. Part of the mutation judge set (stryker
 * `history` folder), so it only asserts observable behaviour.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { buildRecipe, recipeState, type RecipeStep } from './historyRecipe';

const RECIPE: RecipeStep[] = [
  { command: 'add_box', params: { size: [10, 4, 2] }, as: 'box' },
  { command: 'add_cylinder', params: { radius: 1, height: 5, position: [20, 0, 0] }, as: 'cyl' },
  { command: 'create_material', params: { name: 'steel', density: 0.00785, color: '#808080' } },
  { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$box'] } },
  { command: 'move_entities', params: { ids: ['$cyl'], delta: [0, 5, 0] } },
  { command: 'add_sphere', params: { radius: 2, position: [0, 0, 10] }, as: 'ball' },
];

const IDX = { box: 0, cyl: 1, material: 2, assign: 3, move: 4, ball: 5 } as const;

const recorded = (): CadDocument => buildRecipe(RECIPE);
const without = (...indexes: number[]): RecipeStep[] => RECIPE.filter((_, i) => !indexes.includes(i));
const stepId = (doc: CadDocument, index: number): string => doc.featureHistory[index]!.id;
const moved = (from: number, to: number): RecipeStep[] => {
  const copy = [...RECIPE];
  const [step] = copy.splice(from, 1);
  copy.splice(to, 0, step!);
  return copy;
};

describe('recipe fixture', () => {
  it('records one FeatureStep per command and builds the expected entities', () => {
    const doc = recorded();
    expect(doc.featureHistory.map((s) => s.name)).toEqual(RECIPE.map((s) => s.command));
    expect(doc.order).toHaveLength(3);
    expect(Object.values(doc.entities).map((e) => e.kind)).toEqual(['box', 'cylinder', 'sphere']);
  });
});

describe('replay_history', () => {
  it('reproduces the recorded document and reports the step and entity counts', () => {
    const doc = recorded();
    const result = execute(doc, 'replay_history', {});
    expect(result.summary).toContain('replayed 6 step(s); 3 entities in document.');
    expect(result.affected).toEqual(result.document.order);
    expect(recipeState(result.document)).toEqual(recipeState(doc));
    expectPure(doc, () => execute(doc, 'replay_history', {}));
  });

  it('is a no-op on an empty history', () => {
    const empty = buildRecipe([]);
    expectNoOp(execute(empty, 'replay_history', {}), empty, 'empty');
  });

  it('is idempotent', () => {
    const once = execute(recorded(), 'replay_history', {}).document;
    const twice = execute(once, 'replay_history', {}).document;
    expect(recipeState(twice)).toEqual(recipeState(once));
  });
});

describe('delete_step equals the recipe without that step', () => {
  for (const [label, index, dropped] of [
    ['the last step', IDX.ball, [IDX.ball]],
    ['a leaf step (move)', IDX.move, [IDX.move]],
    ['a step another step depends on (cylinder)', IDX.cyl, [IDX.cyl, IDX.move]],
  ] as const) {
    it(label, () => {
      const doc = recorded();
      const result = execute(doc, 'delete_step', { stepId: stepId(doc, index) });
      expect(result.summary).toContain(`step '${stepId(doc, index)}' deleted; regenerated`);
      expect(result.document.featureHistory).toHaveLength(RECIPE.length - 1);
      expect(result.document.featureHistory.map((s) => s.id)).not.toContain(stepId(doc, index));
      expect(recipeState(result.document)).toEqual(recipeState(buildRecipe(without(...dropped))));
      expect(result.affected).toEqual(result.document.order);
    });
  }

  it('warns about a step that no longer changes anything', () => {
    const doc = recorded();
    const result = execute(doc, 'delete_step', { stepId: stepId(doc, IDX.cyl) });
    expect(result.summary).toContain('Warning: 1 step(s) no longer change the document');
    expect(result.summary).toContain(`${stepId(doc, IDX.move)} (move_entities)`);
  });

  it('deleting a material keeps the box but drops the library entry', () => {
    const doc = recorded();
    const result = execute(doc, 'delete_step', { stepId: stepId(doc, IDX.material) });
    expect(result.document.materials['steel']).toBeUndefined();
    expect(Object.keys(result.document.entities)).toHaveLength(3);
  });

  it('is pure and refuses an unknown step', () => {
    const doc = recorded();
    expectPure(doc, () => execute(doc, 'delete_step', { stepId: stepId(doc, IDX.cyl) }));
    expectNoOp(execute(doc, 'delete_step', { stepId: 'step-999' }), doc, "step 'step-999' not found");
  });
});

describe('set_step_suppressed equals the recipe without that step', () => {
  for (const [label, index, dropped] of [
    ['a leaf step', IDX.ball, [IDX.ball]],
    ['the material assignment', IDX.assign, [IDX.assign]],
    ['the box that the assignment needs', IDX.box, [IDX.box, IDX.assign]],
  ] as const) {
    it(label, () => {
      const doc = recorded();
      const result = execute(doc, 'set_step_suppressed', { stepId: stepId(doc, index), suppressed: true });
      expect(result.summary).toContain(`step '${stepId(doc, index)}' suppressed=true; regenerated`);
      expect(result.document.featureHistory[index]!.suppressed).toBe(true);
      expect(result.document.featureHistory).toHaveLength(RECIPE.length);
      expect(recipeState(result.document).geometry).toEqual(recipeState(buildRecipe(without(...dropped))).geometry);
    });
  }

  it('un-suppressing restores the original document', () => {
    const doc = recorded();
    const off = execute(doc, 'set_step_suppressed', { stepId: stepId(doc, IDX.box), suppressed: true }).document;
    expect(Object.keys(off.entities)).toHaveLength(2);
    const back = execute(off, 'set_step_suppressed', { stepId: stepId(doc, IDX.box), suppressed: false });
    expect(back.summary).toContain('suppressed=false');
    expect(back.document.featureHistory[IDX.box]!.suppressed).toBe(false);
    expect(recipeState(back.document)).toEqual(recipeState(doc));
  });

  it('is pure and refuses an unknown step', () => {
    const doc = recorded();
    expectPure(doc, () => execute(doc, 'set_step_suppressed', { stepId: stepId(doc, 3), suppressed: true }));
    expectNoOp(execute(doc, 'set_step_suppressed', { stepId: 'nope', suppressed: true }), doc, 'not found');
  });
});

describe('reorder_step equals the recipe with the step moved', () => {
  for (const [label, from, to] of [
    ['the sphere to the front', IDX.ball, 0],
    ['the sphere before the cylinder', IDX.ball, IDX.cyl],
    ['the cylinder after the sphere', IDX.cyl, IDX.ball],
    ['the box down one place', IDX.box, IDX.cyl],
    ['the move before the cylinder it moves', IDX.move, IDX.cyl],
  ] as const) {
    it(label, () => {
      const doc = recorded();
      const result = execute(doc, 'reorder_step', { stepId: stepId(doc, from), newIndex: to });
      expect(result.summary).toContain(`step '${stepId(doc, from)}' moved from index ${from} to ${to}; regenerated`);
      expect(result.document.featureHistory[to]!.id).toBe(stepId(doc, from));
      expect(result.document.featureHistory).toHaveLength(RECIPE.length);
      expect(recipeState(result.document)).toEqual(recipeState(buildRecipe(moved(from, to))));
    });
  }

  it('moving a step back and forth restores the original', () => {
    const doc = recorded();
    const there = execute(doc, 'reorder_step', { stepId: stepId(doc, IDX.ball), newIndex: 0 }).document;
    const back = execute(there, 'reorder_step', { stepId: stepId(doc, IDX.ball), newIndex: IDX.ball }).document;
    expect(back.featureHistory.map((s) => s.id)).toEqual(doc.featureHistory.map((s) => s.id));
    expect(recipeState(back)).toEqual(recipeState(doc));
  });

  it('clamps a negative index to the front and refuses a move onto the same index', () => {
    const doc = recorded();
    const front = execute(doc, 'reorder_step', { stepId: stepId(doc, IDX.ball), newIndex: -5 });
    expect(front.document.featureHistory[0]!.id).toBe(stepId(doc, IDX.ball));
    expectNoOp(execute(doc, 'reorder_step', { stepId: stepId(doc, IDX.cyl), newIndex: IDX.cyl }), doc, 'already at index 1');
    expectNoOp(execute(doc, 'reorder_step', { stepId: 'nope', newIndex: 0 }), doc, 'not found');
    expectPure(doc, () => execute(doc, 'reorder_step', { stepId: stepId(doc, IDX.ball), newIndex: 0 }));
  });
});

describe('edit_step_params equals the recipe with the step params replaced', () => {
  const edit = (index: number, params: Record<string, unknown>): RecipeStep[] =>
    RECIPE.map((s, i) => (i === index ? { ...s, params: { ...s.params, ...params } } : s));
  const stepParams = (doc: CadDocument, index: number): Record<string, unknown> =>
    doc.featureHistory[index]!.params as Record<string, unknown>;

  it('a primitive dimension', () => {
    const doc = recorded();
    const params = { ...stepParams(doc, IDX.cyl), radius: 3 };
    const result = execute(doc, 'edit_step_params', { stepId: stepId(doc, IDX.cyl), params });
    expect(result.summary).toContain(`step '${stepId(doc, IDX.cyl)}' params updated; regenerated 3 entities.`);
    expect(recipeState(result.document)).toEqual(recipeState(buildRecipe(edit(IDX.cyl, { radius: 3 }))));
    expect(result.document.featureHistory[IDX.cyl]!.name).toBe('add_cylinder');
  });

  it('a size that reads a parameter through =expr follows the parameter afterwards', () => {
    const doc = execute(recorded(), 'set_parameter', { name: 'w', expression: '10' }).document;
    const edited = execute(doc, 'edit_step_params', { stepId: stepId(doc, IDX.box), params: { size: ['=w', 4, 2] } });
    expect(recipeState(edited.document).geometry).toEqual(recipeState(buildRecipe(edit(IDX.box, { size: [10, 4, 2] }))).geometry);
    const wider = execute(edited.document, 'set_parameter', { name: 'w', expression: '25' });
    expect(wider.summary).toContain('25');
    expect(recipeState(wider.document).geometry).toEqual(recipeState(buildRecipe(edit(IDX.box, { size: [25, 4, 2] }))).geometry);
    const gone = execute(wider.document, 'set_step_suppressed', { stepId: stepId(doc, IDX.box), suppressed: true });
    expect(Object.keys(gone.document.entities)).toHaveLength(2);
  });

  it('a move delta the recorded cylinder follows', () => {
    const doc = recorded();
    const params = { ...stepParams(doc, IDX.move), delta: [1, 2, 3] };
    const result = execute(doc, 'edit_step_params', { stepId: stepId(doc, IDX.move), params });
    expect(recipeState(result.document)).toEqual(recipeState(buildRecipe(edit(IDX.move, { delta: [1, 2, 3] }))));
  });

  it('a material colour carried to the entity that uses it', () => {
    const doc = recorded();
    const params = { ...stepParams(doc, IDX.material), color: '#ff0000' };
    const result = execute(doc, 'edit_step_params', { stepId: stepId(doc, IDX.material), params });
    expect(result.document.materials['steel']?.color).toBe('#ff0000');
    expect(recipeState(result.document)).toEqual(recipeState(buildRecipe(edit(IDX.material, { color: '#ff0000' }))));
  });

  it('refuses params the command rejects, naming the step, and refuses an unknown step', () => {
    const doc = recorded();
    const bad = execute(doc, 'edit_step_params', { stepId: stepId(doc, IDX.cyl), params: { radius: -1, height: 5 } });
    expectNoOp(bad, doc, `step '${stepId(doc, IDX.cyl)}' (add_cylinder) changed nothing when replayed`);
    expect(bad.summary).toContain('History unchanged.');
    expectNoOp(execute(doc, 'edit_step_params', { stepId: 'nope', params: {} }), doc, 'not found');
    expectPure(doc, () => execute(doc, 'edit_step_params', { stepId: stepId(doc, IDX.cyl), params: { radius: 3, height: 5 } }));
  });

  it('a suppressed step accepts any params without being applied', () => {
    const doc = recorded();
    const off = execute(doc, 'set_step_suppressed', { stepId: stepId(doc, IDX.ball), suppressed: true }).document;
    const result = execute(off, 'edit_step_params', { stepId: stepId(doc, IDX.ball), params: { radius: -1 } });
    expect(result.affected).toEqual(result.document.order);
    expect(result.document.featureHistory[IDX.ball]!.params).toEqual({ radius: -1 });
    expect(Object.keys(result.document.entities)).toHaveLength(2);
  });
});

describe('insert_step equals the recipe with the step spliced in', () => {
  const extra: RecipeStep = { command: 'add_box', params: { size: [1, 1, 1], position: [-10, 0, 0] } };
  const spliced = (after: number): RecipeStep[] => [...RECIPE.slice(0, after + 1), extra, ...RECIPE.slice(after + 1)];

  it('after a given step', () => {
    const doc = recorded();
    const result = execute(doc, 'insert_step', {
      afterStepId: stepId(doc, IDX.cyl),
      name: extra.command,
      params: extra.params,
      label: 'Extra',
    });
    expect(result.summary).toMatch(/step 'step-\d+' \(add_box\) inserted; regenerated 4 entities\./);
    const history = result.document.featureHistory;
    expect(history).toHaveLength(RECIPE.length + 1);
    expect(history[IDX.cyl + 1]).toMatchObject({ name: 'add_box', suppressed: false, label: 'Extra' });
    expect(recipeState(result.document)).toEqual(recipeState(buildRecipe(spliced(IDX.cyl))));
  });

  it('at the end when afterStepId is omitted, and never reuses a step number', () => {
    const doc = recorded();
    const result = execute(doc, 'insert_step', { name: extra.command, params: extra.params });
    const history = result.document.featureHistory;
    expect(history[history.length - 1]!.name).toBe('add_box');
    expect(history[history.length - 1]!.label).toBeUndefined();
    expect(recipeState(result.document)).toEqual(recipeState(buildRecipe([...RECIPE, extra])));
    expect(new Set(history.map((s) => s.id)).size).toBe(history.length);
    expect(result.document.nextStepNumber).toBe((doc.nextStepNumber ?? 1) + 1);
    const again = execute(result.document, 'insert_step', { name: extra.command, params: { size: [2, 2, 2] } });
    expect(new Set(again.document.featureHistory.map((s) => s.id)).size).toBe(history.length + 1);
  });

  it('the first position cannot be targeted by id, but insert after the first step works', () => {
    const doc = recorded();
    const result = execute(doc, 'insert_step', { afterStepId: stepId(doc, 0), name: extra.command, params: extra.params });
    expect(recipeState(result.document)).toEqual(recipeState(buildRecipe(spliced(0))));
  });

  it('refuses an unknown anchor and params the command rejects', () => {
    const doc = recorded();
    expectNoOp(execute(doc, 'insert_step', { afterStepId: 'nope', name: 'add_box', params: {} }), doc, "afterStepId 'nope' not found");
    const bad = execute(doc, 'insert_step', { name: 'add_box', params: { size: [-1, 1, 1] } });
    expectNoOp(bad, doc, 'changed nothing when replayed');
    expectPure(doc, () => execute(doc, 'insert_step', { name: extra.command, params: extra.params }));
  });
});

describe('sequences of edits stay equal to a from-scratch rebuild', () => {
  it('suppress, reorder, edit, insert and delete in turn', () => {
    let doc = recorded();
    doc = execute(doc, 'reorder_step', { stepId: stepId(doc, IDX.ball), newIndex: 1 }).document;
    let expected = moved(IDX.ball, 1);
    expect(recipeState(doc)).toEqual(recipeState(buildRecipe(expected)));
    doc = execute(doc, 'delete_step', { stepId: stepId(doc, 1) }).document;
    expected = expected.filter((s) => s.as !== 'ball');
    expect(recipeState(doc)).toEqual(recipeState(buildRecipe(expected)));
    doc = execute(doc, 'insert_step', { afterStepId: stepId(doc, 0), name: 'add_sphere', params: { radius: 1 } }).document;
    expected = [expected[0]!, { command: 'add_sphere', params: { radius: 1 } }, ...expected.slice(1)];
    expect(recipeState(doc)).toEqual(recipeState(buildRecipe(expected)));
    doc = execute(doc, 'set_step_suppressed', { stepId: stepId(doc, 1), suppressed: true }).document;
    expect(recipeState(doc).geometry).toEqual(recipeState(buildRecipe(expected.filter((_, i) => i !== 1))).geometry);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(recipeState(replayed)).toEqual(recipeState(doc));
  });
});
