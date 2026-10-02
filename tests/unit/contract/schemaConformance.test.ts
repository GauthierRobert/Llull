/**
 * Schema conformance: params synthesized from each command's own `paramsSchema`
 * (required props, first enum value, sample numbers/strings, ids of a seeded entity) must
 * never make `run` throw. A throw here means the schema advertises a shape the command
 * cannot consume — schema/params drift that agents would hit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import type { ParamItemSpec, ParamSpec } from '@core/commands/types';
import { execute, listCommands } from '@core/commands/registry';

const ID_KEY = /^id$|Id$/;
const IDS_KEY = /Ids$|^ids$/;

function seeded(): { doc: CadDocument; entityId: string } {
  let doc = createEmptyDocument();
  const box = execute(doc, 'add_box', { size: [10, 10, 10] });
  doc = box.document;
  doc = execute(doc, 'draw_rectangle', { corner: [0, 0], width: 10, height: 5 }).document;
  return { doc, entityId: box.affected[0] ?? 'missing' };
}

function sample(spec: ParamSpec | ParamItemSpec, key: string, entityId: string): unknown {
  if (spec.enum && spec.enum.length > 0) return spec.enum[0];
  switch (spec.type) {
    case 'number':
      return 1;
    case 'boolean':
      return false;
    case 'string':
      return ID_KEY.test(key) ? entityId : 'sample';
    case 'array':
      if (IDS_KEY.test(key)) return [entityId];
      return spec.items ? [sample(spec.items, key, entityId)] : [];
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const name of spec.required ?? []) {
        const child = spec.properties?.[name];
        if (child) object[name] = sample(child, name, entityId);
      }
      return object;
    }
  }
}

describe('schema conformance: schema-shaped params never make a command throw', () => {
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  for (const def of listCommands()) {
    it(def.name, () => {
      const { doc, entityId } = seeded();
      const params: Record<string, unknown> = {};
      for (const name of def.paramsSchema.required) {
        const spec = def.paramsSchema.properties[name];
        if (spec) params[name] = sample(spec, name, entityId);
      }
      const result = execute(doc, def.name, params);
      const threw = warn.mock.calls.some((call) => String(call[0]).startsWith('[llull] command'));
      expect(threw, `${def.name} threw on ${JSON.stringify(params)}: ${result.summary}`).toBe(
        false,
      );
    });
  }
});
