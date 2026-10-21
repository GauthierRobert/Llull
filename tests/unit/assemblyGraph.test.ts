/** Grounding and linking rules of the connection graph, read from the document. */
import { describe, expect, it } from 'vitest';
import { assemblyLinks, intentOf } from '@core/geometry/assemblyGraph';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';

function build(): { doc: CadDocument; run: (name: string, params: Record<string, unknown>) => string } {
  const state = { doc: createEmptyDocument() };
  return {
    get doc() {
      return state.doc;
    },
    run: (name, params) => {
      const result = execute(state.doc, name, params);
      expect(result.rejected, result.summary).toBeUndefined();
      state.doc = result.document;
      return result.affected[0] ?? '';
    },
  };
}

const box = (x: number): Record<string, unknown> => ({ size: [10, 10, 10], position: [x, 0, 0] });

describe('assemblyLinks', () => {
  it('grounds fixed bodies and the child of a ground joint, and links the members of a body', () => {
    const b = build();
    const [a, c, d] = [b.run('add_box', box(0)), b.run('add_box', box(50)), b.run('add_box', box(100))];
    b.run('add_rigid_body', { entityIds: [a, c], fixed: true, id: 'fixed' });
    b.run('add_rigid_body', { entityIds: [d], id: 'free' });
    b.run('add_body_joint', { id: 'hinge', kind: 'revolute', child: 'free', anchor: [100, 0, 0], axis: [0, 0, 1] });
    const links = assemblyLinks(b.doc, new Set([a, c, d]));
    expect([...links.grounded].sort()).toEqual([a, c, d].sort());
    expect(links.strongLinks).toEqual([[a, c]]);
    expect(links.bodyOf.get(c)).toBe('fixed');
    expect(links.bodyOf.get(d)).toBe('free');
  });

  it('a joint between two bodies links them without grounding the child', () => {
    const b = build();
    const [a, c] = [b.run('add_box', box(0)), b.run('add_box', box(50))];
    b.run('add_rigid_body', { entityIds: [a], id: 'one' });
    b.run('add_rigid_body', { entityIds: [c], id: 'two' });
    b.run('add_body_joint', { id: 'pivot', kind: 'revolute', parent: 'one', child: 'two', anchor: [25, 0, 0], axis: [0, 0, 1] });
    const links = assemblyLinks(b.doc, new Set([a, c]));
    expect(links.strongLinks).toEqual([[a, c]]);
    expect(links.grounded.size).toBe(0);
  });

  it('a kinematic joint links its instances and grounds the one that is not a joint child', () => {
    const b = build();
    const make = (x: number): string => {
      const source = b.run('add_box', box(x));
      return b.run('create_component', { name: `C${x}`, entityIds: [source], componentId: `c${x}` });
    };
    const [fixed, arm, hand] = [make(0), make(100), make(200)];
    b.run('add_joint', { kind: 'revolute', a: { instanceId: fixed }, b: { instanceId: arm }, axis: 'z' });
    b.run('add_joint', { kind: 'revolute', a: { instanceId: arm }, b: { instanceId: hand }, axis: 'z' });
    const links = assemblyLinks(b.doc, new Set([fixed, arm, hand]));
    expect([...links.grounded]).toEqual([fixed]);
    expect(links.strongLinks).toEqual([
      [fixed, arm],
      [arm, hand],
    ]);
  });

  it('weld, thread and press-fit intents link rigidly; overlap_by_design does not; grounded ids are honoured', () => {
    const b = build();
    const [a, c, d, e] = [b.run('add_box', box(0)), b.run('add_box', box(50)), b.run('add_box', box(100)), b.run('add_box', box(150))];
    b.run('allow_interference', { a: c, b: a, kind: 'weld', reason: 'w' });
    b.run('allow_interference', { a: c, b: d, kind: 'overlap_by_design', reason: 'o' });
    b.run('allow_interference', { a: d, b: e, kind: 'press_fit', reason: 'p' });
    b.run('set_part_grounded', { ids: [e], grounded: true });
    const links = assemblyLinks(b.doc, new Set([a, c, d, e]));
    expect(links.strongLinks).toEqual([
      [a, c],
      [d, e],
    ]);
    expect([...links.grounded]).toEqual([e]);
  });

  it('ignores ids that are not among the parts, and finds an intent whichever way the pair is asked', () => {
    const b = build();
    const [a, c] = [b.run('add_box', box(0)), b.run('add_box', box(50))];
    b.run('add_rigid_body', { entityIds: [a, c], fixed: true, id: 'fixed' });
    const links = assemblyLinks(b.doc, new Set([a]));
    expect([...links.grounded]).toEqual([a]);
    expect(links.strongLinks).toEqual([]);
    const id = b.run('allow_interference', { a: c, b: a, kind: 'thread', reason: 't' });
    expect(intentOf(b.doc, a, c)?.id).toBe(id);
    expect(intentOf(b.doc, c, a)?.id).toBe(id);
    expect(intentOf(b.doc, a, 'zz')).toBeUndefined();
  });
});
