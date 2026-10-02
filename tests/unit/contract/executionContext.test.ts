/**
 * MG1 execution context: kernel, ids and registry come from the context passed to `execute`
 * (or inherited by nested executes), never from a module singleton.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/context';
import { currentContext, defaultContext } from '@core/commands/context';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { IdSource } from '@lib/id';
import { __resetIdCounter } from '@lib/id';

const TRIANGLE: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };

function fakeKernel(): GeometryKernel {
  return {
    booleanOp: () => TRIANGLE,
    filletEdges: () => TRIANGLE,
    chamferEdges: () => TRIANGLE,
    shellSolid: () => null,
    tessellate: () => TRIANGLE,
  };
}

function prefixedIds(tag: string): IdSource {
  let n = 0;
  return { next: (prefix) => `${tag}:${prefix}:${++n}` };
}

function contextWith(overrides: Partial<ExecutionContext>): ExecutionContext {
  return { ...defaultContext(), ...overrides };
}

function twoBoxes(): { doc: CadDocument; a: string; b: string } {
  let doc = createEmptyDocument();
  const first = execute(doc, 'add_box', { size: [2, 2, 2] });
  doc = first.document;
  const second = execute(doc, 'add_box', { size: [2, 2, 2], position: [1, 0, 0] });
  return { doc: second.document, a: first.affected[0] ?? '', b: second.affected[0] ?? '' };
}

describe('ExecutionContext', () => {
  beforeEach(() => {
    __resetIdCounter();
    setGeometryKernel(null);
  });
  afterEach(() => setGeometryKernel(null));

  it('mints entity and step ids through ctx.ids', () => {
    const result = execute(
      createEmptyDocument(),
      'add_box',
      { size: [1, 1, 1] },
      contextWith({ ids: prefixedIds('t') }),
    );
    expect(result.affected[0]).toMatch(/^t:/);
    expect(result.document.featureHistory[0]?.id).toMatch(/^t:step:/);
  });

  it('nested executes (build_project steps) inherit the caller context', () => {
    const result = execute(
      createEmptyDocument(),
      'build_project',
      { actions: [{ command: 'add_box', params: { size: [1, 1, 1] } }] },
      contextWith({ ids: prefixedIds('plan') }),
    );
    expect(result.affected.length).toBeGreaterThan(0);
    expect(result.affected.every((id) => id.startsWith('plan:'))).toBe(true);
  });

  it('uses ctx.kernel even when no process kernel is installed', () => {
    const { doc, a, b } = twoBoxes();
    const result = execute(doc, 'boolean_union', { a, b }, contextWith({ kernel: fakeKernel() }));
    const created = result.document.entities[result.affected[0] ?? ''] as MeshSolidEntity;
    expect(created.kind).toBe('mesh');
  });

  it('no-ops a requiresKernel command with an explicit summary when no kernel is available', () => {
    const { doc, a, b } = twoBoxes();
    const result = execute(doc, 'boolean_union', { a, b });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('kernel not available');
  });

  it('replay refuses to regenerate kernel-dependent history without a kernel', () => {
    const { doc, a, b } = twoBoxes();
    const unioned = execute(doc, 'boolean_union', { a, b }, contextWith({ kernel: fakeKernel() }));
    const replayed = execute(unioned.document, 'replay_history', {});
    expect(Object.keys(replayed.document.entities)).toEqual(Object.keys(unioned.document.entities));
  });

  it('restores the outer context after execute returns', () => {
    const outer = currentContext();
    execute(
      createEmptyDocument(),
      'add_box',
      { size: [1, 1, 1] },
      contextWith({ ids: prefixedIds('x') }),
    );
    expect(currentContext().ids).toBe(outer.ids);
  });
});
