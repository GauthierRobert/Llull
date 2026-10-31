/**
 * BLD M5 (13.32.5): the stations of a blend_union joint on uneven-speed edges. The joint is not an edge of the result, so check_blends reads the law along the spine
 * points the kernel puts in the contour note (jointStations), over a synthetic ellipse (parameter speed 2 : 1).
 */
import { describe, expect, it } from 'vitest';
import { jointStations } from '@core/commands/brep/spineStations';
import type { BlendSection } from '@core/geometry/kernelPorts';
import type { Vec3 } from '@core/model/types';

const ellipse = (phase: number): Vec3 => [6 * Math.cos(phase), 3 * Math.sin(phase), 0];
const spine = (closed: boolean): Vec3[] =>
  Array.from({ length: 401 }, (_, k) => ellipse((2 * Math.PI * Math.min(k, closed ? 400 : 200)) / 400));
const section = (point: Vec3, t = 0): BlendSection => ({ t, a: point, mid: point, b: point, radius: 0.5, centre: null });

describe('jointStations', () => {
  it('a closed ellipse joint: the stations are arc fractions (the quarter point is 1/4 of the arc by symmetry, a point at phase 0.4 is not 0.4/(2 pi))', () => {
    const phases = [0, 0.4, Math.PI / 2, Math.PI];
    const read = jointStations(
      spine(true),
      phases.map((phase) => section(ellipse(phase))),
    );
    expect('stations' in read).toBe(true);
    if (!('stations' in read)) return;
    expect(read.closed).toBe(true);
    expect(read.stations[0]).toBeCloseTo(0, 6);
    expect(read.stations[2]).toBeCloseTo(0.25, 4);
    expect(read.stations[3]).toBeCloseTo(0.5, 4);
    // the parameter fraction of phase 0.4 is 0.0637; the arc fraction (x is the long axis) is smaller
    expect(read.stations[1]).toBeLessThan(0.0637 - 0.005);
    expect(read.stations[1]).toBeGreaterThan(0.03);
  });

  it('an open joint is not closed and its stations run from 0 to 1', () => {
    const read = jointStations(
      spine(false),
      [0, 100, 200].map((k) => section(ellipse((2 * Math.PI * k) / 400))),
    );
    expect('stations' in read && read.closed).toBe(false);
    if ('stations' in read) {
      expect(read.stations[0]).toBeCloseTo(0, 6);
      expect(read.stations[2]).toBeCloseTo(1, 6);
    }
  });

  it('sections that all project to one point, or an unusable spine, are a reason and never a guess', () => {
    const same = jointStations(spine(true), [section(ellipse(1)), section(ellipse(1))]);
    expect(same).toMatchObject({ reason: expect.stringContaining('all project to one point') });
    expect(jointStations([], [section(ellipse(1))])).toMatchObject({ reason: expect.stringContaining('cannot sample') });
    const back = jointStations(spine(false), [section(ellipse(1)), section(ellipse(2)), section(ellipse(0.5))]);
    expect(back).toMatchObject({ reason: expect.stringContaining('jumps backwards') });
  });
});
