import { describe, beforeAll, afterAll, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { kernelPlans } from './plans';
import { describePlans } from './describePlans';

describe('golden replay corpus (Manifold kernel)', () => {
  let previousKernel: GeometryKernel | null;

  beforeAll(async () => {
    previousKernel = getGeometryKernel();
    setGeometryKernel(await createManifoldKernel());
  }, 60_000);

  afterAll(() => setGeometryKernel(previousKernel));
  describePlans(kernelPlans);

  // SC-Q3 fuzz seed 2274 (fixed): cylinder R7.5 inside cylinder R10, same height, internally tangent: A - B is empty.
  it('a tangent subtract with an empty result is a no-op that keeps both operands', () => {
    let doc = execute(createEmptyDocument(), 'add_cylinder', { radius: 7.5, height: 25, position: [0, 0, 0] }).document;
    doc = execute(doc, 'add_cylinder', { radius: 10, height: 25, position: [2.5, 0, 0] }).document;
    const [a, b] = doc.order as [string, string];
    const result = execute(doc, 'boolean', { op: 'subtract', a, b });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('is empty');
  });

  // SC-Q2 action matrix: boxes that only touch within 4e-16 leave a flat 4-triangle sheet, which is not a solid.
  it('an intersect that leaves a zero-thickness sheet is a no-op', () => {
    let doc = execute(createEmptyDocument(), 'add_box', { size: [10, 0.3, 3], position: [0, 0, 1.5] }).document;
    doc = execute(doc, 'add_box', { size: [10.3, 8.3, 0.2], position: [0, 4, 3.1] }).document;
    const [a, b] = doc.order as [string, string];
    const result = execute(doc, 'boolean', { op: 'intersect', a, b });
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });
});
