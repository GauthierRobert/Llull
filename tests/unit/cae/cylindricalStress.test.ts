import { describe, expect, it } from 'vitest';
import { axisFrame, cylindricalDisplacement, cylindricalStress, type AxisFrame } from '@cae/results/cylindrical';

const frameOf = (point: [number, number, number], direction: [number, number, number]): AxisFrame => {
  const frame = axisFrame(point, direction);
  if (frame === null) throw new Error('degenerate axis');
  return frame;
};
const unitZ = frameOf([0, 0, 0], [0, 0, 5]);

describe('cylindrical components of the nodal stress', () => {
  it('rotates a hand-made tensor into hoop / radial / axial at a point on +X and on +Y', () => {
    // [xx, yy, zz, xy, yz, zx]
    const tensor = [10, 20, 30, 4, 5, 6];
    const onX = cylindricalStress(tensor, [2, 0, 7], unitZ);
    expect(onX).toEqual({ radial: 10, hoop: 20, axial: 30 });
    const onY = cylindricalStress(tensor, [0, 3, 1], unitZ);
    expect(onY).toEqual({ radial: 20, hoop: 10, axial: 30 });
    const diagonal = cylindricalStress(tensor, [1, 1, 0], unitZ);
    expect(diagonal.radial).toBeCloseTo(15 + 4, 12);
    expect(diagonal.hoop).toBeCloseTo(15 - 4, 12);
  });

  it('gives a thin pressure vessel hoop = p r / t, axial = p r / 2t and radial ~ 0 at any angle', () => {
    const [p, r, t] = [2, 50, 2];
    const hoop = (p * r) / t;
    const axial = hoop / 2;
    for (const angle of [0.3, 1.1, 2.9, -2]) {
      const [c, s] = [Math.cos(angle), Math.sin(angle)];
      // Cartesian tensor of (radial 0, hoop, axial) about z at that angle
      const tensor = [hoop * s * s, hoop * c * c, axial, -hoop * s * c, 0, 0];
      const read = cylindricalStress(tensor, [r * c, r * s, 12], unitZ);
      expect(read.hoop).toBeCloseTo(hoop, 9);
      expect(read.axial).toBeCloseTo(axial, 9);
      expect(read.radial).toBeCloseTo(0, 9);
    }
  });

  it('honours an offset, tilted axis and has no radial / hoop on the axis itself', () => {
    const tilted = frameOf([1, 1, 0], [1, 0, 0]);
    const tensor = [7, 1, 2, 0, 0, 0];
    expect(cylindricalStress(tensor, [9, 1, 4], tilted).radial).toBe(2);
    expect(cylindricalStress(tensor, [9, 1, 4], tilted).axial).toBe(7);
    expect(cylindricalStress(tensor, [3, 1, 0], tilted).radial).toBeNaN();
    expect(cylindricalStress(tensor, [3, 1, 0], tilted).axial).toBe(7);
    expect(Number.isNaN(cylindricalStress([1, 2], [1, 0, 0], unitZ).hoop)).toBe(false);
  });

  it('projects a displacement on the radial direction', () => {
    expect(cylindricalDisplacement([0.5, 0.25, 9], [4, 0, 0], unitZ)).toBeCloseTo(0.5, 12);
    expect(cylindricalDisplacement([0.5, 0.25, 9], [0, -4, 0], unitZ)).toBeCloseTo(-0.25, 12);
    expect(cylindricalDisplacement([0.5, 0.25, 9], [0, 0, 3], unitZ)).toBeNaN();
  });

  it('rejects a zero axis direction', () => {
    expect(axisFrame([0, 0, 0], [0, 0, 0])).toBeNull();
  });
});
