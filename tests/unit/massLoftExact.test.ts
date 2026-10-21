import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExactMassProperties } from '@core/geometry/kernelPorts';
import { fakeKernel } from '../helpers/fakeKernel';
import { expectPure } from '../helpers/expectNoOp';

/** LIM-1 (7): mass_properties of a loft reads the exact kernel B-rep when the kernel integrates it, else the display mesh. */

const EXACT: ExactMassProperties = {
  volume: 29.32,
  area: 40,
  centroid: [0, 0, 2.5],
  inertiaAtCentroid: [10, 10, 5, 0, 0, 0],
  bounds: { min: [-2, -2, 0], max: [2, 2, 4] },
  relError: 1e-9,
};

interface MassData {
  method: string;
  mass?: number;
  volume: number;
  area: number;
  centroid: number[];
  relErrorEstimate?: number;
  reviewRequired: { reasons: string[] };
}

function loftDoc(): { doc: CadDocument; id: string } {
  const result = execute(createEmptyDocument(), 'loft_sections', {
    sections: [
      { center: [0, 0, 0], radius: 1 },
      { center: [0, 0, 4], radius: 2 },
    ],
    ruled: true,
  });
  return { doc: result.document, id: result.affected[0] ?? '' };
}

describe('mass_properties of a loft', () => {
  it('uses the exact kernel mass properties of the loft B-rep when the kernel has them', () => {
    const { doc, id } = loftDoc();
    const evaluated: string[] = [];
    const base = fakeKernel();
    const kernel: GeometryKernel = {
      ...base,
      massProperties: () => EXACT,
      evaluate: (recipe) => {
        evaluated.push(recipe.op === 'solid' ? recipe.entity.kind : recipe.op);
        return base.evaluate(recipe);
      },
    };
    const ctx = { ...defaultContext(), kernel };
    const result = execute(doc, 'mass_properties', { entityId: id, density: 2 }, ctx);
    const data = result.data as MassData;
    expect(data.method).toBe('exact');
    expect(data.volume).toBeCloseTo(29.32, 9);
    expect(data.mass).toBeCloseTo(2 * 29.32, 9);
    expect(data.area).toBe(40);
    expect(data.centroid).toEqual([0, 0, 2.5]);
    expect(data.relErrorEstimate).toBe(1e-9);
    expect(data.reviewRequired.reasons).not.toContain('method_mesh');
    expect(evaluated).toContain('loft');
    expectPure(doc, () => execute(doc, 'mass_properties', { entityId: id, density: 2 }, ctx));
  });

  it('keeps the mesh path without a kernel', () => {
    const { doc, id } = loftDoc();
    const data = execute(doc, 'mass_properties', { entityId: id }, { ...defaultContext(), kernel: null }).data as MassData;
    expect(data.method).toBe('mesh');
    expect(data.volume / ((Math.PI * 4 * 7) / 3)).toBeCloseTo(1, 1);
    expect(data.reviewRequired.reasons).toContain('method_mesh');
  });

  it('keeps the mesh path with a kernel that cannot integrate the shape (no massProperties port, or null)', () => {
    const { doc, id } = loftDoc();
    const meshOnly: GeometryKernel = fakeKernel({ topology: { solids: 1, faces: [], edges: [], vertices: 0, volume: 999 } });
    expect((execute(doc, 'mass_properties', { entityId: id }, { ...defaultContext(), kernel: meshOnly }).data as MassData).method).toBe(
      'mesh',
    );
    const silent: GeometryKernel = { ...fakeKernel(), massProperties: () => null };
    const data = execute(doc, 'mass_properties', { entityId: id }, { ...defaultContext(), kernel: silent }).data as MassData;
    expect(data.method).toBe('mesh');
    expect(data.volume).not.toBe(999);
  });
});
