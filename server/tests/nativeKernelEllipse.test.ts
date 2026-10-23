/**
 * 03 EQP Q3: the exact `ellipse` curve segment reaches OCCT as a trimmed ellipse (chain type code 3), so a revolved 2:1 ellipsoidal head is an exact
 * B-rep whose volume is the closed form pi D^3 / 24 (core Pappus gives the same number). Skipped with the reason logged when the binary is not built.
 */

import { describe, expect, it } from 'vitest';
import type { ExactMassProperties } from '@core/geometry/kernelPorts';
import type { CurveSegment } from '@core/model/curve';
import type { Vec2 } from '@core/model/types';
import { closedFormVolume } from '@core/geometry/closedFormVolume';
import { sampleProfile } from '@core/geometry/curveSegments';
import { encodeChain } from '../src/native/kernelLeaves';
import { leaf } from './kernelTestSupport';
import { entity } from './nativeKernelCorpus';
import { nativeKernelBinary, nativeReferenceHarness, relative } from './nativeReferenceSupport';

const harness = nativeReferenceHarness();

const head = (diameter: number): CurveSegment<Vec2>[] => [
  {
    type: 'line',
    points: [
      [0, 0],
      [diameter / 2, 0],
    ],
  },
  {
    type: 'ellipse',
    points: [
      [diameter / 2, 0],
      [0, 0],
      [0, diameter / 4],
    ],
  },
  {
    type: 'line',
    points: [
      [0, diameter / 4],
      [0, 0],
    ],
  },
];

describe.skipIf(nativeKernelBinary === null)('native kernel: exact ellipse segment', () => {
  it.each([1, 3.2, 1000])('a revolved 2:1 head of diameter %f has the closed-form volume pi D^3 / 24', async (diameter) => {
    const curves = head(diameter);
    const solid = entity('revolution', { profile: sampleProfile(curves), curves, axis: [0, 1, 0], angle: 2 * Math.PI, segments: 32 });
    const mass = (await harness.on('massProperties', leaf(solid))) as ExactMassProperties;
    const exact = (Math.PI * diameter ** 3) / 24;
    const error = relative(mass.volume, exact);
    console.warn(`[ellipse segment] D = ${diameter}: OCC volume ${mass.volume} vs ${exact}, relative error ${error.toExponential(2)}`);
    expect(error).toBeLessThan(1e-6);
    expect(relative(closedFormVolume(solid)?.volume ?? 0, exact)).toBeLessThan(1e-12);
  });

  it('a sheared (non-perpendicular conjugate) quarter keeps the same area as its principal-axes ellipse', async () => {
    // u = (2, 0), v = (1, 1): ellipse area pi |u x v| = 2 pi, so the quarter between u and v has area pi/2 and the closed form must agree.
    const curves: CurveSegment<Vec2>[] = [
      {
        type: 'line',
        points: [
          [3, 0],
          [4, 0],
        ],
      },
      {
        type: 'ellipse',
        points: [
          [4, 0],
          [2, 0],
          [3, 1],
        ],
      },
      {
        type: 'line',
        points: [
          [3, 1],
          [3, 0],
        ],
      },
    ];
    const solid = entity('revolution', { profile: sampleProfile(curves), curves, axis: [0, 1, 0], angle: 2 * Math.PI, segments: 32 });
    const mass = (await harness.on('massProperties', leaf(solid))) as ExactMassProperties;
    const exact = closedFormVolume(solid)?.volume ?? 0;
    expect(exact).toBeGreaterThan(0);
    expect(relative(mass.volume, exact)).toBeLessThan(1e-6);
  });
});

describe('native kernel wire form', () => {
  it('encodes an ellipse segment as type code 3 followed by start, centre, end', () => {
    expect(
      encodeChain([
        {
          type: 'ellipse',
          points: [
            [2, 0, 0],
            [0, 0, 0],
            [0, 1, 0],
          ],
        },
      ]),
    ).toEqual([3, 2, 0, 0, 0, 0, 0, 0, 1, 0]);
  });
});
