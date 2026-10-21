/**
 * SC-Q4b: history meta-commands on a constrained sketch. Constraints are regenerated state (not carried), so deleting, suppressing,
 * editing or reordering a constraint step must equal rebuilding the edited recipe from scratch.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { buildRecipe, recipeState, type RecipeStep } from './historyRecipe';

const lineRef = (alias: string): { entityId: string } => ({ entityId: `$${alias}` });

const SKETCH: RecipeStep[] = [
  {
    command: 'draw_polyline',
    params: {
      points: [
        [0, 0],
        [10, 1],
      ],
    },
    as: 'a',
  },
  {
    command: 'draw_polyline',
    params: {
      points: [
        [0, 5],
        [10, 7],
      ],
    },
    as: 'b',
  },
  { command: 'add_constraint', params: { constraint: { kind: 'parallel', a: lineRef('a'), b: lineRef('b') } } },
  { command: 'add_constraint', params: { constraint: { kind: 'distance', a: lineRef('a'), b: lineRef('b'), value: 4 } } },
  { command: 'solve_constraints', params: {} },
];

const sketch = (): CadDocument => buildRecipe(SKETCH);
const stepId = (doc: CadDocument, index: number): string => doc.featureHistory[index]!.id;
const state = (doc: CadDocument): unknown => ({ ...recipeState(doc), constraints: doc.constraintOrder.length });
const withDistance = (value: number): RecipeStep[] =>
  SKETCH.map((s, i) => (i === 3 ? { ...s, params: { constraint: { ...(s.params['constraint'] as object), value } } } : s));

describe('history edits on a constrained sketch', () => {
  it('records every command as a step and replays to the same constraints', () => {
    const doc = sketch();
    expect(doc.featureHistory.map((s) => s.name)).toEqual(SKETCH.map((s) => s.command));
    expect(doc.constraintOrder).toHaveLength(2);
    const replayed = execute(doc, 'replay_history', {}).document;
    expect(state(replayed)).toEqual(state(doc));
  });

  const editDistance = (doc: CadDocument, value: number): ReturnType<typeof execute> => {
    const params = doc.featureHistory[3]!.params as { constraint: Record<string, unknown> };
    return execute(doc, 'edit_step_params', { stepId: stepId(doc, 3), params: { constraint: { ...params.constraint, value } } });
  };

  const cases: [string, (doc: CadDocument) => ReturnType<typeof execute>, RecipeStep[]][] = [
    ['delete the distance constraint', (d) => execute(d, 'delete_step', { stepId: stepId(d, 3) }), SKETCH.filter((_, i) => i !== 3)],
    [
      'suppress the parallel constraint',
      (d) => execute(d, 'set_step_suppressed', { stepId: stepId(d, 2), suppressed: true }),
      SKETCH.filter((_, i) => i !== 2),
    ],
    ['delete the solve step', (d) => execute(d, 'delete_step', { stepId: stepId(d, 4) }), SKETCH.slice(0, 4)],
    ['edit the distance value', (d) => editDistance(d, 6), withDistance(6)],
    [
      'move the solve before the distance',
      (d) => execute(d, 'reorder_step', { stepId: stepId(d, 4), newIndex: 3 }),
      [SKETCH[0]!, SKETCH[1]!, SKETCH[2]!, SKETCH[4]!, SKETCH[3]!],
    ],
  ];
  for (const [label, run, edited] of cases) {
    it(`${label} equals the rebuilt recipe`, () => {
      const result = run(sketch());
      expect(result.affected.length).toBeGreaterThan(0);
      expect(state(result.document)).toEqual(state(buildRecipe(edited)));
    });
  }

  it('the edited distance moves the second line to the new offset', () => {
    const doc = sketch();
    const narrow = state(editDistance(doc, 2).document);
    const wide = state(editDistance(doc, 8).document);
    expect(narrow).not.toEqual(wide);
    expect(narrow).toEqual(state(buildRecipe(withDistance(2))));
    expect(wide).toEqual(state(buildRecipe(withDistance(8))));
  });
});
