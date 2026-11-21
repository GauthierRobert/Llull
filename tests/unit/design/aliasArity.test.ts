/**
 * M4a of the assembly-scale pack: alias arity typing (a group alias binds all ids on a list param, is refused on a one-id param),
 * expression indexing (`a[i]`, `a[-1]`, `a[x..<y]`) and `alias.entity` / `alias.entities`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument } from '@core/model/types';
import { splitAliasRef, selectIds } from '@design/aliasRef';

const apply = (source: string): CommandResult => execute(createEmptyDocument(), 'apply_design', { source });
const boxes = 'add_box a size=[1,1,1]\nadd_box b size=[1,1,1] position=[3,0,0]\nadd_box c size=[1,1,1] position=[6,0,0]\n';
const group = `${boxes}duplicate_entities g ids=[a, b, c]\n`;

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
afterAll(() => setGeometryKernel(null));

describe('alias arity (D4: a bare alias is all its ids)', () => {
  it('a group alias on a string | string[] param cuts every tool (VC-ASC-14 shape)', () => {
    const r = apply(
      [
        'add_box body size=[20,20,20]',
        'add_cylinder c1 radius=0.5 height=100 position=[2,2,0]',
        'array_linear cs id=c1 count=3 offset=[3,0,0]',
        'duplicate_entities tools ids=[c1, cs]',
        'boolean holed op=subtract a=body b=tools',
        'check volume of=holed expect < 990',
      ].join('\n'),
    );
    expect(r.error).toBeUndefined();
    const volume = (source: string): number => Number((apply(source).data as { checks: { actual: number }[] }).checks[0]?.actual);
    const head =
      'add_box body size=[20,20,20]\nadd_cylinder c1 radius=0.5 height=100 position=[2,2,0]\narray_linear cs id=c1 count=3 offset=[3,0,0]\nduplicate_entities tools ids=[c1, cs]\n';
    const tail = ' op=subtract a=body\ncheck volume of=holed expect > 0';
    expect(volume(`${head}boolean holed b=tools${tail}`)).toBeLessThan(volume(`${head}boolean holed b=tools[0]${tail}`) - 5);
  });

  it('a group alias on a one-id param is DESIGN_ALIAS_ARITY and names the fix', () => {
    const r = apply(`${group}boolean x op=union a=g b=a`);
    expect(r.error?.code).toBe('DESIGN_ALIAS_ARITY');
    expect(r.summary).toContain('group');
    expect(r.error?.remediation).toContain('g[0]');
  });

  it('a one-id alias keeps working on one-id params', () => {
    expect(apply(`${boxes}boolean x op=union a=a b=b`).error).toBeUndefined();
  });
});

describe('expression indexing', () => {
  it('a[expr], a[-1] and a[x..<y] pick ids; loop variables are expressions', () => {
    const source = `${group}for i in 0..1 {\n  move_entities _ ids=[g[i+1]] delta=[0,0,5]\n}\nmove_entities _ ids=[g[-1]] delta=[0,1,0]`;
    expect(apply(source).error).toBeUndefined();
    const moved = (ids: string): number => {
      const r = apply(`${group}move_entities m ids=${ids} delta=[0,0,100]`);
      expect(r.error).toBeUndefined();
      return Object.values(r.document.entities).filter((e) => e.position[2] > 50).length;
    };
    expect(moved('g[0..<2]')).toBe(2);
    expect(moved('g[0..1]')).toBe(2);
    expect(moved('[g[0..<2], g[2]]')).toBe(3);
    expect(moved('g[-1]')).toBe(1);
  });

  it('an index or range outside the ids is DESIGN_INDEX_RANGE; a fractional index too', () => {
    for (const selector of ['3', '-4', '1.5', '2..<2', '0..<4', '1..0'])
      expect(apply(`${group}move_entities m ids=[g[${selector}]] delta=[0,0,1]`).error?.code, selector).toBe('DESIGN_INDEX_RANGE');
  });

  it('indexing an unbound alias is DESIGN_UNKNOWN_ALIAS', () => {
    expect(apply(`${boxes}move_entities m ids=[nope[0]] delta=[0,0,1]`).error?.code).toBe('DESIGN_UNKNOWN_ALIAS');
  });
});

describe('alias.entity', () => {
  it('names the entity a record-making line created; .entities all of them', () => {
    const naca = 'airfoil_from_naca af designation="0012"\n';
    const r = apply(`${naca}move_entities m ids=[af.entity] delta=[0,0,1]`);
    expect(r.error).toBeUndefined();
    expect(apply(`${naca}move_entities m ids=af.entities delta=[0,0,1]`).error).toBeUndefined();
    expect(apply(`${naca}move_entities m ids=[af.entities[0]] delta=[0,0,1]`).error).toBeUndefined();
  });

  it('works on an entity alias and fails for an unbound alias', () => {
    expect(apply(`${boxes}move_entities m ids=[a.entity] delta=[0,0,1]`).error).toBeUndefined();
    expect(apply(`${boxes}move_entities m ids=[nope.entity] delta=[0,0,1]`).error?.code).toBe('DESIGN_UNKNOWN_ALIAS');
  });

  it('all entities consumed is DESIGN_ALIAS_CONSUMED with the live heir, not DESIGN_NO_ENTITY', () => {
    const r = apply(
      `add_box a size=[1,1,1]\nadd_box b size=[1,1,1]\nduplicate_entities g ids=[a, b]\nboolean u op=union a=g[0] b=g[1]\nmove_entities m ids=[g.entity] delta=[0,0,1]`,
    );
    expect(r.error?.code).toBe('DESIGN_ALIAS_CONSUMED');
    expect(r.error?.remediation).toBe('Use u instead.');
  });

  it('an unbound word on a list param is the literal id (wrapped in a list); the command then refuses it', () => {
    const r = apply(`${boxes}move_entities m ids=foo delta=[0,0,1]`);
    expect(r.error?.code).toBe('DESIGN_STEP_FAILED');
    expect(r.summary).toContain('foo');
  });

  it('is pure: the input document is unchanged', () => {
    const doc = createEmptyDocument();
    const before = JSON.stringify(doc);
    execute(doc, 'apply_design', { source: `${group}move_entities m ids=g[0..<2] delta=[0,0,1]` });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('reference parsing', () => {
  it('splits name, member and selector; rejects expressions', () => {
    expect(splitAliasRef('af{i}.entities[2]')).toEqual({ name: 'af{i}', member: 'entities', selector: '2' });
    expect(splitAliasRef('ribs[a..<b]')).toEqual({ name: 'ribs', member: null, selector: 'a..<b' });
    expect(splitAliasRef('box-3.0')).toBeNull();
    expect(selectIds(['x', 'y', 'z'], 'n', '-1', Number, 1).ids).toEqual(['z']);
    expect(() => selectIds([], 'n', '0', Number, 1)).toThrow(/outside/);
  });
});
