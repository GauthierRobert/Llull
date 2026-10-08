/** Regression tests for the final migration review (S2, S3, S4, S7, N2, N5). */
import { describe, it, expect, afterEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { BoxEntity, CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { currentContext, defaultContext, runInContext } from '@core/commands/context';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { installPlugin } from '@core/plugins/host';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandDefinition } from '@core/commands/types';
import { nextId, withIdSource } from '@lib/id';
import { fakeKernel } from '../../helpers/fakeKernel';

const TRIANGLE: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
const triangleKernel: GeometryKernel = fakeKernel({
  solid: TRIANGLE,
  boolean: TRIANGLE,
  fillet: TRIANGLE,
});

function boxOf(doc: CadDocument): BoxEntity {
  return Object.values(doc.entities).find((e) => e.kind === 'box') as BoxEntity;
}

afterEach(() => setGeometryKernel(null));

describe('S2: replay cache never shares a minted building uid between documents', () => {
  it('two fresh documents inserting the same wall get different uids', () => {
    const insert = (): CadDocument =>
      execute(createEmptyDocument(), 'insert_step', {
        name: 'add_wall',
        params: { start: [0, 0], end: [5000, 0] },
      }).document;
    const a = insert();
    const b = insert();
    expect(a.building?.uid).toBeDefined();
    expect(b.building?.uid).toBeDefined();
    expect(a.building?.uid).not.toBe(b.building?.uid);
  });
});

describe('S3: set_parameter regenerates through recipes and constraints', () => {
  it('a recipe instance that reads the parameter is regenerated', () => {
    let doc = execute(createEmptyDocument(), 'set_parameter', {
      name: 'w',
      expression: '2',
    }).document;
    doc = execute(doc, 'build_project', {
      actions: [{ command: 'add_box', params: { size: ['=w', 1, 1] } }],
    }).document;
    doc = execute(doc, 'save_recipe', { name: 'bar' }).document;
    doc = execute(doc, 'delete_step', { stepId: doc.featureHistory[0]?.id ?? '' }).document;
    doc = execute(doc, 'instantiate_recipe', { name: 'bar' }).document;
    expect(doc.featureHistory.map((s) => s.name)).toEqual(['instantiate_recipe']);
    const result = execute(doc, 'set_parameter', { name: 'w', expression: '7' });
    expect(boxOf(result.document).size[0]).toBe(7);
  });
});

describe('S4/S7: history operations refuse without a kernel instead of reporting success', () => {
  function unionHistory(): CadDocument {
    let doc = createEmptyDocument();
    const ctx = { ...defaultContext(), kernel: triangleKernel };
    const a = execute(doc, 'add_box', { size: [2, 2, 2] }, ctx);
    doc = a.document;
    const b = execute(doc, 'add_box', { size: [2, 2, 2], position: [1, 0, 0] }, ctx);
    doc = b.document;
    return execute(doc, 'boolean_union', { a: a.affected[0], b: b.affected[0] }, ctx).document;
  }

  it('edit_step_params / set_step_suppressed / insert_step no-op with an explicit summary', () => {
    const doc = unionHistory();
    const first = doc.featureHistory[0]?.id ?? '';
    for (const [name, params] of [
      ['edit_step_params', { stepId: first, params: { size: [3, 3, 3] } }],
      ['set_step_suppressed', { stepId: first, suppressed: true }],
      ['insert_step', { name: 'add_sphere', params: { radius: 1 } }],
    ] as const) {
      const result = execute(doc, name, params);
      expect(result.document, name).toBe(doc);
      expect(result.summary, name).toContain('needs the geometry kernel');
    }
  });

  it('instantiate_recipe refuses a recipe containing a kernel step', () => {
    const saved = execute(unionHistory(), 'save_recipe', { name: 'u' }).document;
    const result = execute(saved, 'instantiate_recipe', { name: 'u' });
    expect(result.document).toBe(saved);
    expect(result.summary).toContain('needs the geometry kernel');
  });
});

describe('N2: a plugin listing a command twice is refused', () => {
  it('throws and registers nothing', () => {
    const command = defineCommand({
      name: 'review_dup_cmd',
      description: 'Dup.',
      params: z.object({}),
      run: (doc) => ({ document: doc, summary: '', affected: [] }),
    }) as CommandDefinition<unknown>;
    expect(() =>
      installPlugin({ name: 'review-dup', toolset: 'test', commands: [command, command] }),
    ).toThrow(/review_dup_cmd/);
  });
});

describe('N5: context and id source are restored when a command throws', () => {
  it('runInContext / withIdSource restore the outer scope', () => {
    const outer = currentContext();
    expect(() =>
      runInContext({ ...outer, ids: { next: () => 'inner' } }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(currentContext().ids).toBe(outer.ids);
    expect(() =>
      withIdSource({ next: () => 'inner' }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(nextId('x')).not.toBe('inner');
  });
});
