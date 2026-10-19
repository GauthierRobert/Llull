/** SC-F4: exploded views are display data; real placements never move. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { activeExplodeOffsets } from '@core/geometry/explodedOffsets';
import { createEmptyDocument, type CadDocument, type Vec3 } from '@core/model/types';

function instanceAt(doc: CadDocument, position: Vec3): { doc: CadDocument; id: string } {
  const box = execute(doc, 'add_box', { size: [1, 1, 1] });
  const name = `part${Object.keys(box.document.components).length}`;
  const withComponent = execute(box.document, 'create_component', { name, entityIds: [box.affected[0]] }).document;
  const componentId = Object.keys(withComponent.components).at(-1);
  const instance = execute(withComponent, 'insert_instance', { componentId, position });
  return { doc: instance.document, id: instance.affected[0] ?? '' };
}

function threeParts(): { doc: CadDocument; ids: string[] } {
  const first = instanceAt(createEmptyDocument(), [0, 0, 0]);
  const second = instanceAt(first.doc, [0, 0, 1]);
  const third = instanceAt(second.doc, [0, 0, 2]);
  return { doc: third.doc, ids: [first.id, second.id, third.id] };
}

describe('exploded views', () => {
  it('auto-explode offsets instances i * spacing along the axis in assembly order, one step each; placements untouched', () => {
    const { doc, ids } = threeParts();
    const created = execute(doc, 'create_exploded_view', { name: 'service', auto: { axis: 'z', spacing: 10, order: ids } });
    const byDefault = execute(doc, 'create_exploded_view', { name: 'default', auto: { axis: 'z', spacing: 10 } });
    const instanceCount = Object.values(doc.entities).filter((entity) => entity.kind === 'instance').length;
    expect(byDefault.document.explodedViews?.[byDefault.affected[0] ?? '']?.offsets).toHaveLength(instanceCount - 1);
    const viewId = created.affected[0] ?? '';
    const view = created.document.explodedViews?.[viewId];
    expect(view?.offsets).toEqual([
      { target: ids[1], vector: [0, 0, 10], step: 1 },
      { target: ids[2], vector: [0, 0, 20], step: 2 },
    ]);
    expect(created.document.entities).toBe(doc.entities);
    expect(created.document.order).toEqual(doc.order);
    expect(created.summary).toContain('placements unchanged');
  });

  it('manual offsets override auto ones and a custom order is honoured', () => {
    const { doc, ids } = threeParts();
    const created = execute(doc, 'create_exploded_view', {
      name: 'custom',
      auto: { axis: [1, 0, 0], spacing: 5, order: [ids[2] ?? '', ids[0] ?? '', ids[1] ?? ''] },
      offsets: [{ target: ids[0], vector: [0, 7, 0], step: 3 }],
    });
    const offsets = created.document.explodedViews?.[created.affected[0] ?? '']?.offsets ?? [];
    expect(offsets).toContainEqual({ target: ids[0], vector: [0, 7, 0], step: 3 });
    expect(offsets).toContainEqual({ target: ids[1], vector: [10, 0, 0], step: 2 });
  });

  it('set_active_exploded_view toggles on / off and limits to a step; the render helper reads it', () => {
    const { doc, ids } = threeParts();
    const created = execute(doc, 'create_exploded_view', { name: 'v', auto: { axis: 'z', spacing: 10, order: ids } });
    const viewId = created.affected[0] ?? '';
    const on = execute(created.document, 'set_active_exploded_view', { id: viewId });
    expect(on.document.activeExplodedView).toEqual({ id: viewId });
    expect(activeExplodeOffsets(on.document.explodedViews, on.document.activeExplodedView).get(ids[2] ?? '')).toEqual([0, 0, 20]);
    const stepped = execute(on.document, 'set_active_exploded_view', { id: viewId, step: 1 });
    const visible = activeExplodeOffsets(stepped.document.explodedViews, stepped.document.activeExplodedView);
    expect([...visible.keys()]).toEqual([ids[1]]);
    const off = execute(stepped.document, 'set_active_exploded_view', {});
    expect(off.document.activeExplodedView).toBeUndefined();
    expect(activeExplodeOffsets(off.document.explodedViews, off.document.activeExplodedView).size).toBe(0);
    expect(on.document.entities).toBe(doc.entities);
    expect(created.document.activeExplodedView).toBeUndefined();
  });

  it('delete_exploded_view removes the view and switches it off only when it was active', () => {
    const { doc } = threeParts();
    const first = execute(doc, 'create_exploded_view', { name: 'a', auto: { axis: 'x', spacing: 1 } });
    const second = execute(first.document, 'create_exploded_view', { name: 'b', auto: { axis: 'y', spacing: 1 } });
    const active = execute(second.document, 'set_active_exploded_view', { id: first.affected[0] }).document;
    const keepsActive = execute(active, 'delete_exploded_view', { id: second.affected[0] });
    expect(keepsActive.document.activeExplodedView?.id).toBe(first.affected[0]);
    const clears = execute(active, 'delete_exploded_view', { id: first.affected[0] });
    expect(clears.document.activeExplodedView).toBeUndefined();
    expect(Object.keys(clears.document.explodedViews ?? {})).toEqual(second.affected);
  });

  it('refuses unknown targets, empty views, bad axis / spacing, taken ids and unknown views', () => {
    const { doc, ids } = threeParts();
    const created = execute(doc, 'create_exploded_view', { name: 'a', id: 'view-a', auto: { axis: 'z', spacing: 1 } });
    const cases: [string, Record<string, unknown>][] = [
      ['create_exploded_view', { name: 'x', offsets: [{ target: 'ghost', vector: [1, 0, 0] }] }],
      ['create_exploded_view', { name: 'x' }],
      ['create_exploded_view', { name: 'x', auto: { axis: 'q', spacing: 1 } }],
      ['create_exploded_view', { name: 'x', auto: { axis: 'z', spacing: 0 } }],
      ['create_exploded_view', { name: 'x', id: 'view-a', offsets: [{ target: ids[0], vector: [1, 0, 0] }] }],
      ['set_active_exploded_view', { id: 'ghost' }],
      ['delete_exploded_view', { id: 'ghost' }],
    ];
    for (const [name, params] of cases) {
      const result = execute(created.document, name, params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(created.document);
    }
  });

  it('activeExplodeOffsets is empty without an active or known view', () => {
    expect(activeExplodeOffsets(undefined, undefined).size).toBe(0);
    expect(activeExplodeOffsets({}, { id: 'ghost' }).size).toBe(0);
    expect(activeExplodeOffsets(undefined, { id: 'ghost' }).size).toBe(0);
  });
});
