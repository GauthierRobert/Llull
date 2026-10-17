/** PHY-03: the reciprocity warning of compute_view_factors (a deliberately skewed exchange area stands in for a quadrature failure). */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../packages/core/src/lib/viewFactorContour', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../packages/core/src/lib/viewFactorContour')>();
  return {
    ...actual,
    exchangeArea: (from: Parameters<typeof actual.exchangeArea>[0], to: Parameters<typeof actual.exchangeArea>[1]): number =>
      actual.exchangeArea(from, to) * (from.centroid[2] > to.centroid[2] ? 1.01 : 1),
  };
});

describe('compute_view_factors reciprocity', () => {
  it('warns THM_VIEW_FACTOR_RECIPROCITY above 1e-3 and names the pair', async () => {
    vi.resetModules();
    const { execute } = await import('@core/commands/registry');
    const { createEmptyDocument } = await import('@core/model/types');
    const square = (z: number, flip: boolean): { name: string; vertices: [number, number, number][]; flip: boolean } => ({
      name: flip ? 'top' : 'bottom',
      vertices: [
        [0, 0, z],
        [1, 0, z],
        [1, 1, z],
        [0, 1, z],
      ],
      flip,
    });
    const doc = createEmptyDocument();
    const result = execute(doc, 'compute_view_factors', { lengthUnit: 'm', surfaces: [square(0, false), square(1, true)] });
    const data = result.data as { reciprocityMaxError: number; findings: { code: string; message: string; remediation: string }[] };
    expect(data.reciprocityMaxError).toBeGreaterThan(1e-3);
    expect(data.findings[0]).toMatchObject({ code: 'THM_VIEW_FACTOR_RECIPROCITY', remediation: 'refine maxFacetSize' });
    expect(data.findings[0]?.message).toContain('bottom/top');
    expect(result.summary).toContain('THM_VIEW_FACTOR_RECIPROCITY');
  });
});
