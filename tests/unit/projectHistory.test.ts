import { describe, it, expect } from 'vitest';
import { type CadDocument, type BoxEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { executeRecorded } from '@core/commands/record';

function project(doc: CadDocument, actions: unknown[]): ReturnType<typeof execute> {
  return execute(doc, 'build_project', { actions });
}

function boxes(doc: CadDocument): BoxEntity[] {
  return Object.values(doc.entities).filter((e): e is BoxEntity => e.kind === 'box');
}

describe('build_project feature history', () => {
  it('records the inner steps only; replay_history builds exactly the solids once', () => {
    const built = project(createEmptyDocument(), [
      { command: 'add_box', params: { size: [1, 1, 1] } },
      { command: 'add_sphere', params: { radius: 2 } },
    ]);
    expect(built.affected).toHaveLength(2);
    const names = built.document.featureHistory.map((s) => s.name);
    expect(names).toEqual(['add_box', 'add_sphere']);
    expect(names).not.toContain('build_project');

    const replayed = execute(built.document, 'replay_history', {}).document;
    expect(replayed.order).toHaveLength(2);
    expect(Object.keys(replayed.entities)).toHaveLength(2);
    expect(replayed.featureHistory.map((s) => s.name)).toEqual(['add_box', 'add_sphere']);
  });

  it('keeps parameter-driven =expr in the history so set_parameter + replay_history resizes', () => {
    const built = project(createEmptyDocument(), [
      { command: 'set_parameter', params: { name: 'W', expression: '10' } },
      { command: 'add_box', params: { size: ['=W', 4, 4] } },
      { command: 'add_box', params: { size: [1, 1, 1] } },
    ]);
    const params = built.document.featureHistory[0]!.params as { size: unknown[] };
    expect(params.size).toEqual(['=W', 4, 4]);
    expect(
      boxes(built.document)
        .map((b) => b.size[0])
        .sort((a, b) => a - b),
    ).toEqual([1, 10]);

    let doc = execute(built.document, 'set_parameter', { name: 'W', expression: '25' }).document;
    doc = execute(doc, 'replay_history', {}).document;
    expect(boxes(doc)).toHaveLength(2);
    expect(
      boxes(doc)
        .map((b) => b.size[0])
        .sort((a, b) => a - b),
    ).toEqual([1, 25]);
  });

  it('does not append build_project itself, even when the plan is rolled back or empty', () => {
    const empty = project(createEmptyDocument(), []);
    expect(empty.document.featureHistory).toEqual([]);
    const doc = createEmptyDocument();
    const failed = project(doc, [{ command: 'add_box', params: { size: [-1, 1, 1] } }]);
    expect(failed.document).toBe(doc);
    expect(failed.affected).toEqual([]);
  });

  it('records resolved ids (not $alias) for cross-step references', () => {
    const built = project(createEmptyDocument(), [
      { command: 'add_box', as: 'b', params: { size: [1, 1, 1] } },
      { command: 'move_entity', params: { id: '$b', delta: [1, 0, 0] } },
    ]);
    const move = built.document.featureHistory[1]!.params as { id: string };
    expect(move.id).toBe(built.affected[0]);
  });

  describe('recordableParams', () => {
    it('records a $i loop expression as its numeric value, not the expression', () => {
      const built = project(createEmptyDocument(), [
        {
          repeat: { count: 3 },
          step: { command: 'add_box', params: { size: [1, 1, 1], position: ['=$i * 5', 0, 0] } },
        },
      ]);
      const recorded = built.document.featureHistory.map(
        (s) => (s.params as { position: unknown[] }).position,
      );
      expect(recorded).toEqual([
        [0, 0, 0],
        [5, 0, 0],
        [10, 0, 0],
      ]);
    });

    it('records for_each loop expressions ($as) as values', () => {
      const built = project(createEmptyDocument(), [
        {
          for_each: { values: [2, 4], as: 'r' },
          step: { command: 'add_sphere', params: { radius: '=$r * 2' } },
        },
      ]);
      expect(
        built.document.featureHistory.map((s) => (s.params as { radius: unknown }).radius),
      ).toEqual([4, 8]);
    });

    it('records an expression over a non-parameter identifier as its value', () => {
      const built = project(createEmptyDocument(), [
        {
          repeat: { count: 2 },
          step: { command: 'add_box', params: { size: ['=i + 1', 1, 1] } },
        },
      ]);
      expect(
        built.document.featureHistory.map((s) => (s.params as { size: unknown[] }).size[0]),
      ).toEqual([1, 2]);
    });

    it('keeps =expr in repeat bodies when it only references document parameters', () => {
      const built = project(createEmptyDocument(), [
        { command: 'set_parameter', params: { name: 'W', expression: '3' } },
        { repeat: { count: 2 }, step: { command: 'add_box', params: { size: ['=W * 2', 1, 1] } } },
      ]);
      expect(
        built.document.featureHistory.map((s) => (s.params as { size: unknown[] }).size[0]),
      ).toEqual(['=W * 2', '=W * 2']);
    });

    it('handles mixed nested structures (arrays of objects) without losing values', () => {
      const built = project(createEmptyDocument(), [
        { command: 'set_parameter', params: { name: 'H', expression: '6' } },
        {
          command: 'extrude_profile',
          params: {
            profile: [
              [0, 0],
              [4, 0],
              [4, '=H'],
            ],
            depth: '=H',
          },
        },
      ]);
      const params = built.document.featureHistory[0]!.params as {
        profile: unknown[][];
        depth: unknown;
      };
      expect(params.profile[2]).toEqual([4, '=H']);
      expect(params.depth).toBe('=H');
    });
  });
});

describe('executeRecorded', () => {
  it('replaces the params of the single step execute appended', () => {
    const doc = createEmptyDocument();
    const result = executeRecorded(doc, 'add_box', { size: [2, 2, 2] }, { size: ['=W', 2, 2] });
    expect(result.affected).toHaveLength(1);
    expect(result.document.featureHistory).toHaveLength(1);
    expect(result.document.featureHistory[0]).toMatchObject({
      name: 'add_box',
      params: { size: ['=W', 2, 2] },
      affected: result.affected,
    });
    expect(doc.featureHistory).toHaveLength(0);
  });

  it('returns a no-op untouched', () => {
    const doc = createEmptyDocument();
    const result = executeRecorded(doc, 'add_box', { size: [-1, 1, 1] }, { size: ['=W', 1, 1] });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('returns queries and meta-history commands untouched', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const query = executeRecorded(doc, 'export_code', { language: 'cadquery' }, { x: 1 });
    expect(query.document).toBe(doc);
    expect(query.document.featureHistory).toHaveLength(1);
    const meta = executeRecorded(doc, 'replay_history', {}, { x: 1 });
    expect(meta.document.featureHistory).toHaveLength(1);
    expect(meta.document.featureHistory[0]!.params).toEqual({ size: [1, 1, 1] });
  });

  it('keeps previous history steps and only rewrites the last one', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    doc = executeRecorded(doc, 'add_sphere', { radius: 3 }, { radius: '=R' }).document;
    expect(doc.featureHistory.map((s) => s.params)).toEqual([
      { size: [1, 1, 1] },
      { radius: '=R' },
    ]);
  });
});

describe('build_project + insert_step', () => {
  it('keeps the inserted step params (does not overwrite them with insert_step params)', () => {
    const result = execute(createEmptyDocument(), 'build_project', {
      actions: [
        { command: 'set_parameter', params: { name: 'w', expression: '10' } },
        {
          command: 'insert_step',
          params: { name: 'add_box', params: { size: ['=w', '=w', '=w'] } },
        },
      ],
    });
    expect(result.document.featureHistory.map((step) => step.params)).toEqual([
      { size: ['=w', '=w', '=w'] },
    ]);
  });
});
