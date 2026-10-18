import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { data, expectRefusal, ok } from '../../helpers/commandAssertions';

const doc = createEmptyDocument();

describe('aerodynamics / fluids review regressions', () => {
  it('refuses an ISA offset that drives the temperature at altitude below 100 K', () => {
    expectRefusal(doc, 'standard_atmosphere', { altitude: 84000, temperatureOffsetK: -188 }, 'AER_PARAM_INVALID', 'temperatureOffsetK');
    expectRefusal(
      doc,
      'analyze_wing',
      { span: 5, rootChord: 1, speed: 50, altitudeM: 11000, temperatureOffsetK: -150 },
      'AER_PARAM_INVALID',
    );
    expectRefusal(doc, 'aero_drag', { speed: 10, cdA: 1, temperatureOffsetK: -200 }, 'AER_PARAM_INVALID');
  });

  it('caps polyline airfoils at 801 points and solves many angles from one factorisation', () => {
    const points = Array.from({ length: 900 }, (_, k) => {
      const t = (2 * Math.PI * k) / 900;
      return [0.5 + 0.5 * Math.cos(t), 0.06 * Math.sin(t)];
    });
    const big = ok(doc, 'draw_polyline', { points, closed: true });
    expectRefusal(big.document, 'analyze_airfoil', { entityId: big.affected[0] }, 'AER_AIRFOIL_INVALID', 'entityId');
    const many = data<{ polar: Array<{ alphaDeg: number; cl: number }> }>(doc, 'analyze_airfoil', {
      naca: '0012',
      alphasDeg: Array.from({ length: 41 }, (_, k) => -10 + k * 0.5),
    });
    expect(many.polar).toHaveLength(41);
    expect(many.polar[20]?.cl).toBeCloseTo(0, 9);
    expect(many.polar[40]?.cl).toBeCloseTo(-(many.polar[0]?.cl as number), 9);
  });

  it('nozzle: ambient at or above chamber pressure is refused; a nozzle with no net thrust reports a null ambient Isp', () => {
    const base = { chamberPressure: 1, pressureUnit: 'bar', chamberTemperatureK: 3000, gamma: 1.2, molarMass: 20, expansionRatio: 10 };
    expectRefusal(doc, 'nozzle_performance', { ...base, ambientPressure: 5 }, 'FLD_EXPANSION_INVALID', 'ambientPressure');
    const weak = data<{ ispS: { ambient: number | null }; warnings: string[] }>(doc, 'nozzle_performance', {
      ...base,
      expansionRatio: 100,
      ambientPressure: 0.9,
    });
    expect(weak.ispS.ambient).toBeNull();
    expect(weak.warnings.join(' ')).toContain('no net thrust');
  });

  it('bassett_1999 takes densityKgM3 as Kd = ρ/1.225, refuses unused air params, and flags K1 as given when any factor is given', () => {
    const rider = { model: 'bassett_1999', speed: 50, speedUnit: 'km/h', riderHeightM: 1.8, riderMassKg: 70 };
    const thin = data<{ inputs: { k1: { value: number } } }>(doc, 'cycling_power', { ...rider, densityKgM3: 0.9 });
    expect(thin.inputs.k1.value).toBeCloseTo(0.9 / 1.225, 9);
    expectRefusal(doc, 'cycling_power', { ...rider, temperatureOffsetK: 10 }, 'AER_PARAM_INVALID');
    expectRefusal(doc, 'cycling_power', { ...rider, altitudeM: 1000, densityKgM3: 1 }, 'AER_AIR_STATE_CONFLICT');
    expectRefusal(doc, 'cycling_power', { ...rider, altitudeM: 9000 }, 'AER_PARAM_INVALID');
    const bike = data<{ inputs: { k1: { defaulted: boolean } } }>(doc, 'cycling_power', { ...rider, bikeFactor: 0.93 });
    expect(bike.inputs.k1.defaulted).toBe(false);
    const none = data<{ inputs: { k1: { defaulted: boolean } } }>(doc, 'cycling_power', rider);
    expect(none.inputs.k1.defaulted).toBe(true);
  });

  it('no-equilibrium refusal tells to lower the power or the descent', () => {
    const refusal = expectRefusal(
      doc,
      'cycling_power',
      { massKg: 80, cdA: 0.25, powerW: 100, gradePercent: -25, headwindMS: -10 },
      'AER_NO_EQUILIBRIUM',
    );
    expect(refusal.error?.remediation).toContain('lower powerW');
  });

  it('oblique shock accepts the exact Mach angle (Mach wave) as the wave angle', () => {
    const wave = data<{ result: { pressureRatio: number; deflectionDeg: number } }>(doc, 'compressible_flow', {
      relation: 'oblique_shock',
      mach: 2,
      waveAngleDeg: 30,
    });
    expect(wave.result.pressureRatio).toBeCloseTo(1, 9);
    expect(Math.abs(wave.result.deflectionDeg)).toBeLessThan(1e-6);
  });

  it('a chamber with a cylindrical section keeps a uniform wall thickness up to the convergent corner', () => {
    const run = ok(doc, 'design_nozzle', {
      throatRadius: 20,
      expansionRatio: 9,
      shape: 'conical',
      wallThickness: 2,
      chamberLength: 30,
      contractionRatio: 4,
      includeContour: true,
    });
    const contour = (run.data as { contour: Array<{ axial: number; radius: number; angleDeg: number }> }).contour;
    expect(contour[0]?.angleDeg).toBe(0);
    expect(contour[1]?.angleDeg).toBe(0);
    expect(contour[1]?.axial).toBeCloseTo(contour[2]?.axial as number, 9);
    expect(contour[2]?.angleDeg).toBeCloseTo(-30, 9);
  });

  it('nozzle_performance flags only the inputs really left to their defaults', () => {
    const base = { chamberPressure: 70, pressureUnit: 'bar', chamberTemperatureK: 3500, gamma: 1.2, molarMass: 22, expansionRatio: 10 };
    type Inputs = {
      inputs: { divergence: { defaulted: boolean }; cStarEfficiency: { defaulted: boolean }; ambient: { defaulted: boolean } };
    };
    const implicit = data<Inputs>(doc, 'nozzle_performance', base).inputs;
    expect([implicit.divergence.defaulted, implicit.cStarEfficiency.defaulted, implicit.ambient.defaulted]).toEqual([true, true, true]);
    const explicit = data<Inputs>(doc, 'nozzle_performance', {
      ...base,
      divergence: 'ideal',
      cStarEfficiency: 1,
      ambientPressure: 0,
    }).inputs;
    expect([explicit.divergence.defaulted, explicit.cStarEfficiency.defaulted, explicit.ambient.defaulted]).toEqual([false, false, false]);
  });

  it('aero_drag adds the unrounded friction drag to the pressure drag', () => {
    const result = data<{
      dragN: number;
      pressureDragN: number;
      friction: { cf: number; wettedAreaM2: number };
      dynamicPressurePa: number;
    }>(doc, 'aero_drag', { speed: 30, cdA: 0.3, frictionModel: 'turbulent_prandtl_schlichting', wettedAreaM2: 7, lengthM: 4 });
    expect(result.dragN).toBeCloseTo(result.pressureDragN + result.friction.cf * result.dynamicPressurePa * 7, 6);
  });
});
