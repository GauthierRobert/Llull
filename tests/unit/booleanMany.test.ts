/** ASC M1a: `boolean` with `b` as a list routes to the kernel's multi-tool op through the recipe (`many`), reports how it ran, and degrades cleanly. */
import { describe, it, expect, afterEach } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import type { BooleanReport } from '@core/geometry/kernelPorts';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { TETRA, fakeKernel } from '../helpers/fakeKernel';

function docWithBoxes(count: number): { doc: CadDocument; ids: string[] } {
  let doc = createEmptyDocument();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = execute(doc, 'add_box', { size: [1, 1, 1], position: [i, 0, 0] });
    doc = r.document;
    ids.push(r.affected[0]!);
  }
  return { doc, ids };
}

/** A fake kernel that answers `booleanReport` like the native one (the real recipe evaluator underneath). */
function reporting(report: BooleanReport | null, refusal: string | null = null): { kernel: GeometryKernel; asked: string[] } {
  const asked: string[] = [];
  const base = fakeKernel({ boolean: TETRA });
  const kernel: GeometryKernel = {
    ...base,
    booleanReport: (recipe) => {
      asked.push(recipeKey(recipe));
      return report;
    },
    lastRefusal: () => refusal,
  };
  return { kernel, asked };
}

const brepOf = (doc: CadDocument, id: string): MeshSolidEntity['brep'] => (doc.entities[id] as MeshSolidEntity).brep;

describe('boolean with a list of tools (multi-tool kernel op)', () => {
  afterEach(() => setGeometryKernel(null));

  it('marks the recipe with the tool count and keeps b as the balanced tree', () => {
    setGeometryKernel(fakeKernel({ boolean: TETRA }));
    const { doc, ids } = docWithBoxes(6);
    const [base, ...tools] = ids as [string, ...string[]];
    const r = execute(doc, 'boolean', { op: 'subtract', a: base, b: tools });
    expect(r.affected).toHaveLength(1);
    const brep = brepOf(r.document, r.affected[0]!);
    expect(brep).toMatchObject({ op: 'boolean', boolean: 'subtract', many: 5, b: { op: 'boolean', boolean: 'union' } });
    expect(r.document.order).toEqual(r.affected);
  });

  it('keys a many recipe apart from the same tree without it', () => {
    setGeometryKernel(fakeKernel({ boolean: TETRA }));
    const { doc, ids } = docWithBoxes(4);
    const [base, ...tools] = ids as [string, ...string[]];
    const result = execute(doc, 'boolean', { op: 'union', a: base, b: tools });
    const withMany = brepOf(result.document, result.affected[0]!);
    if (withMany === undefined || withMany.op !== 'boolean') throw new Error('expected a boolean recipe');
    const { many: _many, ...plain } = withMany;
    expect(recipeKey(withMany)).not.toBe(recipeKey(plain));
  });

  it('adds no marker for one tool, a one-element list or an intersect', () => {
    setGeometryKernel(fakeKernel({ boolean: TETRA }));
    const { doc, ids } = docWithBoxes(3);
    const [base, first, second] = ids as [string, string, string];
    for (const params of [
      { op: 'union', a: base, b: first },
      { op: 'subtract', a: base, b: [first] },
      { op: 'intersect', a: base, b: second },
    ] as const) {
      const r = execute(doc, 'boolean', params);
      expect(brepOf(r.document, r.affected[0]!)).not.toHaveProperty('many');
    }
    const refused = execute(doc, 'boolean', { op: 'intersect', a: base, b: [first, second] });
    expect(refused.affected).toEqual([]);
    expect(refused.summary).toContain('intersect takes one tool solid');
  });

  it('reports one general fuse when the kernel ran the multi-tool op', () => {
    const { kernel, asked } = reporting({ mode: 'general-fuse', tools: 4 });
    setGeometryKernel(kernel);
    const { doc, ids } = docWithBoxes(5);
    const [base, ...tools] = ids as [string, ...string[]];
    const r = execute(doc, 'boolean', { op: 'union', a: base, b: tools });
    expect(r.summary).toContain('(one general fuse of 4 tools)');
    expect(asked).toHaveLength(1);
  });

  it('reports KRN_FUSE_FALLBACK when the kernel ran the balanced tree instead', () => {
    const { kernel } = reporting({
      mode: 'balanced-tree',
      tools: 4,
      fallback: true,
      code: 'KRN_FUSE_FALLBACK',
      reason: 'the General Fuse result is not valid',
    });
    setGeometryKernel(kernel);
    const { doc, ids } = docWithBoxes(5);
    const [base, ...tools] = ids as [string, ...string[]];
    const r = execute(doc, 'boolean', { op: 'subtract', a: base, b: tools });
    expect(r.affected).toHaveLength(1);
    expect(r.summary).toContain(
      'KRN_FUSE_FALLBACK: the general fuse of 4 tools was refused (the General Fuse result is not valid); the balanced tree ran.',
    );
  });

  it('says nothing about the fuse for a kernel without the report (Manifold)', () => {
    setGeometryKernel(fakeKernel({ boolean: TETRA }));
    const { doc, ids } = docWithBoxes(4);
    const [base, ...tools] = ids as [string, ...string[]];
    const r = execute(doc, 'boolean', { op: 'union', a: base, b: tools });
    expect(r.affected).toHaveLength(1);
    expect(r.summary).not.toContain('general fuse');
    expect(r.summary).not.toContain('KRN_FUSE_FALLBACK');
  });

  it('names KRN_TIMEOUT and keeps the operands when the kernel stopped at its deadline', () => {
    const base = fakeKernel({ boolean: null });
    setGeometryKernel({ ...base, lastRefusal: () => 'KRN_TIMEOUT: stage=Fuse fraction=0.4' });
    const { doc, ids } = docWithBoxes(4);
    const [first, ...tools] = ids as [string, ...string[]];
    const r = execute(doc, 'boolean', { op: 'union', a: first, b: tools });
    expect(r.affected).toEqual([]);
    expect(r.document).toBe(doc);
    expect(r.summary).toContain('KRN_TIMEOUT: stage=Fuse fraction=0.4');
    expect(r.summary).toContain('LLULL_OCC_TIMEOUT_MS');
  });

  it('refuses a malformed many count in an untrusted recipe', () => {
    const leaf = { op: 'solid', entity: { kind: 'box', id: 'b', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0] } };
    const node = (many: unknown): unknown => ({ op: 'boolean', boolean: 'union', a: leaf, b: leaf, many });
    expect(validateShapeRecipe(node(1.5), () => null)).toContain('many must be an integer');
    expect(validateShapeRecipe(node(1), () => null)).toContain('many must be an integer');
    expect(validateShapeRecipe(node(2), () => null)).toBeNull();
  });
});
