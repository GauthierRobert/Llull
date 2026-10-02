import { describe, it, expect, beforeEach } from 'vitest';
import { parseKernelChoice } from '@core/geometry/kernelChoice';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import { defaultContext, type ExecutionContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { __resetIdCounter, type IdSource } from '@lib/id';

describe('parseKernelChoice', () => {
  it.each([
    ['occt', 'occt'],
    ['OCCT', 'occt'],
    [' occt ', 'occt'],
    ['manifold', 'manifold'],
    ['', 'manifold'],
    ['nonsense', 'manifold'],
    [null, 'manifold'],
    [undefined, 'manifold'],
  ] as const)('%j -> %s', (value, expected) => {
    expect(parseKernelChoice(value)).toBe(expected);
  });
});

const FILLETED: MeshData = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };

function makeKernel(): GeometryKernel {
  return {
    booleanOp: () => null,
    filletEdges: () => FILLETED,
    chamferEdges: () => null,
    shellSolid: () => null,
    tessellate: () => FILLETED,
  };
}

function makeContext(kernel: GeometryKernel): ExecutionContext {
  let n = 0;
  const ids: IdSource = { next: (prefix) => `${prefix}-${(n += 1)}` };
  return { ...defaultContext(), kernel, ids };
}

describe('kernel parity across callers', () => {
  beforeEach(() => __resetIdCounter());

  it('the same fillet_edge call yields the same entity for UI-style and server-style contexts', () => {
    const base = execute(
      createEmptyDocument(),
      'add_box',
      { size: [2, 2, 2] },
      makeContext(makeKernel()),
    );
    const boxId = base.affected[0]!;
    const params = { id: boxId, radius: 0.2 };

    const fromUi = execute(base.document, 'fillet_edge', params, makeContext(makeKernel()));
    const fromServer = execute(base.document, 'fillet_edge', params, makeContext(makeKernel()));

    expect(fromUi.affected).toHaveLength(1);
    expect(fromServer.document).toEqual(fromUi.document);
    expect(fromServer.summary).toBe(fromUi.summary);
  });

  it('a context without a kernel is a graceful no-op', () => {
    const base = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const result = execute(
      base.document,
      'fillet_edge',
      { id: base.affected[0]!, radius: 0.2 },
      { ...makeContext(makeKernel()), kernel: null },
    );
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(base.document);
  });
});
