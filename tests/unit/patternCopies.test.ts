import { describe, it, expect } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { idPrefixOf } from '@lib/id';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { expectPure } from '../helpers/expectNoOp';
import { build } from '../helpers/addEntity';

const MATERIAL = { name: 'Inconel', density: 0.0082, color: '#888888' };

/** A cylinder seed with a 4-instance polar pattern; `ids[0]` is the seed, `copies` its 3 copies. */
function patterned(): { doc: CadDocument; seed: string; copies: string[] } {
  const { doc, ids } = build(['add_cylinder', { radius: 5, height: 10, position: [20, 0, 0] }], ['create_material', MATERIAL]);
  const seed = ids[0] as string;
  const r = execute(doc, 'array_polar', { id: seed, count: 4, center: [0, 0, 0] });
  return { doc: r.document, seed, copies: r.affected };
}

describe('pattern copies follow their seed (LIM-1)', () => {
  it('array_polar / array_linear / duplicate_entities copies keep the source id prefix', () => {
    const { doc, seed, copies } = patterned();
    expect(seed.startsWith('cyl-')).toBe(true);
    for (const id of copies) expect(idPrefixOf(id, '?')).toBe('cyl');
    const linear = execute(doc, 'array_linear', { id: seed, count: 2, offset: [0, 0, 30] });
    expect(idPrefixOf(linear.affected[0] as string, '?')).toBe('cyl');
    const dup = execute(doc, 'duplicate_entities', { ids: [seed] });
    expect(idPrefixOf(dup.affected[0] as string, '?')).toBe('cyl');
  });

  it('copies record their seed', () => {
    const { doc, seed, copies } = patterned();
    for (const id of copies) expect(doc.entities[id]?.patternSourceId).toBe(seed);
    expect(doc.entities[seed]?.patternSourceId).toBeUndefined();
  });

  it('assign_material on the seed after patterning reaches every copy, so their mass is computed', () => {
    const { doc, seed, copies } = patterned();
    const r = execute(doc, 'assign_material', { materialName: 'Inconel', entityIds: [seed] });
    expect(r.affected).toEqual([seed, ...copies]);
    expect(r.summary).toContain('3 pattern copies');
    for (const id of copies) expect(r.document.entities[id]?.materialId).toBe('Inconel');
    const mass = execute(r.document, 'mass_properties', { entityId: copies[2] });
    expect(mass.summary).toMatch(/mass=6\.44\d* g/);
  });

  it('reaches copies of copies, but not a copy given its own material', () => {
    const { doc, seed, copies } = patterned();
    const first = copies[0] as string;
    const nested = execute(doc, 'array_linear', { id: first, count: 2, offset: [0, 0, 30] });
    const grandchild = nested.affected[0] as string;
    let next = execute(nested.document, 'create_material', { name: 'Steel', density: 0.00785, color: '#555555' }).document;
    next = execute(next, 'assign_material', { materialName: 'Steel', entityIds: [copies[1]] }).document;
    const r = execute(next, 'assign_material', { materialName: 'Inconel', entityIds: [seed] });
    expect(r.document.entities[grandchild]?.materialId).toBe('Inconel');
    expect(r.document.entities[copies[1] as string]?.materialId).toBe('Steel');
    expect(r.affected).not.toContain(copies[1]);
  });

  it('does not reach through a copy that diverged to the copies that follow it', () => {
    const { doc, seed, copies } = patterned();
    const child = copies[0] as string;
    const nested = execute(doc, 'array_linear', { id: child, count: 2, offset: [0, 0, 30] });
    const grandchild = nested.affected[0] as string;
    let next = execute(nested.document, 'create_material', { name: 'Brass', density: 0.0085, color: '#b5a642' }).document;
    next = execute(next, 'assign_material', { materialName: 'Brass', entityIds: [child] }).document;
    expect(next.entities[grandchild]?.materialId).toBe('Brass');
    const r = execute(next, 'assign_material', { materialName: 'Inconel', entityIds: [seed] });
    expect(r.document.entities[child]?.materialId).toBe('Brass');
    expect(r.document.entities[grandchild]?.materialId).toBe('Brass');
  });

  it('a duplicate of a copy is not part of the pattern; deleting a seed releases its copies', () => {
    const { doc, seed, copies } = patterned();
    const dup = execute(doc, 'duplicate_entities', { ids: [copies[0]] });
    expect(dup.document.entities[dup.affected[0] as string]?.patternSourceId).toBeUndefined();
    const deleted = execute(doc, 'delete_entities', { ids: [seed] });
    for (const id of copies) expect(deleted.document.entities[id]?.patternSourceId).toBeUndefined();
  });

  it('assign_material with pattern copies is pure', () => {
    const { doc, seed } = patterned();
    expectPure(doc, () => execute(doc, 'assign_material', { materialName: 'Inconel', entityIds: [seed] }));
  });

  it('a stored non-string patternSourceId is a validation problem', () => {
    const { doc, copies } = patterned();
    expect(validateEntityValue({ ...doc.entities[copies[0] as string], patternSourceId: 7 })).toContain('patternSourceId must be a string');
    expect(validateEntityValue(doc.entities[copies[0] as string])).toBeNull();
  });
});

describe('idPrefixOf', () => {
  it.each([
    ['cyl-3.1', 'cyl'],
    ['brg-el-12.4', 'brg-el'],
    ['box-lz2k9x-1a', 'box'],
    ['imported_part', 'fallback'],
  ])('%s → %s', (id, prefix) => expect(idPrefixOf(id, 'fallback')).toBe(prefix));
});
