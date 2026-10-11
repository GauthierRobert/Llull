import { describe, it, expect, afterEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, type MeshData, setGeometryKernel } from '@core/geometry/kernel';
import { fakeKernel } from '../helpers/fakeKernel';

const kernelReturning = (mesh: MeshData | null): GeometryKernel => fakeKernel({ boolean: mesh });

describe('boolean edge cases', () => {
  afterEach(() => setGeometryKernel(null));

  const first = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
  const second = execute(first.document, 'add_box', { size: [1, 1, 1], position: [10, 0, 0] });
  const doc = second.document;
  const [idA, idB] = [first.affected[0]!, second.affected[0]!];

  it('an empty kernel result keeps both operands instead of consuming them', () => {
    setGeometryKernel(kernelReturning({ positions: [], indices: [] }));
    const result = execute(doc, 'boolean_intersect', { a: idA, b: idB });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('is empty');
  });

  it('a non-empty result still replaces the operands', () => {
    setGeometryKernel(
      kernelReturning({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }),
    );
    const result = execute(doc, 'boolean_union', { a: idA, b: idB });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[idA]).toBeUndefined();
  });

  it('rejects component instances with a pointer to explode_instance', () => {
    setGeometryKernel(
      kernelReturning({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }),
    );
    const component = execute(doc, 'create_component', {
      name: 'Part',
      entityIds: [idA],
      componentId: 'comp-part',
    });
    const instanceId = component.affected[0]!;
    const result = execute(component.document, 'boolean_union', { a: instanceId, b: idB });
    expect(result.document).toBe(component.document);
    expect(result.summary).toContain('explode_instance');
  });
});
