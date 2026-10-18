import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { bendK, frictionFactor, pipeRoughnessMm, waterDensity, waterViscosity } from '@aec/industrial/piping/pipeFlow';
import { twoLevels, step } from './steelFixtures';
import { expectNoOp } from '../../helpers/expectNoOp';
import { xyz } from '../../helpers/xy';

interface Hydraulics {
  diameter: { insideMm: number };
  velocityMS: number;
  reynolds: number;
  regime: string;
  friction: { factor: number; roughnessMm: number };
  bends: Array<{ deflectionDegrees: number; k: number }>;
  fittingsK: { total: number };
  losses: { straightKPa: number; fittingsKPa: number; staticKPa: number };
  pressureDrop: { kPa: number; bar: number };
  warnings: string[];
}

const pipeDoc = (points: ReadonlyArray<readonly [number, number, number]>, extra: Record<string, unknown> = {}): CadDocument =>
  step(twoLevels(), 'add_pipe_run', { levelId: 'level-1', dn: 100, points, ...extra });
const straight = (): CadDocument => pipeDoc(xyz(0, 0, 500, 100000, 0, 500));
const hydraulics = (doc: CadDocument, params: Record<string, unknown>): Hydraulics =>
  execute(doc, 'pipe_hydraulics', { pipeId: 'pipe-1', ...params }).data as Hydraulics;

/** Independent Colebrook-White solution by bisection on the residual. */
function colebrookByBisection(reynolds: number, relative: number): number {
  const residual = (f: number): number => 1 / Math.sqrt(f) + 2 * Math.log10(relative / 3.7 + 2.51 / (reynolds * Math.sqrt(f)));
  let [low, high] = [0.005, 0.2];
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    if (residual(mid) > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

describe('pipe_hydraulics', () => {
  it('is a read-only registered tool and pure', () => {
    expect(getCommand('pipe_hydraulics')?.annotations).toEqual({ readOnly: true, idempotent: true });
    const doc = straight();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'pipe_hydraulics', { pipeId: 'pipe-1', flowM3h: 50 });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('matches the hand calculation: DN100 water 20 °C, 50 m³/h, 100 m straight', () => {
    const data = hydraulics(straight(), { flowM3h: 50 });
    const d = 0.10226;
    const rho = 998.2;
    const mu = 1.002e-3;
    const v = 50 / 3600 / ((Math.PI / 4) * d * d);
    const re = (rho * v * d) / mu;
    const f = colebrookByBisection(re, 0.045 / 102.26);
    const dp = (f * (100 / d) * rho * v * v) / 2 / 1000;
    expect(data.diameter.insideMm).toBeCloseTo(102.26, 2);
    expect(data.velocityMS).toBeCloseTo(1.69, 2);
    expect(data.reynolds / 1e5).toBeCloseTo(1.72, 1);
    expect(data.friction.factor).toBeCloseTo(0.0188, 4);
    expect(data.friction.factor).toBeCloseTo(f, 4);
    expect(data.losses.straightKPa).toBeCloseTo(dp, 0);
    expect(data.losses.straightKPa).toBeGreaterThan(26);
    expect(data.losses.straightKPa).toBeLessThan(28);
    expect(data.pressureDrop.kPa).toBeCloseTo(dp, 0);
    expect(data.pressureDrop.bar).toBeCloseTo(data.pressureDrop.kPa / 100, 3);
    expect(data.losses.fittingsKPa).toBe(0);
    expect(data.warnings).toEqual([]);
    expect(data.regime).toBe('turbulent');
  });

  it('adds elbow losses from the geometry and static head of a riser', () => {
    // 10 m along X, 90° up 5 m, 90° along X again: 2 bends, rise 5 m, length 20 m.
    const doc = pipeDoc(xyz(0, 0, 0, 10000, 0, 0, 10000, 0, 5000, 20000, 0, 5000));
    const data = hydraulics(doc, { flowM3h: 50, extraK: 1 });
    expect(data.bends.map((bend) => bend.deflectionDegrees)).toEqual([90, 90]);
    expect(data.fittingsK.total).toBeCloseTo(1.6, 5);
    const head = (0.5 * 998.2 * data.velocityMS ** 2 * 1.6) / 1000;
    expect(data.losses.fittingsKPa).toBeCloseTo(head, 1);
    expect(data.losses.staticKPa).toBeCloseTo((998.2 * 9.80665 * 5) / 1000, 1);
    const { straightKPa, fittingsKPa, staticKPa } = data.losses;
    expect(data.pressureDrop.kPa).toBeCloseTo(straightKPa + fittingsKPa + staticKPa, 1);
  });

  it('returns static head for a falling run and warns', () => {
    const data = hydraulics(pipeDoc(xyz(0, 0, 5000, 0, 0, 0)), { flowM3h: 50 });
    expect(data.losses.staticKPa).toBeLessThan(0);
    expect(data.warnings.join(' ')).toContain('falls');
  });

  it('takes mass flow, explicit fluid, roughness and bend type; warns on velocity and laminar flow', () => {
    const doc = straight();
    const mass = hydraulics(doc, { massFlowKgS: (50 / 3600) * 998.2 });
    expect(mass.velocityMS).toBeCloseTo(hydraulics(doc, { flowM3h: 50 }).velocityMS, 2);
    expect(hydraulics(doc, { flowM3h: 50, roughnessMm: 0.15 }).friction.roughnessMm).toBe(0.15);
    const fast = hydraulics(doc, { flowM3h: 100 });
    expect(fast.warnings.join(' ')).toContain('outside the typical');
    const oil = hydraulics(doc, { flowM3h: 5, density: 850, viscosity: 0.1 });
    expect(oil.regime).toBe('laminar');
    expect(oil.friction.factor).toBeCloseTo(64 / oil.reynolds, 3);
    expect(oil.warnings.join(' ')).toContain('laminar');
    const bent = pipeDoc(xyz(0, 0, 0, 5000, 0, 0, 5000, 5000, 0));
    expect(hydraulics(bent, { flowM3h: 50, bendType: 'mitre' }).bends[0]?.k).toBeCloseTo(1.1, 5);
  });

  it('refuses bad input without data or document change', () => {
    const doc = straight();
    const bad: Array<Record<string, unknown>> = [
      { pipeId: 'pipe-9', flowM3h: 50 },
      { flowM3h: 0 },
      { flowM3h: -1 },
      {},
      { flowM3h: 5, massFlowKgS: 1 },
      { flowM3h: 5, density: 0 },
      { flowM3h: 5, viscosity: -1 },
      { flowM3h: 5, roughnessMm: 0 },
      { flowM3h: 5, extraK: -1 },
      { flowM3h: 5, temperatureC: 150 },
    ];
    for (const params of bad) {
      const result = execute(doc, 'pipe_hydraulics', { pipeId: 'pipe-1', ...params });
      expectNoOp(result, doc);
      expect(result.data).toBeUndefined();
    }
  });
});

describe('pipe flow helpers', () => {
  it('water properties at 20 °C and 80 °C', () => {
    expect(waterDensity(20)).toBeCloseTo(998.2, 1);
    expect(waterViscosity(20)).toBeCloseTo(1.002e-3, 5);
    expect(waterDensity(80)).toBeCloseTo(971.8, 1);
    expect(waterViscosity(80)).toBeCloseTo(0.355e-3, 5);
  });
  it('Colebrook converges and laminar is 64/Re', () => {
    expect(frictionFactor(1000, 0.001).f).toBeCloseTo(0.064, 6);
    const { f } = frictionFactor(1e5, 0.0005);
    expect(f).toBeCloseTo(colebrookByBisection(1e5, 0.0005), 8);
  });
  it('roughness by material and bend K by angle', () => {
    expect(pipeRoughnessMm('steel').mm).toBe(0.045);
    expect(pipeRoughnessMm('Stainless 316').mm).toBe(0.015);
    expect(pipeRoughnessMm('PVC').mm).toBe(0.0015);
    expect(pipeRoughnessMm('cast iron').mm).toBe(0.26);
    expect(pipeRoughnessMm('galvanised steel').mm).toBe(0.15);
    expect(bendK('long_radius', 90)).toBeCloseTo(0.3, 6);
    expect(bendK('standard', 45) / bendK('standard', 90)).toBeCloseTo(0.541, 3);
  });
});
