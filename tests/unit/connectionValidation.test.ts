/** 08 ASC M3: load validation of prototype.connections and the fastener tag, and their round trip through save / load. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { prototypeProblems } from '@core/commands/persistence/prototypeValidation';
import { resolveMembers } from '@core/geometry/assemblyCheck/connectionMembers';
import { checkedPrototype } from '@core/model/prototype';

const group = {
  id: 'conn-1.1',
  name: 'bolts',
  kind: 'bolted',
  members: { ids: ['a', 'b'] },
  detect: { toleranceMm: 0.1, faceAngleDeg: 10, cylindrical: 'include' },
  reason: 'M8 bolts',
  declaredBy: 'agent',
};
const slice = (patch: Record<string, unknown>): string[] =>
  prototypeProblems({ intents: {}, grounded: [], connections: { 'conn-1.1': { ...group, ...patch } } });

describe('prototype.connections load validation', () => {
  it('accepts absence and a well-formed group (with and without detect)', () => {
    expect(prototypeProblems({ intents: {}, grounded: [] })).toEqual([]);
    expect(slice({})).toEqual([]);
    expect(slice({ detect: undefined, declaredBy: 'user', members: { layerId: 'l' } })).toEqual([]);
  });

  it('reports each malformed field', () => {
    expect(prototypeProblems({ intents: {}, grounded: [], connections: [] })[0]).toMatch(/keyed by connection id/);
    expect(slice({ id: 'other' })[0]).toMatch(/whose id is/);
    expect(slice({ name: 3 })[0]).toMatch(/name must be a string/);
    expect(slice({ kind: 'glued' })[0]).toMatch(/kind must be one of/);
    expect(slice({ reason: '  ' })[0]).toMatch(/reason must be non-empty/);
    expect(slice({ declaredBy: 'robot' })[0]).toMatch(/declaredBy/);
    expect(slice({ members: 'a' })[0]).toMatch(/members must be an object/);
    expect(slice({ members: {} })[0]).toMatch(/exactly one of/);
    expect(slice({ members: { ids: ['a'], layerId: 'l' } })[0]).toMatch(/exactly one of/);
    expect(slice({ members: { ids: [] } })[0]).toMatch(/non-empty array/);
    expect(slice({ members: { patternOf: '' } })[0]).toMatch(/patternOf must be a non-empty string/);
    expect(slice({ detect: 5 })[0]).toMatch(/detect must be an object/);
    expect(slice({ detect: { ...group.detect, toleranceMm: 0 } })[0]).toMatch(/toleranceMm/);
    expect(slice({ detect: { ...group.detect, faceAngleDeg: 91 } })[0]).toMatch(/faceAngleDeg/);
    expect(slice({ detect: { ...group.detect, cylindrical: 'some' } })[0]).toMatch(/cylindrical/);
    expect(prototypeProblems({ intents: {}, grounded: [], connections: { constructor: group } })[0]).toMatch(/reserved/);
  });
});

describe('connection groups and the fastener tag survive save / load', () => {
  it('round-trips and rejects a bad fastener value', () => {
    let doc = createEmptyDocument();
    const ids: string[] = [];
    for (const x of [0, 20]) {
      const made = execute(doc, 'add_box', { size: [10, 10, 10], position: [x, 0, 0] });
      doc = made.document;
      ids.push(made.affected[0] as string);
    }
    doc = execute(doc, 'add_connection_group', { name: 'g', kind: 'welded', members: { ids }, reason: 'seam' }).document;
    doc = execute(doc, 'set_fastener', { ids: [ids[0]], fastener: true }).document;
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(loaded.prototype?.connections).toEqual(doc.prototype?.connections);
    expect(loaded.entities[ids[0] as string]?.fastener).toBe(true);
    const text = JSON.parse(serializeDocument(doc)) as { document: { entities: Record<string, Record<string, unknown>> } };
    (text.document.entities[ids[0] as string] as Record<string, unknown>)['fastener'] = false;
    expect(() => deserializeDocument(JSON.stringify(text))).toThrow(/fastener/);
  });

  it('connections are part of the checked prototype (they change the check hash)', () => {
    expect(
      checkedPrototype({ intents: {}, grounded: [], connections: { x: group as never }, dispositions: {} })?.connections,
    ).toBeDefined();
  });
});

describe('connection member resolution', () => {
  it('resolves ids, layers and groups live and reports stale ids without throwing', () => {
    let doc = createEmptyDocument();
    const ids: string[] = [];
    for (const x of [0, 20]) {
      const made = execute(doc, 'add_box', { size: [10, 10, 10], position: [x, 0, 0] });
      doc = made.document;
      ids.push(made.affected[0] as string);
    }
    expect(resolveMembers(doc, { ids: [...ids, 'ghost'] })).toEqual({ ids, stale: ['ghost'] });
    expect(resolveMembers(doc, { patternOf: ids[0] as string }).ids).toEqual([ids[0]]);
    expect(resolveMembers(doc, { patternOf: 'ghost' })).toEqual({ ids: [], stale: ['ghost'] });
    expect(resolveMembers(doc, { layerId: 'ghost' }).stale).toEqual(['ghost']);
    expect(resolveMembers(doc, { groupId: 'ghost' }).stale).toEqual(['ghost']);
    const withGroup = { ...doc, groups: { g1: { id: 'g1', name: 'g', memberIds: [...ids, 'gone'] } } };
    expect(resolveMembers(withGroup, { groupId: 'g1' })).toEqual({ ids, stale: ['gone'] });
  });
});
