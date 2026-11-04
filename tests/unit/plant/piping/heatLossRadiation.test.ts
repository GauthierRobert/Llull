/**
 * Plant 02 RTE CAT-FU: `line_heat_loss` with a radiation term and a temperature-dependent insulation conductivity. Every oracle is an analytic limit written
 * here independently of the implementation:
 *  - bare pipe, steel conductivity huge, no inside film: the surface is at the fluid temperature, so Q' = pi D (h_c (Ts - Ta) + eps sigma (Ts^4 - Ta^4));
 *  - insulated pipe, films huge (outer surface at the ambient, steel at the fluid): Q' = 2 pi k((Ti + Ta) / 2) (Ti - Ta) / ln(D2 / D1) with k linear in T
 *    (the exact radial flux of a linear conductivity uses its value at the mean temperature of the layer).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { heatLossPerMetre } from '@aec/plant/piping/heatLoss';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Document } from './rteFixtures';

const SIGMA = 5.670374419e-8;
const K = 273.15;
const HOT = { service: 'HO', sequence: '4001', spec: 'CS150', dn: 80, designTempC: 180 };

function hotLine(insulated: boolean): { doc: CadDocument; lineId: string } {
  const a = addTie(cs150Document(), 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
  const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
  const created = ok(b.doc, 'create_pipeline', insulated ? { ...HOT, insulation: { code: 'H', thickness: 'fromSpec' } } : HOT);
  const lineId = created.affected[0] as string;
  return { doc: apply(created.document, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } }), lineId };
}

interface Loss {
  heatLossWPerM: number;
  surfaceTempC: number;
  steelOuterTempC: number;
  outsideFilm?: { convectionWm2K: number; radiationWm2K: number };
  insulationConductivityMeanWmK?: number;
  defaults: Array<{ input: string }>;
  provenance: { model: string };
}

describe('radiation: bare pipe, surface at the fluid temperature', () => {
  const base = {
    fluidTempC: 180,
    ambientTempC: 28,
    outsideDiameterMm: 88.9,
    wallMm: 5.49,
    insulationThicknessMm: 0,
    steelConductivityWmK: 1e9,
    insulationConductivityWmK: 0,
    outsideFilmWm2K: 10,
    insideFilmWm2K: null,
  } as const;
  const analytic = (emissivity: number): number =>
    Math.PI * 0.0889 * (10 * (180 - 28) + emissivity * SIGMA * ((180 + K) ** 4 - (28 + K) ** 4));

  it.each([0.1, 0.5, 0.8, 1])('emissivity %s: Q = pi D (h_c dT + eps sigma (Ts^4 - Ta^4)) to 1e-6 relative', (emissivity) => {
    const result = heatLossPerMetre({ ...base, emissivity });
    expect(Math.abs(result.heatLossWPerM - analytic(emissivity)) / analytic(emissivity)).toBeLessThan(1e-6);
    expect(result.outsideFilm?.convectionWm2K).toBe(10);
    // h_r (Ts - Ta) is the radiative flux per area: eps sigma (Ts^4 - Ta^4)
    const rad = result.outsideFilm?.radiationWm2K as number;
    expect(rad * (result.surfaceTempC - 28)).toBeCloseTo(emissivity * SIGMA * ((result.surfaceTempC + K) ** 4 - (28 + K) ** 4), 4);
  });

  it('adds heat in proportion to the emissivity and never changes the convection-only answer at emissivity 0 (the closed form)', () => {
    const plain = heatLossPerMetre(base);
    expect(plain.outsideFilm).toBeUndefined();
    expect(Math.abs(plain.heatLossWPerM - analytic(0)) / analytic(0)).toBeLessThan(1e-6);
    expect(heatLossPerMetre({ ...base, emissivity: 0.9 }).heatLossWPerM).toBeGreaterThan(
      heatLossPerMetre({ ...base, emissivity: 0.4 }).heatLossWPerM,
    );
  });

  it('a cold pipe gains heat (negative loss) with radiation too', () => {
    const cold = heatLossPerMetre({ ...base, fluidTempC: -20, ambientTempC: 28, emissivity: 0.8 });
    expect(cold.heatLossWPerM).toBeLessThan(0);
    const expected = Math.PI * 0.0889 * (10 * (-20 - 28) + 0.8 * SIGMA * ((-20 + K) ** 4 - (28 + K) ** 4));
    expect(Math.abs(cold.heatLossWPerM - expected) / Math.abs(expected)).toBeLessThan(1e-6);
  });
});

describe('temperature-dependent insulation conductivity: linear k(T) at the mean temperature', () => {
  const base = {
    fluidTempC: 180,
    ambientTempC: 28,
    outsideDiameterMm: 88.9,
    wallMm: 5.49,
    insulationThicknessMm: 50,
    steelConductivityWmK: 1e9,
    insulationConductivityWmK: 0.04,
    outsideFilmWm2K: 1e9,
    insideFilmWm2K: null,
  } as const;
  const analytic = (k0: number, slope: number, ref: number): number =>
    (2 * Math.PI * (k0 + slope * ((180 + 28) / 2 - ref)) * (180 - 28)) / Math.log(188.9 / 88.9);

  it('k 0.04 at 20 degC, slope 2e-4: Q = 2 pi (0.04 + 2e-4 (104 - 20)) 152 / ln(188.9 / 88.9) to 1e-6 relative', () => {
    const result = heatLossPerMetre({ ...base, conductivitySlopeWmK2: 2e-4, conductivityRefTempC: 20 });
    const expected = analytic(0.04, 2e-4, 20);
    expect(Math.abs(result.heatLossWPerM - expected) / expected).toBeLessThan(1e-6);
    expect(result.insulationConductivityMeanWmK).toBeCloseTo(0.0568, 6);
  });

  it('a zero slope is the constant-conductivity closed form (the reference k at any temperature)', () => {
    const constant = heatLossPerMetre(base);
    const zero = heatLossPerMetre({ ...base, conductivitySlopeWmK2: 0, conductivityRefTempC: 100 });
    expect(zero.heatLossWPerM).toBeCloseTo(constant.heatLossWPerM, 6);
    expect(Math.abs(constant.heatLossWPerM - analytic(0.04, 0, 0)) / analytic(0.04, 0, 0)).toBeLessThan(1e-6);
  });

  it('with finite films the layer temperatures and the radiation iterate together and stay between the limits', () => {
    const coupled = heatLossPerMetre({
      ...base,
      outsideFilmWm2K: 10,
      emissivity: 0.9,
      conductivitySlopeWmK2: 2e-4,
      conductivityRefTempC: 20,
    });
    const meanK = coupled.insulationConductivityMeanWmK as number;
    const mean = (coupled.steelOuterTempC + coupled.surfaceTempC) / 2;
    expect(meanK).toBeCloseTo(0.04 + 2e-4 * (mean - 20), 6);
    const film = (coupled.outsideFilm?.convectionWm2K as number) + (coupled.outsideFilm?.radiationWm2K as number);
    const flux = (2 * Math.PI * meanK * (coupled.steelOuterTempC - coupled.surfaceTempC)) / Math.log(188.9 / 88.9);
    expect(coupled.heatLossWPerM).toBeCloseTo(flux, 4);
    expect(coupled.heatLossWPerM).toBeCloseTo(film * Math.PI * 0.1889 * (coupled.surfaceTempC - 28), 4);
  });
});

describe('line_heat_loss with the refinements', () => {
  const insulated = hotLine(true);
  const bare = hotLine(false);
  const INPUT = { fluidTempC: 180, ambientTempC: 28, outsideFilmWm2K: 10, steelConductivityWmK: 56.045, insulationConductivityWmK: 0.04 };

  it('radiation: the bare CS150 line DN80 gains the radiative term of the oracle (h_c 10, eps 0.8) and names the film parts', () => {
    const [plain, radiant] = [
      data<Loss>(bare.doc, 'line_heat_loss', { lineId: bare.lineId, ...INPUT }),
      data<Loss>(bare.doc, 'line_heat_loss', { lineId: bare.lineId, ...INPUT, outsideEmissivity: 0.8 }),
    ];
    expect(radiant.heatLossWPerM).toBeGreaterThan(plain.heatLossWPerM);
    expect(radiant.outsideFilm?.radiationWm2K).toBeGreaterThan(0);
    expect(radiant.provenance.model).toContain('radiation to the ambient');
    expect(plain.outsideFilm).toBeUndefined();
    // the steel conducts almost perfectly: the surface is close to the fluid, so the flux per area is close to the bare-surface oracle at that surface temperature
    const surface = radiant.surfaceTempC;
    const perArea = 10 * (surface - 28) + 0.8 * SIGMA * ((surface + K) ** 4 - (28 + K) ** 4);
    expect(radiant.heatLossWPerM).toBeCloseTo(perArea * Math.PI * 0.0889, 3);
  });

  it('conductivity slope: the insulated line loses what the mean-temperature conductivity gives; the mean is reported', () => {
    const result = data<Loss>(insulated.doc, 'line_heat_loss', {
      lineId: insulated.lineId,
      ...INPUT,
      outsideFilmWm2K: 1e9,
      steelConductivityWmK: 1e9,
      insulationConductivitySlopeWmK2: 2e-4,
      insulationConductivityRefTempC: 20,
    });
    const expected = (2 * Math.PI * 0.0568 * 152) / Math.log(188.9 / 88.9);
    expect(Math.abs(result.heatLossWPerM - expected) / expected).toBeLessThan(1e-5);
    expect(result.insulationConductivityMeanWmK).toBeCloseTo(0.0568, 5);
    expect(result.provenance.model).toContain('linear k(T)');
  });

  it('refuses an emissivity outside (0, 1], a slope without its reference temperature (and vice versa), and a conductivity that turns non-positive', () => {
    expectRefusal(
      insulated.doc,
      'line_heat_loss',
      { lineId: insulated.lineId, ...INPUT, outsideEmissivity: 1.2 },
      'RTE_HEAT_LOSS_INPUT',
      'outsideEmissivity',
    );
    expectRefusal(insulated.doc, 'line_heat_loss', { lineId: insulated.lineId, ...INPUT, outsideEmissivity: 0 }, 'RTE_HEAT_LOSS_INPUT');
    expectRefusal(
      insulated.doc,
      'line_heat_loss',
      { lineId: insulated.lineId, ...INPUT, insulationConductivitySlopeWmK2: 1e-4 },
      'RTE_HEAT_LOSS_INPUT',
      'insulationConductivityRefTempC',
    );
    expectRefusal(
      insulated.doc,
      'line_heat_loss',
      { lineId: insulated.lineId, ...INPUT, insulationConductivityRefTempC: 20 },
      'RTE_HEAT_LOSS_INPUT',
    );
    expectRefusal(
      insulated.doc,
      'line_heat_loss',
      { lineId: insulated.lineId, ...INPUT, insulationConductivitySlopeWmK2: 1, insulationConductivityRefTempC: 1000 },
      'RTE_HEAT_LOSS_INPUT',
    );
  });

  it('a slope on a bare line is ignored and named in defaults; the query is pure', () => {
    const result = data<Loss>(bare.doc, 'line_heat_loss', {
      lineId: bare.lineId,
      ...INPUT,
      insulationConductivitySlopeWmK2: 2e-4,
      insulationConductivityRefTempC: 20,
    });
    expect(result.defaults.map((entry) => entry.input)).toContain('insulationConductivitySlopeWmK2');
    expectPure(insulated.doc, () =>
      execute(insulated.doc, 'line_heat_loss', { lineId: insulated.lineId, ...INPUT, outsideEmissivity: 0.9 }),
    );
  });
});
