import { describe, it, expect, afterEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import type { GeometryKernel } from '@core/geometry/kernel';
import { fakeKernel } from '../helpers/fakeKernel';

const MESH = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
const kernel: GeometryKernel = fakeKernel({
  solid: MESH,
  boolean: MESH,
  fillet: MESH,
  chamfer: MESH,
  shell: MESH,
});

function constrainedBoxes(): { doc: CadDocument; a: string; b: string } {
  const first = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const second = execute(first.document, 'add_box', { size: [1, 1, 1], position: [5, 0, 0] });
  const a = first.affected[0]!;
  const b = second.affected[0]!;
  const constrained = execute(second.document, 'add_constraint', {
    constraint: { kind: 'distance', a: { entityId: a }, b: { entityId: b }, value: 5 },
  });
  return { doc: constrained.document, a, b };
}

const NOTE = 'Also removed 1 constraint/joint/drive record(s)';

describe('commands that consume entities report the constraints they drop', () => {
  afterEach(() => setGeometryKernel(null));
  const { doc, a, b } = constrainedBoxes();

  it('boolean ops prune and report constraints on consumed operands', () => {
    setGeometryKernel(kernel);
    const result = execute(doc, 'boolean_union', { a, b });
    expect(result.document.constraints).toEqual({});
    expect(result.document.constraintOrder).toEqual([]);
    expect(result.summary).toContain(NOTE);
  });

  it('fillet/shell prune and report constraints on the consumed solid', () => {
    setGeometryKernel(kernel);
    for (const [name, params] of [
      ['fillet_edge', { id: a, radius: 0.1 }],
      ['shell_solid', { id: a, thickness: 0.1 }],
    ] as const) {
      const result = execute(doc, name, params);
      expect(result.document.constraints).toEqual({});
      expect(result.summary).toContain(NOTE);
    }
  });

  it('create_component reports constraints on entities moved into the component', () => {
    const result = execute(doc, 'create_component', { name: 'P', entityIds: [a] });
    expect(result.document.constraints).toEqual({});
    expect(result.summary).toContain(NOTE);
  });

  it('explode_polyline reports constraints on the exploded polyline', () => {
    const poly = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [4, 0],
        [4, 4],
      ],
    });
    const polyId = poly.affected[0]!;
    const constrained = execute(poly.document, 'add_constraint', {
      constraint: { kind: 'coincident', a: { entityId: polyId }, b: { entityId: a } },
    });
    const result = execute(constrained.document, 'explode_polyline', { id: polyId });
    expect(result.summary).toContain(NOTE);
    expect(Object.keys(result.document.constraints)).toHaveLength(1);
  });

  it('an operation that drops nothing adds no note', () => {
    const lone = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const other = execute(lone.document, 'add_box', { size: [1, 1, 1] });
    setGeometryKernel(kernel);
    const result = execute(other.document, 'boolean_union', {
      a: lone.affected[0]!,
      b: other.affected[0]!,
    });
    expect(result.summary).not.toContain('Also removed');
  });
});
