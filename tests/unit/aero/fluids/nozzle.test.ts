import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import cea from '../../../../docs/aerospace/11-fluid-dynamics-propulsion/validation/data/nasa_cea_reference.json';
import engines from '../../../../docs/aerospace/11-fluid-dynamics-propulsion/validation/data/engines_published.json';
import contour from '../../../../docs/aerospace/11-fluid-dynamics-propulsion/validation/data/nozzle_contour_references.json';
import { data, expectRefusal } from '../sheetmetal/helpers';

interface Nozzle {
  cStarMS: number;
  throat: { temperatureK: number; pressurePa: number };
  exit: { mach: number; pressurePa: number; velocityMS: number };
  thrustCoefficient: { vacuum: number; ambient: number };
  ispS: { vacuum: number; ambient: number };
  optimumExpansionRatio: number | null;
  expansionState: string;
  inputs: { expansionRatio: number; divergence: { factor: number }; ambient: { pressurePa: number; defaulted: boolean } };
  sizing?: { throatDiameterM: number; massFlowKgS: number; thrustVacuumN: number; thrustN: number; exitDiameterM: number };
  warnings: string[];
}

const doc = createEmptyDocument();
const relErr = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

describe('nozzle_performance (VC-FLD-10..15)', () => {
  it('RP-1311 Example 8 (CEA2 Fortran 2004): c* from the chamber state within 0.5 %', () => {
    const ref = cea.rp1311_example8.cea2Fortran2004;
    const result = data<Nozzle>(doc, 'nozzle_performance', {
      chamberPressure: 53.3172,
      pressureUnit: 'bar',
      chamberTemperatureK: ref.chamberTemperatureK,
      gamma: ref.gammaChamber,
      molarMass: ref.molarMassChamber,
      expansionRatio: 25,
    });
    expect(relErr(result.cStarMS, ref.cStarMS)).toBeLessThan(cea.acceptance.cStarRel);
    expect(relErr(result.throat.temperatureK, ref.throatTemperatureK)).toBeLessThan(cea.acceptance.throatTemperatureRel);
    expect(relErr(result.ispS.vacuum * 9.80665, ref.eps25.ivacMS)).toBeLessThan(cea.acceptance.ispVsEquilibriumRel);
  });

  it.each(cea.cases)('$id $name: c*, throat temperature and Isp against NASA CEA', (row) => {
    const result = data<Nozzle>(doc, 'nozzle_performance', {
      chamberPressure: row.chamberPressureBar,
      pressureUnit: 'bar',
      chamberTemperatureK: row.chamber.temperatureK,
      gamma: row.chamber.gamma,
      molarMass: row.chamber.molarMass,
      expansionRatio: row.expansionRatio,
      ambientPressure: 1.01325,
    });
    expect(relErr(result.cStarMS, row.cStarMS)).toBeLessThan(cea.acceptance.cStarRel);
    expect(relErr(result.throat.temperatureK, row.throat.temperatureK)).toBeLessThan(cea.acceptance.throatTemperatureRel);
    expect(relErr(result.ispS.vacuum, row.equilibrium.ispVacS)).toBeLessThan(cea.acceptance.ispVsEquilibriumRel);
    expect(relErr(result.ispS.ambient, row.equilibrium.ispSeaLevelS)).toBeLessThan(cea.acceptance.ispVsEquilibriumRel);
    expect(result.ispS.vacuum).toBeGreaterThan(row.frozen.ispVacS);
  });

  it('RS-25: the ideal vacuum Isp bounds the published 452.3 s from above by < 6 %, and the sea-level flow is flagged as separating', () => {
    const rs25 = engines.engines[0] as (typeof engines.engines)[number];
    const lh2 = cea.cases[0] as (typeof cea.cases)[number];
    const result = data<Nozzle>(doc, 'nozzle_performance', {
      chamberPressure: rs25.chamberPressurePsia as number,
      pressureUnit: 'psi',
      chamberTemperatureK: lh2.chamber.temperatureK,
      gamma: lh2.chamber.gamma,
      molarMass: lh2.chamber.molarMass,
      expansionRatio: rs25.expansionRatio,
      altitudeM: 0,
    });
    const excess = result.ispS.vacuum / (rs25.ispVacuumS as number) - 1;
    const [low, high] = engines.acceptance.ispVacRelBand as [number, number];
    expect(excess).toBeGreaterThan(low);
    expect(excess).toBeLessThan(high);
    expect(result.warnings.join(' ')).toContain('separates');
  });

  it('SP-125 A-1 identity: C_F,amb = C_F,vac - ε p_a / p_c (1.768 -> 1.562 at ε 14, 1000 psia, 14.696 psi)', () => {
    const a1 = engines.engines[2] as (typeof engines.engines)[number];
    const result = data<Nozzle>(doc, 'nozzle_performance', {
      chamberPressure: 1000,
      pressureUnit: 'psi',
      chamberTemperatureK: 3589,
      gamma: 1.22,
      molarMass: 22,
      expansionRatio: a1.expansionRatio,
      ambientPressure: 14.696,
    });
    const drop = result.thrustCoefficient.vacuum - result.thrustCoefficient.ambient;
    expect(drop).toBeCloseTo((a1.cfVacuum as number) - (a1.cfSeaLevel as number), 3);
  });

  it('conical divergence λ = (1 + cos 15°)/2, exit pressure input, sizing by thrust and diameter', () => {
    const base = { chamberPressure: 70, pressureUnit: 'bar', chamberTemperatureK: 3558.34, gamma: 1.1507, molarMass: 22.186 } as const;
    const conical = data<Nozzle>(doc, 'nozzle_performance', { ...base, expansionRatio: 16, divergence: 'conical', halfAngleDeg: 15 });
    expect(conical.inputs.divergence.factor).toBeCloseTo(contour.conicalDivergence.check.lambda, 5);
    const ideal = data<Nozzle>(doc, 'nozzle_performance', { ...base, expansionRatio: 16 });
    expect(conical.ispS.vacuum).toBeLessThan(ideal.ispS.vacuum);
    const matched = data<Nozzle>(doc, 'nozzle_performance', { ...base, exitPressure: 1.01325, ambientPressure: 1.01325 });
    expect(matched.expansionState).toBe('optimum');
    expect(matched.inputs.expansionRatio).toBeCloseTo(matched.optimumExpansionRatio as number, 6);
    const sized = data<Nozzle>(doc, 'nozzle_performance', { ...base, expansionRatio: 16, thrustN: 1e6 });
    expect(sized.sizing?.thrustVacuumN).toBeCloseTo(1e6, 3);
    expect(sized.sizing?.massFlowKgS).toBeCloseTo(1e6 / (sized.ispS.vacuum * 9.80665), 3);
    expect(sized.sizing?.exitDiameterM).toBeCloseTo((sized.sizing?.throatDiameterM as number) * 4, 6);
    const atSea = data<Nozzle>(doc, 'nozzle_performance', {
      ...base,
      expansionRatio: 16,
      thrustN: 1e6,
      thrustAt: 'ambient',
      ambientPressure: 1.01325,
    });
    expect(atSea.sizing?.thrustN).toBeCloseTo(1e6, 3);
    const byDiameter = data<Nozzle>(doc, 'nozzle_performance', {
      ...base,
      expansionRatio: 4,
      throatDiameterM: 0.5,
      cStarEfficiency: 0.97,
      divergence: 'factor',
      divergenceFactor: 0.99,
      ambientPressure: 1.01325,
    });
    expect(byDiameter.expansionState).toBe('under-expanded');
    expect(byDiameter.inputs.ambient.defaulted).toBe(false);
    expect(byDiameter.sizing?.thrustN).toBeCloseTo(byDiameter.thrustCoefficient.ambient * 70e5 * (Math.PI / 4) * 0.25, 0);
    const over = data<Nozzle>(doc, 'nozzle_performance', { ...base, expansionRatio: 30, ambientPressure: 1.01325 });
    expect(over.expansionState).toBe('over-expanded');
    const vacuum = data<Nozzle>(doc, 'nozzle_performance', { ...base, expansionRatio: 40 });
    expect(vacuum.inputs.ambient.defaulted).toBe(true);
    expect(vacuum.expansionState).toBe('vacuum');
  });

  it('refuses invalid or conflicting inputs', () => {
    const base = { chamberPressure: 70, pressureUnit: 'bar', chamberTemperatureK: 3500, gamma: 1.2, molarMass: 22 };
    expectRefusal(doc, 'nozzle_performance', base, 'FLD_INPUT_CONFLICT', 'expansionRatio');
    expectRefusal(doc, 'nozzle_performance', { ...base, gamma: 1, expansionRatio: 10 }, 'FLD_PARAM_INVALID');
    expectRefusal(doc, 'nozzle_performance', { ...base, expansionRatio: 0.5 }, 'FLD_EXPANSION_INVALID');
    expectRefusal(doc, 'nozzle_performance', { ...base, exitPressure: 80 }, 'FLD_EXPANSION_INVALID', 'exitPressure');
    expectRefusal(doc, 'nozzle_performance', { ...base, expansionRatio: 10, divergence: 'conical' }, 'FLD_PARAM_INVALID', 'halfAngleDeg');
    expectRefusal(
      doc,
      'nozzle_performance',
      { ...base, expansionRatio: 10, divergence: 'factor', divergenceFactor: 2 },
      'FLD_PARAM_INVALID',
    );
    expectRefusal(doc, 'nozzle_performance', { ...base, expansionRatio: 10, cStarEfficiency: 0.5 }, 'FLD_PARAM_INVALID');
    expectRefusal(doc, 'nozzle_performance', { ...base, expansionRatio: 10, ambientPressure: 1, altitudeM: 0 }, 'FLD_INPUT_CONFLICT');
    expectRefusal(doc, 'nozzle_performance', { ...base, expansionRatio: 10, ambientPressure: -1 }, 'FLD_PARAM_INVALID');
    expectRefusal(doc, 'nozzle_performance', { ...base, expansionRatio: 10, altitudeM: 1e6 }, 'FLD_PARAM_INVALID', 'altitudeM');
    expectRefusal(doc, 'nozzle_performance', { ...base, expansionRatio: 10, thrustN: 1, throatAreaM2: 1 }, 'FLD_INPUT_CONFLICT');
    expectRefusal(doc, 'nozzle_performance', { ...base, expansionRatio: 10, thrustN: -1 }, 'FLD_PARAM_INVALID');
    expectRefusal(
      doc,
      'nozzle_performance',
      { ...base, expansionRatio: 100, thrustN: 1, thrustAt: 'ambient', ambientPressure: 60 },
      'FLD_PARAM_INVALID',
      'thrustN',
    );
  });
});
