/**
 * Contract (L8): plugin delete guards that protect slice references (corrosion, electro-optical) are skipped during history replay, so a history
 * recorded before a guard existed still replays; outside replay they refuse. Every installed guard accepts the optional GuardContext.
 */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { derivationViolation } from '@core/commands/derivation';
import { execute } from '@core/commands/registry';
import { pluginGuards } from '@core/plugins/host';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

function coveredBox(): { doc: CadDocument; box: string } {
  const added = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  const box = added.affected[0] ?? '';
  const covered = execute(added.document, 'assign_surface_system', { entityIds: [box], layers: [{ class: 'anodize' }] });
  return { doc: covered.document, box };
}

describe('plugin delete guards and replay (L8)', () => {
  it('a reference delete is refused outside replay and allowed while replaying', () => {
    const { doc, box } = coveredBox();
    expect(execute(doc, 'delete_entities', { ids: [box] }).error?.code).toBe('COR_REFERENCE_IN_USE');
    const replaying = execute(doc, 'delete_entities', { ids: [box] }, { ...defaultContext(), replaying: true });
    expect(replaying.error).toBeUndefined();
    expect(replaying.document.entities[box]).toBeUndefined();
  });

  it('the corrosion and electro-optical guards return null with { replaying: true }', () => {
    const { doc, box } = coveredBox();
    const { [box]: _gone, ...entities } = doc.entities;
    void _gone;
    const next = { ...doc, entities };
    const guards = pluginGuards().filter((guard) => guard.domain === 'corrosion' || guard.domain === 'electro-optical');
    expect(guards.map((guard) => guard.domain).sort()).toEqual(['corrosion', 'electro-optical']);
    expect(derivationViolation(guards, 'delete_entities', doc, next)).not.toBeNull();
    expect(derivationViolation(guards, 'delete_entities', doc, next, { replaying: true })).toBeNull();
  });

  it('every installed guard accepts the optional context (additive parameter)', () => {
    const doc = createEmptyDocument();
    for (const guard of pluginGuards()) {
      expect(() => guard.check(doc, doc, 'noop', { replaying: true })).not.toThrow();
      expect(() => guard.check(doc, doc, 'noop')).not.toThrow();
    }
  });
});
