import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type SweepEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { migrateRetiredCalls } from '@core/commands/persistence/retiredCommands';
import { suggestCommandNames } from '@core/commands/project/unknownCommandHint';

/** A saved document whose history was recorded with `steps` (retired names) and replayed after loading. */
function replaySaved(steps: { name: string; params: Record<string, unknown> }[]): CadDocument {
  const legacy: CadDocument = {
    ...createEmptyDocument(),
    featureHistory: steps.map((step, index) => ({ id: `step-${index + 1}`, ...step })),
  };
  return execute(deserializeDocument(serializeDocument(legacy)), 'replay_history', {}).document;
}

describe('retired merged commands', () => {
  it('add_helix_spring regenerates the same spring through add_coil (same path, section and bounds)', () => {
    const spring = { wireDiameter: 2, coilRadius: 10, pitch: 5, turns: 8, position: [1, 2, 3], name: 'S' };
    const replayed = replaySaved([{ name: 'add_helix_spring', params: spring }]);
    const [id] = replayed.order;
    const entity = replayed.entities[id!] as SweepEntity;
    expect(entity).toMatchObject({
      kind: 'sweep',
      name: 'S',
      color: '#8a8f98',
      position: [11, 2, 4],
      section: { shape: 'circle', radius: 1 },
    });
    expect(entity.path).toHaveLength(8 * 16);
    const last = entity.path[entity.path.length - 1]!.points.at(-1)!;
    expect(last[2]).toBeCloseTo(40);
    const direct = execute(createEmptyDocument(), 'add_coil', {
      sectionDiameter: 2,
      radius: 10,
      pitch: 5,
      turns: 8,
      position: [1, 2, 3],
      name: 'S',
      color: '#8a8f98',
    });
    expect((direct.document.entities[direct.affected[0]!] as SweepEntity).path).toEqual(entity.path);
  });

  it('add_helix_spring with length and closedEnds maps onto the same add_coil parameters', () => {
    const migrated = migrateRetiredCalls({
      command: 'add_helix_spring',
      params: { wireRadius: 1, coilRadius: 8, turns: 8, length: 60, closedEnds: true, axis: [1, 0, 0] },
    });
    expect(migrated).toEqual({
      command: 'add_coil',
      params: { sectionRadius: 1, radius: 8, turns: 8, length: 60, closedEnds: true, axis: [1, 0, 0], color: '#8a8f98' },
    });
  });

  it('bake_motion becomes evaluate_motion with apply: true', () => {
    expect(migrateRetiredCalls({ command: 'bake_motion', params: {} })).toEqual({ command: 'evaluate_motion', params: { apply: true } });
  });

  it('export_step_exact keeps its AP214, no-validation defaults on export_step_ap242', () => {
    expect(migrateRetiredCalls({ command: 'export_step_exact', params: { entityIds: ['a'] } })).toEqual({
      command: 'export_step_ap242',
      params: { entityIds: ['a'], schema: 'ap214', includeValidationProperties: false },
    });
    expect(migrateRetiredCalls({ command: 'export_step_exact', params: { schema: 'ap242' } })).toEqual({
      command: 'export_step_ap242',
      params: { schema: 'ap242', includeValidationProperties: false },
    });
  });

  it.each([
    ['remove_decal', 'delete_decal'],
    ['remove_material_model', 'delete_material_model'],
    ['remove_property_model', 'delete_property_model'],
    ['remove_material_library', 'delete_material_library'],
    ['remove_interference_intent', 'delete_interference_intent'],
  ])('%s is renamed to %s with its params intact, and is suggested for the old name', (oldName, newName) => {
    expect(migrateRetiredCalls({ command: oldName, params: { id: 'x' } })).toEqual({ command: newName, params: { id: 'x' } });
    expect(execute(createEmptyDocument(), oldName, {}).rejected).toBe(true);
    expect(suggestCommandNames(oldName)).toContain(newName);
  });
});
