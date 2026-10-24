import { describe, expect, it } from 'vitest';
import { type CadDocument, type SubdivisionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

const run = (doc: CadDocument, name: string, params: object): ReturnType<typeof execute> =>
  execute(doc, name, params as Record<string, unknown>);

/** A cage with `drags` successive soft edits of the same vertex after its creation. */
function dragged(drags: number): CadDocument {
  let doc = run(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 2, id: 'g' }).document;
  for (let i = 0; i < drags; i++)
    doc = run(doc, 'edit_subdivision_cage', { id: 'g', vertexIndices: [2], translate: [0, 0, 0.1], falloff: 1.5 }).document;
  return doc;
}

describe('squash_steps', () => {
  const doc = dragged(5);
  const ids = doc.featureHistory.map((s) => s.id);

  it('merges consecutive edits of one entity into one step and keeps the document identical', () => {
    const result = run(doc, 'squash_steps', { fromStepId: ids[1], toStepId: ids[5], label: 'drag' });
    expect(result.summary).toContain('merged');
    const history = result.document.featureHistory;
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ id: ids[1], name: 'build_project', label: 'drag' });
    expect((history[1]?.params as { actions: unknown[] }).actions).toHaveLength(5);
    expect(result.document.entities).toEqual(doc.entities);
    expect(result.document.order).toEqual(doc.order);
    expect(result.document.nextStepNumber).toBe(doc.nextStepNumber);
    expect(result.affected).toEqual(['g']);
  });

  it('the merged history replays to the same document', () => {
    const squashed = run(doc, 'squash_steps', { fromStepId: ids[2], toStepId: ids[4] }).document;
    const replayed = run(squashed, 'replay_history', {}).document;
    expect((replayed.entities['g'] as SubdivisionEntity).vertices).toEqual((doc.entities['g'] as SubdivisionEntity).vertices);
    expect(replayed.featureHistory).toHaveLength(squashed.featureHistory.length);
  });

  it('flattens an already squashed step and keeps the first label', () => {
    const once = run(doc, 'squash_steps', { fromStepId: ids[1], toStepId: ids[2], label: 'first' }).document;
    const twice = run(once, 'squash_steps', { fromStepId: ids[1], toStepId: ids[3] });
    expect((twice.document.featureHistory[1]?.params as { actions: unknown[] }).actions).toHaveLength(3);
    expect(twice.document.featureHistory[1]?.label).toBe('first');
  });

  it('refuses to merge steps that create ids, keeping the history unchanged', () => {
    const extruded = run(doc, 'extrude_cage_faces', { id: 'g', faces: [0], distance: 1 }).document;
    const more = run(extruded, 'edit_subdivision_cage', { id: 'g', vertexIndices: [3], translate: [0, 0, 0.1] }).document;
    const steps = more.featureHistory.map((s) => s.id);
    const result = run(more, 'squash_steps', { fromStepId: steps[5], toStepId: steps[6] });
    expectNoOp(result, more, 'would change the document');
  });

  it('refuses bad ranges, suppressed steps and a replay that fails', () => {
    expectNoOp(run(doc, 'squash_steps', { fromStepId: 'step-99', toStepId: ids[2] }), doc, 'not found');
    expectNoOp(run(doc, 'squash_steps', { fromStepId: ids[1], toStepId: 'step-99' }), doc, 'not found');
    expectNoOp(run(doc, 'squash_steps', { fromStepId: ids[3], toStepId: ids[3] }), doc, 'must come before');
    expectNoOp(run(doc, 'squash_steps', { fromStepId: ids[3], toStepId: ids[1] }), doc, 'must come before');
    const hidden = run(doc, 'set_step_suppressed', { stepId: ids[2], suppressed: true }).document;
    expectNoOp(run(hidden, 'squash_steps', { fromStepId: ids[1], toStepId: ids[3] }), hidden, 'suppressed');
    const broken: CadDocument = {
      ...doc,
      featureHistory: doc.featureHistory.map((s, i) =>
        i === 3 ? { ...s, params: { id: 'missing', vertexIndices: [2], translate: [0, 0, 1] } } : s,
      ),
    };
    expectNoOp(run(broken, 'squash_steps', { fromStepId: ids[1], toStepId: ids[4] }), broken);
  });

  it('keeps the label of the first step, and refuses a range that needs a kernel when there is none', () => {
    const labelled: CadDocument = {
      ...doc,
      featureHistory: doc.featureHistory.map((s, i) => (i === 1 ? { ...s, label: 'first drag' } : s)),
    };
    const kept = run(labelled, 'squash_steps', { fromStepId: ids[1], toStepId: ids[2] });
    expect(kept.document.featureHistory[1]?.label).toBe('first drag');
    const needsKernel: CadDocument = {
      ...doc,
      featureHistory: doc.featureHistory.map((s, i) => (i === 2 ? { ...s, name: 'push_pull_face' } : s)),
    };
    const refused = execute(needsKernel, 'squash_steps', { fromStepId: ids[1], toStepId: ids[3] }, { ...defaultContext(), kernel: null });
    expectNoOp(refused, needsKernel, 'needs the geometry kernel');
  });

  it('is pure', () => {
    expectPure(doc, () => run(doc, 'squash_steps', { fromStepId: ids[1], toStepId: ids[5] }));
  });
});
