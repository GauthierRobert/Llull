import { beforeAll, describe, expect, it } from 'vitest';
import { type CadDocument, DEFAULT_LAYER_ID, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { registerCommands } from '@core/commands/commandTable';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import { installPlugin } from '@core/plugins/host';
import type { CommandDefinition } from '@core/commands/types';

const DERIVED_PREFIX = 'derived:';

const relayer = defineCommand({
  name: 'lock_probe_relayer',
  description: 'Test-only: sets the layer of an entity (not layer management).',
  params: z.object({ id: z.string().describe('Entity id.'), layerId: z.string().describe('Destination layer id.') }),
  run: (doc: CadDocument, { id, layerId }) => {
    const entity = doc.entities[id];
    if (entity === undefined) return { document: doc, summary: 'none', affected: [] };
    return changed({ ...doc, entities: { ...doc.entities, [id]: { ...entity, layerId } } }, `relayered ${id}`, [id]);
  },
});

const compose = defineCommand({
  name: 'lock_probe_compose',
  description: 'Test-only plugin command: composes add_box (+ a rename that marks the box derived) through the nested execute.',
  params: z.object({ derive: z.boolean().describe('Whether the created box is a derived entity.') }),
  run: (doc: CadDocument, { derive }, ctx) => {
    const added = execute(doc, 'add_box', { size: [1, 1, 1] }, ctx);
    const id = added.affected[0];
    if (id === undefined) return { document: doc, summary: `inner refused: ${added.summary}`, affected: [], rejected: true };
    if (!derive) return added;
    return execute(added.document, 'set_entity_name', { id, name: `${DERIVED_PREFIX}${id}` }, ctx);
  },
});

beforeAll(() => {
  installPlugin({
    name: 'test-lock-nested',
    toolset: 'test',
    commands: [compose] as ReadonlyArray<CommandDefinition<unknown>>,
    document: {
      validate: () => [],
      restore: (raw) => raw,
      derivedEntityIds: (doc) =>
        new Set(
          Object.values(doc.entities)
            .filter((e) => e.name?.startsWith(DERIVED_PREFIX))
            .map((e) => e.id),
        ),
    },
  });
  registerCommands('test:lock-probe', [relayer as never]);
});

const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument => {
  const result = execute(doc, name, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
};

function sceneWithLockedLayer(): { doc: CadDocument; locked: string; box: string } {
  const layer = execute(createEmptyDocument(), 'add_layer', { name: 'Frozen' });
  const locked = layer.affected[0] ?? '';
  let doc = run(layer.document, 'add_box', { size: [1, 1, 1] });
  const box = doc.order[0] ?? '';
  doc = run(doc, 'update_layer', { id: locked, locked: true });
  return { doc, locked, box };
}

describe('lock guard: entity moved INTO a locked layer', () => {
  it('a non-layer-management command that moves an entity onto a locked layer is refused LAYER_LOCKED', () => {
    const { doc, locked, box } = sceneWithLockedLayer();
    expect(doc.entities[box]?.layerId).toBe(DEFAULT_LAYER_ID);
    const result = execute(doc, 'lock_probe_relayer', { id: box, layerId: locked });
    expect(result.error?.code, result.summary).toBe('LAYER_LOCKED');
    expect(result.document).toBe(doc);
  });

  it('set_entity_layer refuses a locked destination layer too', () => {
    const { doc, locked, box } = sceneWithLockedLayer();
    const result = execute(doc, 'set_entity_layer', { entityId: box, layerId: locked });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('locked');
  });
});

describe('lock guard: nested execute inside a command', () => {
  it('a composing plugin command whose result is NOT derived is refused once, as itself, with LAYER_LOCKED', () => {
    const locked = run(createEmptyDocument(), 'update_layer', { id: DEFAULT_LAYER_ID, locked: true });
    const result = execute(locked, 'lock_probe_compose', { derive: false });
    expect(result.error?.code, result.summary).toBe('LAYER_LOCKED');
    expect(result.summary).toContain('lock_probe_compose rejected');
    expect(result.document).toBe(locked);
  });

  it('a composing plugin command whose final entity is derived succeeds on a locked layer (the outer guard judges the final delta)', () => {
    const locked = run(createEmptyDocument(), 'update_layer', { id: DEFAULT_LAYER_ID, locked: true });
    const result = execute(locked, 'lock_probe_compose', { derive: true });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.affected.length).toBeGreaterThan(0);
  });

  it('design_nozzle (aero) on a locked layer reports LAYER_LOCKED, not a contour error', () => {
    const locked = run(createEmptyDocument(), 'update_layer', { id: DEFAULT_LAYER_ID, locked: true });
    const result = execute(locked, 'design_nozzle', { throatRadius: 0.05, expansionRatio: 8, wallThickness: 0.005 });
    expect(result.error?.code, result.summary).toBe('LAYER_LOCKED');
  });

  it('top-level calls and build_project steps stay guarded', () => {
    const locked = run(createEmptyDocument(), 'update_layer', { id: DEFAULT_LAYER_ID, locked: true });
    expect(execute(locked, 'add_box', { size: [1, 1, 1] }).error?.code).toBe('LAYER_LOCKED');
    const plan = execute(locked, 'build_project', { actions: [{ command: 'add_box', params: { size: [1, 1, 1] } }] });
    expect(Object.keys(plan.document.entities)).toEqual([]);
  });
});

describe('lock guard: every mutating registered command goes through it', () => {
  it('a stub command registered like any other is refused when it edits a locked-layer entity', () => {
    const { doc, box, locked } = sceneWithLockedLayer();
    const frozen = run(doc, 'update_layer', { id: DEFAULT_LAYER_ID, locked: true });
    const result = execute(frozen, 'lock_probe_relayer', { id: box, layerId: locked });
    expect(result.error?.code, result.summary).toBe('LAYER_LOCKED');
  });
});
