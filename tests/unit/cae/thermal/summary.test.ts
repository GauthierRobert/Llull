import { describe, expect, it } from 'vitest';
import { thermalResultsSummary } from '@cae/thermal/summary';
import { STEFAN_BOLTZMANN } from '@lib/thermalClosedForms';
import { addBc, must, resultsFor, thermalFixture, twoTetMesh, type ThermalFixture } from './fixtures';

/** Face 1 of element 2 (nodes 2-3-4): the shared face of the two tets counted once. */
const FACE_234: readonly (readonly [number, number])[] = [[2, 1]];
/** Area of the face through (1,0,0), (0,1,0), (0,0,1): sqrt(3) / 2 (length unit squared). */
const AREA = Math.sqrt(3) / 2;
const source = { citation: 'test source' };
const withDoc = (fixture: ThermalFixture, doc: ThermalFixture['doc']): ThermalFixture => ({ ...fixture, doc });

describe('thermalResultsSummary: steady case', () => {
  interface Wall {
    fixture: ThermalFixture;
    mesh: ReturnType<typeof twoTetMesh>;
    tId: string;
    filmId: string;
    probeId: string;
  }
  const wall = (units: 'm' | 'mm'): Wall => setup(units);
  function setup(units: 'm' | 'mm'): Wall {
    let fixture = thermalFixture({ units });
    const t = addBc(fixture, {
      name: 'T',
      kind: 'temperature',
      value: 100,
      unit: 'degC',
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    const film = addBc(withDoc(fixture, t.doc), {
      name: 'film',
      kind: 'film',
      filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
      sinkTemperature: { value: 20, unit: 'degC' },
      source,
      target: { entityId: fixture.boxId, facesNear: [[0.3, 0.3, 0.3]] },
    });
    const probe = must(film.doc, 'add_result_probe', {
      analysisId: fixture.analysisId,
      name: 'p',
      point: [1, 1, 1],
      quantity: 'temperature',
    });
    fixture = withDoc(fixture, probe.document);
    const mesh = twoTetMesh(fixture, { nodeSets: { [`B_${t.id}`]: [1] }, faceSets: { [`B_${film.id}`]: FACE_234 } });
    return { fixture, mesh, tId: t.id, filmId: film.id, probeId: probe.affected[0] ?? '' };
  }

  it('reports extremes with location and part, film flow from NT, RFL sum and a zero balance (N-m-kg-s)', () => {
    const { fixture, mesh, tId, filmId, probeId } = wall('m');
    const filmFlow = 10 * AREA * (20 - 110);
    const reaction = { 1: -filmFlow };
    const results = resultsFor(fixture, mesh, [
      { time: 1, temperature: { 1: 100, 2: 100, 3: 110, 4: 120, 5: 150 }, reaction, flux: { 5: [3, 4, 0], 1: [1, 0, 0] } },
    ]);
    const summary = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    expect(summary.temperatureScale).toBe('degC');
    expect(summary.times).toEqual([0]);
    expect(summary.maxT).toEqual({ value: 150, at: [1, 1, 1], entityId: fixture.boxId, timeS: 0 });
    expect(summary.minT).toEqual({ value: 100, at: [0, 0, 0], entityId: fixture.boxId, timeS: 0 });
    expect(summary.maxHeatFluxW_m2).toEqual({ value: 5, at: [1, 1, 1], timeS: 0 });
    const flows = Object.fromEntries(summary.bcHeatFlowsW.map((flow) => [flow.bcId, flow.valueW]));
    expect(flows[filmId]).toBeCloseTo(filmFlow, 9);
    expect(flows[tId]).toBeCloseTo(-filmFlow, 9);
    expect(summary.heatBalance.inW).toBeCloseTo(-filmFlow, 9);
    expect(summary.heatBalance.outW).toBeCloseTo(-filmFlow, 9);
    expect(summary.heatBalance.storedW).toBe(0);
    expect(summary.heatBalance.residualRel).toBeLessThan(1e-12);
    expect(summary.probes).toEqual([{ probeId, series: [[0, 150]] }]);
    expect(summary.fieldRefs).toHaveLength(1);
    expect(summary.fieldRefs[0]).toMatchObject({ step: 1, timeS: 0 });
    expect(summary.fieldRefs[0]?.resultsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.physicalConstants).toBeUndefined();
    expect(summary.propertyRangeExceeded).toEqual([]);
    expect(thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results)).toEqual(summary);
  });

  it('converts N-mm-t-s heat flows to W (film h in N/(mm s K), RFL in N mm/s) and positions to document units', () => {
    const { fixture, mesh, tId, filmId } = wall('mm');
    const filmFlowW = 10 * AREA * 1e-6 * (20 - 110);
    const rflPerNode = -filmFlowW * 1e3;
    const results = resultsFor(fixture, mesh, [
      { time: 1, temperature: { 1: 100, 2: 100, 3: 110, 4: 120, 5: 150 }, reaction: { 1: rflPerNode } },
    ]);
    const summary = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    const flows = Object.fromEntries(summary.bcHeatFlowsW.map((flow) => [flow.bcId, flow.valueW]));
    expect(flows[filmId]).toBeCloseTo(filmFlowW, 14);
    expect(flows[tId]).toBeCloseTo(-filmFlowW, 14);
    expect(summary.heatBalance.residualRel).toBeLessThan(1e-9);
    expect(summary.maxT.at).toEqual([1, 1, 1]);
  });

  it('reports an unbalanced field with its residual', () => {
    const { fixture, mesh } = wall('m');
    const results = resultsFor(fixture, mesh, [{ time: 1, temperature: { 1: 100, 2: 100, 3: 110, 4: 120, 5: 150 }, reaction: { 1: 300 } }]);
    const { heatBalance } = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    const filmOut = 10 * AREA * 90;
    expect(heatBalance.inW).toBe(300);
    expect(heatBalance.outW).toBeCloseTo(filmOut, 9);
    expect(heatBalance.residualRel).toBeCloseTo((filmOut - 300) / filmOut, 9);
  });
});

describe('thermalResultsSummary: BC kinds', () => {
  it('integrates radiation on absolute temperature, flux, generation and point flux', () => {
    let fixture = thermalFixture();
    const box = fixture.boxId;
    const rad = addBc(fixture, {
      name: 'rad',
      kind: 'radiation',
      emissivity: 0.8,
      sinkTemperature: { value: 300, unit: 'K' },
      source,
      target: { entityId: box, facesNear: [[0.3, 0.3, 0.3]] },
    });
    const flux = addBc(withDoc(fixture, rad.doc), {
      name: 'q',
      kind: 'surface_flux',
      value: 200,
      unit: 'W/m^2',
      target: { entityId: box, facesNear: [[0.3, 0.3, 0.3]] },
    });
    const density = addBc(withDoc(fixture, flux.doc), { name: 'g', kind: 'heat_generation', value: 40, unit: 'W/m^3', entityId: box });
    const total = addBc(withDoc(fixture, density.doc), {
      name: 'gt',
      kind: 'heat_generation',
      value: 7,
      unit: 'W',
      mode: 'total',
      entityId: box,
    });
    const point = addBc(withDoc(fixture, total.doc), {
      name: 'p',
      kind: 'concentrated_flux',
      value: 3,
      unit: 'W',
      target: { entityId: box, pointsNear: [[0, 0, 0]] },
    });
    fixture = withDoc(fixture, point.doc);
    const mesh = twoTetMesh(fixture, {
      nodeSets: { [`B_${point.id}`]: [1, 5] },
      faceSets: { [`B_${rad.id}`]: FACE_234, [`B_${flux.id}`]: FACE_234 },
    });
    const results = resultsFor(fixture, mesh, [{ time: 1, temperature: { 1: 126.85, 2: 126.85, 3: 126.85, 4: 126.85, 5: 126.85 } }]);
    const summary = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    const flows = Object.fromEntries(summary.bcHeatFlowsW.map((flow) => [flow.bcId, flow.valueW]));
    expect(flows[rad.id]).toBeCloseTo(0.8 * STEFAN_BOLTZMANN * AREA * (300 ** 4 - 400 ** 4), 9);
    expect(flows[flux.id]).toBeCloseTo(200 * AREA, 12);
    expect(flows[density.id]).toBeCloseTo(40 * 0.5, 12);
    expect(flows[total.id]).toBe(7);
    expect(flows[point.id]).toBe(6);
    expect(summary.physicalConstants).toEqual({
      stefanBoltzmann: { value: STEFAN_BOLTZMANN, unit: 'W/(m^2 K^4)', source: '2019 SI exact constants', defaulted: true },
      absoluteZero: { value: -273.15, unit: 'degC', source: 'SI definition of degC', defaulted: true },
    });
  });

  it('scales applied values by the amplitude at the result time and computes the K scale with absolute zero 0', () => {
    let fixture = thermalFixture({ type: 'heat_transient', scale: 'K' });
    fixture = withDoc(
      fixture,
      must(fixture.doc, 'define_amplitude', { analysisId: fixture.analysisId, name: 'ramp', kind: 'ramp', durationS: 10 }).document,
    );
    const q = addBc(fixture, {
      name: 'q',
      kind: 'surface_flux',
      value: 100,
      unit: 'W/m^2',
      amplitude: 'ramp',
      target: { entityId: fixture.boxId, facesNear: [[0.3, 0.3, 0.3]] },
    });
    const rad = addBc(withDoc(fixture, q.doc), {
      name: 'rad',
      kind: 'radiation',
      emissivity: 1,
      sinkTemperature: { value: 100, unit: 'K' },
      amplitude: 'ramp',
      source,
      target: { entityId: fixture.boxId, facesNear: [[0.3, 0.3, 0.3]] },
    });
    fixture = withDoc(fixture, rad.doc);
    const mesh = twoTetMesh(fixture, { faceSets: { [`B_${q.id}`]: FACE_234, [`B_${rad.id}`]: FACE_234 } });
    const field = { 1: 200, 2: 200, 3: 200, 4: 200, 5: 200 };
    const results = resultsFor(fixture, mesh, [
      { time: 5, temperature: field },
      { time: 10, temperature: field },
    ]);
    const summary = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    expect(summary.times).toEqual([5, 10]);
    const at = (bcId: string, timeS: number): number =>
      summary.bcHeatFlowsW.find((flow) => flow.bcId === bcId && flow.timeS === timeS)?.valueW ?? Number.NaN;
    expect(at(q.id, 5)).toBeCloseTo(50 * AREA, 12);
    expect(at(q.id, 10)).toBeCloseTo(100 * AREA, 12);
    expect(at(rad.id, 5)).toBeCloseTo(STEFAN_BOLTZMANN * AREA * (50 ** 4 - 200 ** 4), 9);
    expect(at(rad.id, 10)).toBeCloseTo(STEFAN_BOLTZMANN * AREA * (100 ** 4 - 200 ** 4), 9);
    expect(summary.physicalConstants?.absoluteZero).toMatchObject({ value: 0, unit: 'K' });
    expect(summary.maxT.timeS).toBe(5);
  });
});

describe('thermalResultsSummary: transient storage and ranges', () => {
  function transient(material: Parameters<typeof thermalFixture>[0] = {}): {
    fixture: ThermalFixture;
    mesh: ReturnType<typeof twoTetMesh>;
    genId: string;
  } {
    let fixture = thermalFixture({ type: 'heat_transient', ...material });
    fixture = withDoc(
      fixture,
      must(fixture.doc, 'set_initial_temperature', { analysisId: fixture.analysisId, value: 20, unit: 'degC' }).document,
    );
    fixture = withDoc(fixture, must(fixture.doc, 'set_thermal_step', { analysisId: fixture.analysisId, endTimeS: 4 }).document);
    const gen = addBc(fixture, { name: 'g', kind: 'heat_generation', value: 1e7, unit: 'W', mode: 'total', entityId: fixture.boxId });
    fixture = withDoc(fixture, gen.doc);
    return { fixture, mesh: twoTetMesh(fixture), genId: gen.id };
  }
  const uniform = (value: number): Record<number, number> => ({ 1: value, 2: value, 3: value, 4: value, 5: value });

  it('balances generation against rho cp V dT/dt from the initial temperature and between result times', () => {
    const { fixture, mesh } = transient();
    // rho cp V = 8000 * 500 * 0.5 = 2e6 J/K: 1e7 W heats 5 K per second.
    const results = resultsFor(fixture, mesh, [
      { time: 2, temperature: uniform(30) },
      { time: 4, temperature: uniform(40) },
    ]);
    const { heatBalance, times } = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    expect(times).toEqual([2, 4]);
    expect(heatBalance.timeS).toBe(4);
    expect(heatBalance.storedW).toBeCloseTo((2e6 * 10) / 2, 3);
    expect(heatBalance.inW).toBe(1e7);
    expect(heatBalance.residualRel).toBeLessThan(1e-12);
    const first = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, { ...results, steps: results.steps.slice(0, 1) });
    expect(first.heatBalance.storedW).toBeCloseTo((2e6 * 10) / 2, 3);
    expect(first.heatBalance.residualRel).toBeLessThan(1e-12);
  });

  it('integrates a temperature-dependent cp exactly (enthalpy of the solver table)', () => {
    const { fixture, mesh } = transient({ cp: 400 });
    // replace cp by a table cp(T) = 400 + 2 (T - 20) between 0 and 100 degC through a second model (nominal 400 at 20)
    const doc = must(fixture.doc, 'define_property_model', {
      material: 'steel',
      model: {
        id: 'cp_table',
        property: 'cp',
        unit: 'J/(kg*K)',
        variables: [{ variable: 'T', unit: 'degC' }],
        validity: [{ variable: 'T', unit: 'degC', data: [0, 100] }],
        form: {
          kind: 'table1d',
          variable: 'T',
          points: [
            [0, 360],
            [100, 520],
          ],
          interpolation: 'linear',
        },
        basis: 'company',
        source: { citation: 'test' },
      },
    }).document;
    const removed = must(doc, 'remove_property_model', { material: 'steel', modelId: 'cp_const' }).document;
    const tabled = withDoc(fixture, removed);
    const results = resultsFor(tabled, mesh, [{ time: 2, temperature: uniform(60) }]);
    const { heatBalance } = thermalResultsSummary(tabled.doc, tabled.analysisId, mesh, results);
    // table cp(T) = 360 + 1.6 T: integral 20..60 = 360 * 40 + 0.8 * (3600 - 400) = 16960 J/kg; * 8000 kg/m3 * 0.5 m3 / 2 s
    expect(heatBalance.storedW).toBeCloseTo((16960 * 8000 * 0.5) / 2, 0);
  });

  it('lists tables the solved field leaves (end values held by the solver) and ignores constants', () => {
    const fixture = thermalFixture({
      type: 'heat_transient',
      k: [
        [0, 10],
        [100, 20],
        [400, 40],
      ],
    });
    const t = addBc(fixture, {
      name: 'T',
      kind: 'temperature',
      value: 80,
      unit: 'degC',
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    const ready = withDoc(
      fixture,
      must(t.doc, 'set_initial_temperature', { analysisId: fixture.analysisId, value: 20, unit: 'degC' }).document,
    );
    const mesh = twoTetMesh(ready, { nodeSets: { [`B_${t.id}`]: [1] } });
    // required range 20..80 +- 50 K clamped to the data range 0..400: table 0..130
    const results = resultsFor(ready, mesh, [{ time: 1, temperature: { 1: 80, 2: 20, 3: 20, 4: 20, 5: 250 } }]);
    const { propertyRangeExceeded } = thermalResultsSummary(ready.doc, ready.analysisId, mesh, results);
    expect(propertyRangeExceeded).toEqual([{ material: 'steel', property: 'k', validRange: [0, 130], reached: 250 }]);
  });

  it('returns an empty summary for an unknown analysis, a mechanical case and results without NDTEMP', () => {
    const fixture = thermalFixture();
    const mesh = twoTetMesh(fixture);
    const results = resultsFor(fixture, mesh, [{ time: 1, temperature: uniform(1) }]);
    const empty = thermalResultsSummary(fixture.doc, 'ghost', mesh, results);
    expect(empty.times).toEqual([]);
    expect(empty.bcHeatFlowsW).toEqual([]);
    const noField = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, { ...results, steps: [{ step: 1, time: 1, fields: {} }] });
    expect(noField).toMatchObject({ temperatureScale: 'degC', times: [], fieldRefs: [] });
    const mechanical = must(fixture.doc, 'create_analysis', { name: 's', analysisType: 'static' });
    expect(thermalResultsSummary(mechanical.document, mechanical.affected[0] ?? '', mesh, results).times).toEqual([]);
  });
});
