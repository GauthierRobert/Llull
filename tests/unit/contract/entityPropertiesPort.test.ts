import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { defineCommand, z } from '@core/commands/schema';
import { entityPropertyProviders, installPlugin } from '@core/plugins/host';
import type { CadPlugin } from '@core/plugins/plugin';
import type { CommandDefinition } from '@core/commands/types';

/** Plugin property port (plant 09 VIS Q1): `CadPlugin.entityProperties` feeds `ctx.properties`; core keys always win. */
const seen: string[] = [];

const probe = defineCommand({
  name: 'test_property_probe',
  description: 'Read the property bag of an entity through ctx.properties (test plugin).',
  annotations: { readOnly: true },
  params: z.object({ entityId: z.string().describe('Entity id') }),
  run: (doc, { entityId }, ctx) => {
    seen.push(entityId);
    return { document: doc, summary: 'probe', affected: [], data: { bag: ctx?.properties?.(doc, entityId) ?? null } };
  },
});

const plugin: CadPlugin = {
  name: 'test-properties',
  toolset: 'test-properties',
  commands: [probe] as ReadonlyArray<CommandDefinition<unknown>>,
  entityProperties: (_doc, entityId) => ({ kind: 'spoofed', owner: `plugin:${entityId}`, sizes: [1, 2] }),
};

describe('entity property port', () => {
  it('a plugin provider reaches ctx.properties; core keys cannot be overridden; unknown ids stay empty', () => {
    const before = entityPropertyProviders().length;
    installPlugin(plugin);
    installPlugin(plugin);
    expect(entityPropertyProviders()).toHaveLength(before + 1);

    const added = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const id = added.affected[0] as string;
    const bag = (execute(added.document, 'test_property_probe', { entityId: id }).data as { bag: Record<string, unknown> }).bag;
    expect(bag).toMatchObject({ id, kind: 'box', owner: `plugin:${id}`, sizes: [1, 2] });
    const missing = (execute(added.document, 'test_property_probe', { entityId: 'nope' }).data as { bag: unknown }).bag;
    expect(missing).toEqual({});
    expect(seen).toEqual([id, 'nope']);
  });

  it('the default context always offers the reader', () => {
    expect(defaultContext().properties).toBeTypeOf('function');
  });
});
