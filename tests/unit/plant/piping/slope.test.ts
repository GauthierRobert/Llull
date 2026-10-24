/** Slope (02 RTE §5.6, M3): sloped legs from planLength + slope, the elbow at the real turn angle, stored leg slopes and the slope maths. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { buildPath } from '../../../../packages/domain-aec/src/plant/piping/legs';
import { legFall, slopeRatio, slopedLeg, validSlope } from '../../../../packages/domain-aec/src/plant/piping/slope';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line } from './rteFixtures';

const FALL_1_PERCENT = { value: 1, unit: 'percent', fall: true } as const;

/** SC-RTE-04: DN50 drain from (0,0,1000) +X, down to a hub at (8000,0,0). */
function drainScene(): { doc: ReturnType<typeof cs150Line>['doc']; lineId: string; from: string; to: string } {
  const line = cs150Line(50, '3001');
  const a = addTie(line.doc, 'TP-D1', [0, 0, 1000], [1, 0, 0], { dn: 50 });
  const b = addTie(a.doc, 'TP-D2', [8000, 0, 0], [0, 0, 1], { dn: 50 });
  return { doc: b.doc, lineId: line.lineId, from: a.id, to: b.id };
}

const drainLegs = [{ direction: '+X', planLength: 8000, slope: FALL_1_PERCENT }];

describe('slope maths', () => {
  it('converts percent, ratio and degrees to a drop ratio', () => {
    expect(slopeRatio({ value: 1, unit: 'percent' })).toBeCloseTo(0.01, 12);
    expect(slopeRatio({ value: 0.02, unit: 'ratio' })).toBe(0.02);
    expect(slopeRatio({ value: 1, unit: 'deg' })).toBeCloseTo(Math.tan(Math.PI / 180), 12);
  });

  it('accepts slopes above 0 up to 45 degrees only', () => {
    expect(validSlope({ value: 100, unit: 'percent' })).toBe(true);
    expect(validSlope({ value: 45, unit: 'deg' })).toBe(true);
    expect(validSlope({ value: 101, unit: 'percent' })).toBe(false);
    expect(validSlope({ value: 0, unit: 'ratio' })).toBe(false);
    expect(validSlope({ value: Number.NaN, unit: 'ratio' })).toBe(false);
  });

  it('1 % over 8000 mm: drop 80, length 8000.39999, angle 0.572939 degrees; reading the leg back gives the same fall', () => {
    const leg = slopedLeg([1, 0, 0], 8000, { ...FALL_1_PERCENT });
    expect(leg.dropMm).toBeCloseTo(80, 9);
    expect(leg.length).toBeCloseTo(Math.sqrt(8000 ** 2 + 80 ** 2), 9);
    const back = legFall(leg.direction, leg.length);
    expect(back.dropMm).toBeCloseTo(80, 9);
    expect(back.planLengthMm).toBeCloseTo(8000, 9);
    expect(back.slopeDeg).toBeCloseTo(0.572939, 6);
  });

  it('a rising leg has a negative drop', () => {
    const leg = slopedLeg([0, 1, 0], 1000, { value: 2, unit: 'percent', fall: false });
    expect(leg.dropMm).toBeCloseTo(-20, 9);
    expect(leg.direction[2]).toBeGreaterThan(0);
  });
});

describe('buildPath with sloped legs', () => {
  it('carries the declared slope of each merged leg (the closing leg and via legs have none)', () => {
    const path = buildPath(
      { point: [0, 0, 1000], direction: [1, 0, 0] },
      { point: [8000, 0, 0], direction: [0, 0, 1] },
      [{ direction: '+X', planLength: 8000, slope: FALL_1_PERCENT }],
      [],
      1,
    );
    expect(path.ok).toBe(true);
    if (!path.ok) return;
    expect(path.legSlopes).toEqual([FALL_1_PERCENT, null]);
    expect(path.points[1]?.[2]).toBeCloseTo(920, 9);
    expect(path.closingLeg).toMatchObject({ direction: '-Z' });
  });

  it('merges collinear legs and keeps the first declared slope', () => {
    const path = buildPath(
      { point: [0, 0, 1000] },
      undefined,
      [
        { direction: '+X', length: 1000 },
        { direction: '+X', length: 1000 },
        { direction: '+Y', planLength: 500, slope: FALL_1_PERCENT },
        { direction: '+Y', planLength: 500, slope: FALL_1_PERCENT },
      ],
      [],
      1,
    );
    expect(path.ok).toBe(true);
    if (path.ok) expect(path.legSlopes).toEqual([null, FALL_1_PERCENT]);
  });

  it.each([
    ['a vertical direction', { direction: '+Z', planLength: 100, slope: FALL_1_PERCENT }],
    ['no planLength', { direction: '+X', length: 100, slope: FALL_1_PERCENT }],
    ['planLength and length', { direction: '+X', length: 100, planLength: 100, slope: FALL_1_PERCENT }],
    ['planLength without slope', { direction: '+X', planLength: 100 }],
    ['a slope over 100 %', { direction: '+X', planLength: 100, slope: { value: 101, unit: 'percent', fall: true } }],
  ] as const)('refuses %s with RTE_SLOPE_INVALID naming the leg', (_name, leg) => {
    const path = buildPath({ point: [0, 0, 0] }, undefined, [leg], [], 1);
    expect(path.ok).toBe(false);
    if (!path.ok) {
      expect(path.code).toBe('RTE_SLOPE_INVALID');
      expect(path.detail).toMatchObject({ leg: 0 });
    }
  });
});

describe('route_pipe: SC-RTE-04 gravity drain', () => {
  it('drop 80, length 8000.39999, slope 0.572939 degrees, the 89.427 degree turn is a standard 90 LR elbow, cuts 7924.39999 / 844', () => {
    const s = drainScene();
    const route = data<{
      runId: string;
      legs: Array<{ lengthMm: number; dropMm?: number; planLengthMm?: number; slopeDeg?: number; cutLengthsMm: number[] }>;
      turns: Array<{ turnDeg: number; deviationDeg: number; fitting: string }>;
      portDeviationDeg: { start: number };
    }>(s.doc, 'route_pipe', { lineId: s.lineId, from: { portId: s.from }, to: { portId: s.to }, legs: drainLegs });
    expect(route.legs[0]).toMatchObject({ dropMm: 80, planLengthMm: 8000 });
    expect(route.legs[0]?.lengthMm).toBeCloseTo(8000.39999, 4);
    expect(route.legs[0]?.slopeDeg).toBeCloseTo(0.572939, 6);
    expect(route.legs[0]?.cutLengthsMm[0]).toBeCloseTo(7924.39999, 3);
    expect(route.legs[1]?.cutLengthsMm[0]).toBeCloseTo(844, 6);
    expect(route.legs[1]).not.toHaveProperty('dropMm');
    expect(route.turns[0]).toMatchObject({ fitting: 'elbow90LR' });
    expect(route.turns[0]?.turnDeg).toBeCloseTo(89.427061, 6);
    expect(route.turns[0]?.deviationDeg).toBeCloseTo(0.572939, 6);
    expect(route.portDeviationDeg.start).toBeCloseTo(0.572939, 6);
  });

  it('stores the declared leg slopes with the run', () => {
    const s = drainScene();
    const doc = apply(s.doc, 'route_pipe', { lineId: s.lineId, from: { portId: s.from }, to: { portId: s.to }, legs: drainLegs });
    const run = doc.plant?.piping?.runs[doc.plant.piping.runOrder[0] as string];
    expect(run?.legSlopes).toEqual([FALL_1_PERCENT, null]);
  });

  it('the same route with angleToleranceDeg 0.5 is refused at the elbow (0.573 deg deviation); the sloped first leg is judged on its plan direction', () => {
    const s = drainScene();
    expectRefusal(
      s.doc,
      'route_pipe',
      { lineId: s.lineId, from: { portId: s.from }, to: { portId: s.to }, legs: drainLegs, angleToleranceDeg: 0.5 },
      'RTE_NO_FITTING_FOR_ANGLE',
    );
  });

  it('refuses a slope on a vertical leg with RTE_SLOPE_INVALID and leaves the document untouched', () => {
    const s = drainScene();
    const result = expectRefusal(
      s.doc,
      'route_pipe',
      { lineId: s.lineId, from: { portId: s.from }, legs: [{ direction: '-Z', planLength: 100, slope: FALL_1_PERCENT }] },
      'RTE_SLOPE_INVALID',
      'legs.0.direction',
    );
    expect(result.error?.detail).toMatchObject({ leg: 0 });
  });

  it('is pure', () => {
    const s = drainScene();
    const before = JSON.stringify(s.doc);
    execute(s.doc, 'route_pipe', { lineId: s.lineId, from: { portId: s.from }, to: { portId: s.to }, legs: drainLegs });
    expect(JSON.stringify(s.doc)).toBe(before);
  });
});

describe('add_branch with a sloped leg', () => {
  it('stores the declared slope on the branch run (a drain falling away from the header)', () => {
    const { doc: withLine, lineId } = cs150Line();
    const a = addTie(withLine, 'A', [0, 0, 2000], [1, 0, 0]);
    const header = apply(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 4000 }] });
    const headerId = header.plant?.piping?.runOrder[0] as string;
    const branch = ok(header, 'add_branch', {
      runId: headerId,
      at: { leg: 0, distance: 2000 },
      dn: 100,
      legs: [{ direction: '-Y', planLength: 2000, slope: FALL_1_PERCENT }],
    });
    const branchRun = branch.document.plant?.piping?.runs[(branch.data as { branchRunId: string }).branchRunId];
    expect(branchRun?.legSlopes).toEqual([FALL_1_PERCENT]);
    expect(branchRun?.end.point[2]).toBeCloseTo(2000 - 20, 9);
  });
});
