/** Plant 01 PSC: spec and catalogue ids are user keys. The command guard refuses reserved ids (`constructor`, `__proto__`, `toString` ...) in params; the stores also never find them through the prototype chain. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { allCatalogs, findCatalog } from '@aec/plant/catalog/store';
import { latestSpec, specRevisions } from '@aec/plant/spec/store';
import { importedDoc } from './specFixture';

const HOSTILE = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
const doc = importedDoc();
const sizeArgs = { nps: 4 };

const SPEC_COMMANDS: Array<[string, (specId: string) => Record<string, unknown>]> = [
  ['diff_pipe_spec', (specId) => ({ specId, fromRevision: 1 })],
  ['resolve_joint', (specId) => ({ specId, ...sizeArgs, endA: 'FL', endB: 'FL' })],
  ['component_shape', (specId) => ({ specId, type: 'elbow90', ...sizeArgs })],
  ['resolve_spec_component', (specId) => ({ specId, type: 'pipe', ...sizeArgs })],
  ['resolve_branch', (specId) => ({ specId, headerNps: 6, branchNps: 4 })],
  ['check_pipe_spec', (specId) => ({ specId })],
  ['list_pipe_specs', (specId) => ({ specId })],
  ['export_pipe_spec', (specId) => ({ specId })],
  ['edit_pipe_spec', (specId) => ({ specId, ops: [{ op: 'setHeader', fields: { title: 'x' } }] })],
  ['assign_pipe_spec', (specId) => ({ specId, pipeId: 'p1', nps: 4 })],
];

describe('hostile spec ids', () => {
  for (const [name, params] of SPEC_COMMANDS)
    it.each(HOSTILE)(`${name} refuses specId %s without throwing`, (id) => {
      const guarded = execute(doc, name, params(id));
      expect(guarded.rejected, guarded.summary).toBe(true);
      expect(guarded.document).toBe(doc);
      expect(guarded.error?.code).toBe('CMD_RESERVED_ID');
    });

  it('finds no revisions for an inherited key', () => {
    for (const id of HOSTILE) {
      expect(specRevisions(doc, id)).toBeUndefined();
      expect(latestSpec(doc, id)).toBeUndefined();
    }
  });
});

describe('hostile catalogue references (spec.catalogs entries are data, not params)', () => {
  it.each(HOSTILE)('findCatalog and allCatalogs ignore the inherited key %s', (id) => {
    expect(findCatalog(createEmptyDocument(), id)).toBeUndefined();
    expect(findCatalog(createEmptyDocument(), `${id}@1`)).toBeUndefined();
    expect(allCatalogs(createEmptyDocument())).toHaveLength(1);
  });
});
