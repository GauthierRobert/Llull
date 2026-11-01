/**
 * DES-6c 13.41: check_blends surfaces the overshoot of a trim corner star (BLD_CHECK_CORNER_OVERSHOOT), read from the corner notes of the blend node. Mock notes; the native values are asserted in
 * server/tests/nativeBlendCurvedCorners.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ShapeRecipe } from '@core/model/types';
import { overshootFindings, shapeFindings } from '@core/commands/brep/checkBlendStars';
import { REMEDIATION } from '@core/commands/brep/checkBlendFindings';

const recipe = { op: 'fillet', source: { op: 'solid' } } as unknown as ShapeRecipe;
const kernelWith = (corners: ReadonlyArray<{ vertex: [number, number, number]; overshoot?: number }>): GeometryKernel =>
  ({ blendReport: () => ({ notes: { corners: corners.map((corner) => ({ ...corner, setbacks: [] })) } }) }) as unknown as GeometryKernel;

describe('overshootFindings', () => {
  it('warns above 1e-6 x the diagonal, naming the value and the vertex', () => {
    const found = overshootFindings(kernelWith([{ vertex: [10, 4.5, 5], overshoot: 0.0143 }]), recipe, 'mesh-1', 'mm', 17.32);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'BLD_CHECK_CORNER_OVERSHOOT',
      severity: 'warn',
      entityId: 'mesh-1',
      value: 0.0143,
      unit: 'mm',
      remediation: REMEDIATION.BLD_CHECK_CORNER_OVERSHOOT,
    });
    expect(found[0]?.message).toContain('0.0143');
  });

  it('fails above the build gate of 1e-3 x the diagonal', () => {
    const found = overshootFindings(kernelWith([{ vertex: [0, 0, 0], overshoot: 0.03 }]), recipe, 'mesh-1', 'mm', 17.32);
    expect(found[0]).toMatchObject({ severity: 'fail', limit: 0.01732 });
  });

  it('says nothing for a tiny overshoot, a corner without the key (analytic, plate, mixed) or no kernel report', () => {
    expect(
      overshootFindings(kernelWith([{ vertex: [0, 0, 0], overshoot: 1e-9 }, { vertex: [1, 1, 1] }]), recipe, 'mesh-1', 'mm', 17.32),
    ).toEqual([]);
    expect(overshootFindings({} as unknown as GeometryKernel, recipe, 'mesh-1', 'mm', 17.32)).toEqual([]);
    expect(overshootFindings(kernelWith([{ vertex: [0, 0, 0], overshoot: 1 }]), recipe, 'mesh-1', 'mm', 0)).toEqual([]);
  });
});

describe('shapeFindings', () => {
  const shaped = (curvatureRatio: number): GeometryKernel =>
    ({
      blendReport: () => ({
        notes: {
          corners: [
            { vertex: [10, 4.5, 5], setbacks: [], shape: { maxCurvature: curvatureRatio * 2, maxNormalTurn: 0.9, curvatureRatio } },
          ],
        },
      }),
    }) as unknown as GeometryKernel;

  it('warns above 10 times the blend curvature, naming the ratio, the curvature and the turn', () => {
    const found = shapeFindings(shaped(70), recipe, 'mesh-1', 'mm');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      code: 'BLD_CHECK_CORNER_SHAPE',
      severity: 'warn',
      value: 70,
      limit: 10,
      remediation: REMEDIATION.BLD_CHECK_CORNER_SHAPE,
    });
    expect(found[0]?.message).toContain('140');
    expect(found[0]?.message).toContain('0.9 rad');
  });

  it('says nothing for the d-shape star (2.8 times), a corner without a shape, or no report', () => {
    expect(shapeFindings(shaped(2.8), recipe, 'mesh-1', 'mm')).toEqual([]);
    expect(shapeFindings(shaped(10), recipe, 'mesh-1', 'mm')).toEqual([]);
    expect(shapeFindings(kernelWith([{ vertex: [0, 0, 0], overshoot: 1 }]), recipe, 'mesh-1', 'mm')).toEqual([]);
    expect(shapeFindings({} as unknown as GeometryKernel, recipe, 'mesh-1', 'mm')).toEqual([]);
  });
});
