import { describe, it, expect } from 'vitest';
import { cpColor, flowFrame, silhouetteLoop, vertexPressures, windArrows } from '@ui/viewport/3d/aero/aeroGeometry';

const BOUNDS = { min: [0, 0, 0], max: [4, 2, 1] } as const;

describe('aero overlay geometry', () => {
  it('frames the body seen along +X: silhouette spans Y and Z, depth is half the length', () => {
    const frame = flowFrame({ min: [...BOUNDS.min], max: [...BOUNDS.max] }, [1, 0, 0]);
    expect(frame.center).toEqual([2, 1, 0.5]);
    expect(frame.depth).toBeCloseTo(2);
    const widths = [frame.uRange[1] - frame.uRange[0], frame.vRange[1] - frame.vRange[0]].sort();
    expect(widths[0]).toBeCloseTo(1);
    expect(widths[1]).toBeCloseTo(2);
  });
  it('places the silhouette loop downstream and the wind arrows upstream', () => {
    const bounds = { min: [...BOUNDS.min], max: [...BOUNDS.max] } as Parameters<typeof flowFrame>[0];
    const frame = flowFrame(bounds, [1, 0, 0]);
    const loop = silhouetteLoop(frame, [1, 0, 0], 0.5);
    expect(loop).toHaveLength(5);
    for (const point of loop) expect(point[0]).toBeCloseTo(4.5);
    const arrows = windArrows(frame, [1, 0, 0], 1, 0.5);
    expect(arrows).toHaveLength(9);
    for (const arrow of arrows) expect(arrow.origin[0]).toBeCloseTo(-1.5);
  });
  it('colours suction blue, pressure red and zero neutral', () => {
    const [sr, , sb] = cpColor(-2, -2, 1);
    const [pr, , pb] = cpColor(1, -2, 1);
    expect(sb).toBeGreaterThan(sr);
    expect(pr).toBeGreaterThan(pb);
    expect(cpColor(0, -2, 1)[0]).toBeCloseTo(cpColor(0, -2, 1)[2]);
  });
  it('takes each vertex Cp from the nearest panel point', () => {
    const outline: Array<[number, number]> = [
      [0, 0],
      [1, 0.1],
      [1, -0.1],
    ];
    const surface = [
      { x: 0, y: 0, cp: 1 },
      { x: 1, y: 0.1, cp: -1 },
      { x: 1, y: -0.1, cp: -0.5 },
    ];
    expect(vertexPressures(outline, surface)).toEqual([1, -1, -0.5]);
    expect(vertexPressures(outline, [])).toEqual([0, 0, 0]);
  });
});
