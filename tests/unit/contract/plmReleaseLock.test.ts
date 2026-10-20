/** TR-PLM-30: on a released document, every registered mutating command is refused or leaves the release scope untouched. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { ParamItemSpec, ParamSpec } from '@core/commands/types';
import { execute, listCommands } from '@core/commands/registry';
import { releaseScopeJson } from '@core/commands/persistence/releaseScope';
import { released } from '../plm/fixtures';

const SKIPPED = new Set(['clear_document', 'load_document']);
const ID_KEYS = new Set(['id', 'ids', 'entityId', 'entityIds', 'target', 'sourceId']);

/** A minimal value of `spec` (strings "x", numbers 1, first enum member, one-element arrays, required properties only). */
function sample(spec: ParamItemSpec, key: string, entityId: string): unknown {
  if (spec.enum !== undefined && spec.enum.length > 0) return spec.enum[0];
  if (spec.anyOf !== undefined && spec.anyOf[0] !== undefined) return sample(spec.anyOf[0], key, entityId);
  switch (spec.type) {
    case 'string':
      return ID_KEYS.has(key) ? entityId : 'x';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [spec.items === undefined ? entityId : sample(spec.items, key, entityId)];
    case 'object': {
      const properties = spec.properties ?? {};
      const required = spec.required ?? [];
      return Object.fromEntries(required.map((name) => [name, sample(properties[name] ?? { type: 'string' }, name, entityId)]));
    }
    default:
      return entityId;
  }
}

function minimalParams(properties: Record<string, ParamSpec>, required: readonly string[], entityId: string): Record<string, unknown> {
  return Object.fromEntries(
    required.map((name) => [name, sample(properties[name] ?? { type: 'string', description: '' }, name, entityId)]),
  );
}

describe('release lock over the whole registry (VC-PLM-03, TR-PLM-30)', () => {
  const doc: CadDocument = released();
  const scope = releaseScopeJson(doc);
  const entityId = doc.order[0] ?? 'box-2.1';
  const mutating = listCommands().filter(
    (command) =>
      !SKIPPED.has(command.name) &&
      command.annotations?.readOnly !== true &&
      command.annotations?.metaHistory !== true &&
      command.annotations?.session !== true,
  );

  it('refuses or leaves the definition untouched for every mutating command', () => {
    expect(mutating.length).toBeGreaterThan(100);
    const leaks: string[] = [];
    let locked = 0;
    for (const command of mutating) {
      const attempts = [{}, minimalParams(command.paramsSchema.properties, command.paramsSchema.required, entityId)];
      for (const params of attempts) {
        const result = execute(doc, command.name, params);
        if (result.error?.code === 'PLM_LOCKED') locked += 1;
        if (releaseScopeJson(result.document) !== scope) leaks.push(`${command.name} ${JSON.stringify(params)}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(locked, 'the guard must actually refuse a good share of the commands').toBeGreaterThan(10);
  });

  it('a command whose own result equals its input is still refused: the recorded feature step is a change (execute re-checks the guards)', () => {
    const noOpScale = execute(doc, 'scale_entity', { id: entityId, factor: 1 });
    expect(noOpScale.error?.code).toBe('PLM_LOCKED');
    expect(noOpScale.document).toBe(doc);
  });

  it('is pure: a refused or accepted command never mutates its input', () => {
    const before = JSON.stringify(doc);
    for (const name of ['add_box', 'set_parameter', 'set_item_marking', 'create_change_request']) {
      execute(
        doc,
        name,
        name === 'set_parameter'
          ? { name: 't', expression: '9' }
          : name === 'add_box'
            ? { size: [1, 1, 1] }
            : name === 'set_item_marking'
              ? { regime: 'none', decidedBy: 'u' }
              : { title: 't', reason: 'r' },
      );
    }
    expect(JSON.stringify(doc)).toBe(before);
  });
});
