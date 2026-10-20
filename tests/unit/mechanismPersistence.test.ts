/** SC-F4 document data survives save/load, and malformed contact sets / exploded views are refused on load. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

function withMechanismData(): CadDocument {
  let doc = createEmptyDocument();
  const ids: string[] = [];
  for (const z of [0, 2]) {
    const box = execute(doc, 'add_box', { size: [1, 1, 1] });
    const component = execute(box.document, 'create_component', { name: `part${z}`, entityIds: [box.affected[0]] }).document;
    const instance = execute(component, 'insert_instance', { componentId: Object.keys(component.components).at(-1), position: [0, 0, z] });
    doc = instance.document;
    ids.push(instance.affected[0] ?? '');
  }
  doc = execute(doc, 'create_contact_set', { name: 'stops', pairs: [[ids[0], ids[1]]] }).document;
  const view = execute(doc, 'create_exploded_view', { name: 'service', auto: { axis: 'z', spacing: 5, order: ids } });
  return execute(view.document, 'set_active_exploded_view', { id: view.affected[0] }).document;
}

function tampered(doc: CadDocument, edit: (raw: Record<string, unknown>) => void): string {
  const envelope = JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> };
  edit(envelope.document);
  return JSON.stringify(envelope);
}

describe('contact sets and exploded views in saved files', () => {
  it('round-trips contact sets, exploded views and the active view', () => {
    const doc = withMechanismData();
    expect(Object.keys(doc.contactSets ?? {})).toHaveLength(1);
    expect(doc.activeExplodedView).toBeDefined();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.contactSets).toEqual(doc.contactSets);
    expect(loaded.explodedViews).toEqual(doc.explodedViews);
    expect(loaded.activeExplodedView).toEqual(doc.activeExplodedView);
  });

  it.each([
    [
      'a contact pair that is not two ids',
      (raw: Record<string, unknown>) => {
        const sets = raw['contactSets'] as Record<string, { pairs: unknown }>;
        for (const set of Object.values(sets)) set.pairs = [['only-one']];
      },
      /pairs must be/,
    ],
    [
      'an offset with a non-finite vector',
      (raw: Record<string, unknown>) => {
        const views = raw['explodedViews'] as Record<string, { offsets: { vector: unknown }[] }>;
        for (const view of Object.values(views)) if (view.offsets[0]) view.offsets[0].vector = [0, 'x', 0];
      },
      /offsets\[0\]/,
    ],
    [
      'an active view that does not exist',
      (raw: Record<string, unknown>) => {
        raw['activeExplodedView'] = { id: 'missing' };
      },
      /does not reference a known exploded view/,
    ],
  ])('refuses %s', (_label, edit, message) => {
    expect(() => deserializeDocument(tampered(withMechanismData(), edit))).toThrow(message);
  });
});
