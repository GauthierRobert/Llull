/** DES-2c: inspect_sweep curvature from the exact path (arc, Bezier and ellipse derivatives, analytic helix) against closed forms. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CurveSegment } from '@core/model/curve';
import type { Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { pathBendAt } from '@core/geometry/sweepEval/pathCurvature';
import { pathSamplesAt } from '@core/geometry/sweepEval/frames';
import { helixAt, helixBendAtFractions } from '@lib/helix/helix';
import type { HelixDefinition } from '@lib/helix/types';
import { len3, sub3, scale3 } from '@lib/vec3';
import { relError } from '../../helpers/swgPack';
import { xyz } from '../../helpers/xy';

const empty = createEmptyDocument();
const cylinder: HelixDefinition = {
  type: 'helix',
  origin: [0, 0, 0],
  axis: [0, 0, 1],
  radius: 20,
  endRadius: 20,
  turns: 3,
  pitch: 10,
  handedness: 'right',
  startAngle: 0,
};
const kappa = (bend: Vec3): number => len3(bend);

describe('pathBendAt: exact curvature of every path segment type', () => {
  it('a line has none; an arc is 1/R toward its centre', () => {
    const line: CurveSegment<Vec3> = {
      type: 'line',
      points: [
        [0, 0, 0],
        [5, 0, 0],
      ],
    };
    expect(pathBendAt([line], [0, 0.5, 1])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const arc: CurveSegment<Vec3> = {
      type: 'arc',
      points: [
        [50, 0, 0],
        [50 * Math.SQRT1_2, 50 * Math.SQRT1_2, 0],
        [0, 50, 0],
      ],
    };
    for (const bend of pathBendAt([arc], [0, 0.3, 0.5, 1])) expect(relError(kappa(bend), 1 / 50)).toBeLessThan(1e-12);
    const middle = pathBendAt([arc], [0.5])[0] as Vec3;
    expect(middle[0]).toBeCloseTo(-Math.SQRT1_2 / 50, 12);
    expect(middle[1]).toBeCloseTo(-Math.SQRT1_2 / 50, 12);
  });
  it('a cubic Bezier of the parabola y = x^2 follows 2 / (1 + 4 x^2)^(3/2) at the located point', () => {
    const parabola: CurveSegment<Vec3> = {
      type: 'bezier',
      points: [
        [0, 0, 0],
        [1 / 3, 0, 0],
        [2 / 3, 1 / 3, 0],
        [1, 1, 0],
      ],
    };
    const fractions = [0, 0.25, 0.6, 1];
    const located = pathSamplesAt([parabola], fractions);
    pathBendAt([parabola], fractions).forEach((bend, k) => {
      const x = (located[k] as { point: Vec3 }).point[0];
      expect(relError(kappa(bend), 2 / (1 + 4 * x * x) ** 1.5)).toBeLessThan(1e-12);
    });
  });
  it('an ellipse quarter a = 3, b = 2: a/b^2 at the major end, b/a^2 at the minor end', () => {
    const quarter: CurveSegment<Vec3> = {
      type: 'ellipse',
      points: [
        [3, 0, 0],
        [0, 0, 0],
        [0, 2, 0],
      ],
    };
    const [first, last] = pathBendAt([quarter], [0, 1]) as [Vec3, Vec3];
    expect(relError(kappa(first), 3 / 4)).toBeLessThan(1e-12);
    expect(relError(kappa(last), 2 / 9)).toBeLessThan(1e-12);
    expect(first[0]).toBeLessThan(0);
  });
  it('a degenerate arc has no bend', () => {
    const collinear: CurveSegment<Vec3> = {
      type: 'arc',
      points: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
    };
    expect(pathBendAt([collinear], [0.5])[0]).toEqual([0, 0, 0]);
  });
});

describe('helixBendAtFractions: analytic helix', () => {
  it('constant cylindrical helix: R / (R^2 + c^2) everywhere, toward the axis (VC-SWG-12)', () => {
    const lead = 10 / (2 * Math.PI);
    const expected = 20 / (20 ** 2 + lead ** 2);
    for (const bend of helixBendAtFractions(cylinder, [0, 0.1, 0.5, 0.93, 1])) expect(relError(kappa(bend), expected)).toBeLessThan(1e-12);
    const start = helixBendAtFractions(cylinder, [0])[0] as Vec3;
    expect(start[0]).toBeCloseTo(-expected, 12);
    expect(Math.abs(start[2])).toBeLessThan(1e-15);
    expect(relError(1 / expected, 20.12665)).toBeLessThan(1e-6);
  });
  it('a left-handed helix has the same curvature', () => {
    const left = helixBendAtFractions({ ...cylinder, handedness: 'left' }, [0.4])[0] as Vec3;
    expect(relError(kappa(left), 20 / (400 + (10 / (2 * Math.PI)) ** 2))).toBeLessThan(1e-12);
  });
  it('an Archimedean spiral r = r0 + k t: (r^2 + 2 k^2) / (r^2 + k^2)^(3/2) at both ends', () => {
    const spiral: HelixDefinition = { ...cylinder, type: 'spiral', radius: 5, endRadius: 15, turns: 2, pitch: 0 };
    const k = 10 / (2 * Math.PI * 2);
    const closed = (r: number): number => (r * r + 2 * k * k) / (r * r + k * k) ** 1.5;
    const [first, last] = helixBendAtFractions(spiral, [0, 1]) as [Vec3, Vec3];
    expect(relError(kappa(first), closed(5))).toBeLessThan(1e-12);
    expect(relError(kappa(last), closed(15))).toBeLessThan(1e-12);
  });
  it('a conical helix and a pitch-law helix agree with central differences of the exact derivative at the ends', () => {
    const cone: HelixDefinition = { ...cylinder, endRadius: 10, turns: 5 };
    const law: HelixDefinition = { ...cylinder, pitch: { type: 'linear', start: 6, end: 14 }, turns: 4 };
    const reference = (definition: HelixDefinition, theta: number): number => {
      const h = 1e-5;
      const d1 = helixAt(definition, theta).derivative;
      const d2 = scale3(sub3(helixAt(definition, theta + h).derivative, helixAt(definition, theta - h).derivative), 1 / (2 * h));
      const cross: Vec3 = [d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]];
      return len3(cross) / len3(d1) ** 3;
    };
    expect(relError(kappa(helixBendAtFractions(cone, [0])[0] as Vec3), reference(cone, 0))).toBeLessThan(1e-6);
    expect(relError(kappa(helixBendAtFractions(cone, [1])[0] as Vec3), reference(cone, 2 * Math.PI * 5))).toBeLessThan(1e-6);
    expect(relError(kappa(helixBendAtFractions(law, [0])[0] as Vec3), reference(law, 0))).toBeLessThan(1e-5);
  });
});

describe('inspect_sweep curvature', () => {
  it('a tube on the helix reports the closed-form curvature radius (R^2 + c^2) / R at every sample, and a cone helix a varying one', () => {
    const made = execute(empty, 'add_helix', { radius: 20, pitch: 10, turns: 3 });
    const swept = execute(made.document, 'sweep_profile', { pathId: made.affected[0], radius: 2 });
    const data = execute(swept.document, 'inspect_sweep', { id: swept.affected[0] as string, samples: 9 }).data as {
      samples: Array<{ curvatureRadius: number; margin: number }>;
    };
    const lead = 10 / (2 * Math.PI);
    for (const sample of data.samples) {
      expect(relError(sample.curvatureRadius, (400 + lead ** 2) / 20)).toBeLessThan(1e-9);
      // the extent is measured on the 24-point section ring, not on the true circle
      expect(relError(sample.margin, (400 + lead ** 2) / 20 / 2)).toBeLessThan(1e-2);
    }
    const conical = execute(empty, 'add_helix', { radius: 20, endRadius: 10, pitch: 10, turns: 5 });
    const tube = execute(conical.document, 'sweep_profile', { pathId: conical.affected[0], radius: 1 });
    const cone = execute(tube.document, 'inspect_sweep', { id: tube.affected[0] as string, samples: 5 }).data as {
      samples: Array<{ curvatureRadius: number }>;
    };
    expect(cone.samples[4]?.curvatureRadius).toBeLessThan(cone.samples[0]?.curvatureRadius as number);
  });
  it('a pipe elbow of bendRadius 30 reports exactly 30 on the bend and nothing on the straight legs', () => {
    const swept = execute(empty, 'sweep_profile', { path: xyz(0, 0, 0, 100, 0, 0, 100, 100, 0), bendRadius: 30, radius: 5 });
    expect(swept.affected, swept.summary).toHaveLength(1);
    const data = execute(swept.document, 'inspect_sweep', { id: swept.affected[0] as string, samples: 201 }).data as {
      samples: Array<{ curvatureRadius: number | null }>;
    };
    const bends = data.samples.flatMap((s) => (s.curvatureRadius === null ? [] : [s.curvatureRadius]));
    expect(bends.length).toBeGreaterThan(3);
    for (const radius of bends) expect(relError(radius, 30)).toBeLessThan(1e-9);
    expect(data.samples[0]?.curvatureRadius).toBeNull();
  });
});
