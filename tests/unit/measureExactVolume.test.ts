/**
 * mass_properties / mass_properties on kernel results: the exact B-rep volume when the kernel has
 * topology (OCC), else the display-mesh volume — `data.method` says which.
 */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ShapeTopology } from '@core/geometry/kernel';
import { fakeKernel, TETRA } from '../helpers/fakeKernel';

const TOPOLOGY: ShapeTopology = { solids: 1, faces: [], edges: [], vertices: 4, volume: 0.17 };

function unionOfTwoBoxes(topology: ShapeTopology | null): {
  doc: CadDocument;
  id: string;
  kernel: ReturnType<typeof fakeKernel>;
} {
  const kernel = fakeKernel({ boolean: TETRA, topology });
  const ctx = { ...defaultContext(), kernel };
  const first = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }, ctx);
  const second = execute(first.document, 'add_box', { size: [1, 1, 1] }, ctx);
  const [a, b] = second.document.order;
  const union = execute(second.document, 'boolean_union', { a, b }, ctx);
  return { doc: union.document, id: union.affected[0]!, kernel };
}

describe('mass_properties of a kernel result', () => {
  it('reports the exact B-rep volume when the kernel has topology', () => {
    const { doc, id, kernel } = unionOfTwoBoxes(TOPOLOGY);
    const result = execute(
      doc,
      'mass_properties',
      { entityId: id },
      { ...defaultContext(), kernel },
    );
    expect(result.data).toEqual({ volume: 0.17, volumeUnit: 'mm³', method: 'exact' });
    expect(result.summary).toContain('(exact B-rep)');
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });

  it('falls back to the display mesh without exact topology', () => {
    const { doc, id, kernel } = unionOfTwoBoxes(null);
    const result = execute(
      doc,
      'mass_properties',
      { entityId: id },
      { ...defaultContext(), kernel },
    );
    expect(result.data).toMatchObject({ method: 'mesh' });
    expect((result.data as { volume: number }).volume).toBeCloseTo(1 / 6, 9);
    expect(result.summary).toContain('display mesh');
  });

  it('mass_properties weighs the exact volume', () => {
    const { doc, id, kernel } = unionOfTwoBoxes(TOPOLOGY);
    const result = execute(
      doc,
      'mass_properties',
      { entityId: id, density: 2 },
      { ...defaultContext(), kernel },
    );
    expect(result.data).toMatchObject({ volume: 0.17, mass: 0.34 });
  });

  it('a primitive keeps its analytic volume (no method)', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [2, 3, 4] });
    const result = execute(box.document, 'mass_properties', { entityId: box.affected[0]! });
    expect(result.data).toEqual({ volume: 24, volumeUnit: 'mm³' });
  });
});
