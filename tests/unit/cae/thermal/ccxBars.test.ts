import { describe, expect, it } from 'vitest';
import { thermalResultsSummary } from '@cae/thermal/summary';
import { expectCase } from '../../physics/benchmarkCases';
import { hasCcx, solveWithCcx } from './ccxRun';
import { addBc, barMesh, barTets, facesOn, must, thermalFixture, withMaterial, type BarMesh, type ThermalFixture } from './fixtures';

const PACK = '03-thermal-analysis';
const source = { citation: 'test input of the validation case (not a material claim)' };
const withDoc = (fixture: ThermalFixture, doc: ThermalFixture['doc']): ThermalFixture => ({ ...fixture, doc });
const nodeIdsOn = (bar: BarMesh, i: number): number[] => [
  bar.nodeAt(i, 0, 0),
  bar.nodeAt(i, 1, 0),
  bar.nodeAt(i, 0, 1),
  bar.nodeAt(i, 1, 1),
];

describe.skipIf(!hasCcx)('thermal chain against CalculiX 2.21 on hand-built tet bars', () => {
  it.each([
    ['N-m-kg-s', 'm', 1],
    ['N-mm-t-s', 'mm', 1000],
  ] as const)(
    'VC-THM-01 in %s: wall with films on both faces (flux, face temperatures, film heat flows, balance)',
    (_system, units, scale) => {
      const base = thermalFixture({ units, size: [0.05 * scale, scale, scale], k: 15, cp: null, density: null });
      const hot = addBc(base, {
        name: 'hot_film',
        kind: 'film',
        filmCoefficient: { value: 50, unit: 'W/(m^2*K)' },
        sinkTemperature: { value: 200, unit: 'degC' },
        source,
        target: { entityId: base.boxId, facesNear: [[0, 0.5 * scale, 0.5 * scale]] },
      });
      const cold = addBc(withDoc(base, hot.doc), {
        name: 'cold_film',
        kind: 'film',
        filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
        sinkTemperature: { value: 20, unit: 'degC' },
        source,
        target: { entityId: base.boxId, facesNear: [[0.05 * scale, 0.5 * scale, 0.5 * scale]] },
      });
      let fixture = withDoc(base, cold.doc);
      const ids: string[] = [];
      for (const [name, x] of [
        ['hot_face', 0],
        ['cold_face', 0.05 * scale],
      ] as const) {
        const added = must(fixture.doc, 'add_result_probe', {
          analysisId: fixture.analysisId,
          name,
          point: [x, 0.5 * scale, 0.5 * scale],
          quantity: 'temperature',
        });
        fixture = withDoc(fixture, added.document);
        ids.push(added.affected[0] ?? '');
      }
      const bar = barTets(5, 0.01 * scale, scale, scale);
      const mesh = barMesh(fixture, bar, {
        nodeSets: { [`P_${ids[0]}`]: [bar.nodeAt(0, 0, 0)], [`P_${ids[1]}`]: [bar.nodeAt(5, 0, 0)] },
        faceSets: { [`B_${hot.id}`]: facesOn(bar.tets, nodeIdsOn(bar, 0)), [`B_${cold.id}`]: facesOn(bar.tets, nodeIdsOn(bar, 5)) },
      });
      const { deck, results } = solveWithCcx(fixture, mesh);
      expect(deck).toMatch(units === 'mm' ? /\*FILM\n\d+, F\d, 200, 0\.05\n/ : /\*FILM\n\d+, F\d, 200, 50\n/);
      const summary = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
      const series = (id: string): number => summary.probes.find((probe) => probe.probeId === id)?.series[0]?.[1] ?? Number.NaN;
      expectCase(PACK, 'VC-THM-01.b', series(ids[0] ?? ''));
      expectCase(PACK, 'VC-THM-01.c', series(ids[1] ?? ''));
      const flow = (id: string): number => summary.bcHeatFlowsW.find((entry) => entry.bcId === id)?.valueW ?? Number.NaN;
      expect(flow(hot.id)).toBeCloseTo(1459.45945946, 1);
      expect(flow(cold.id)).toBeCloseTo(-1459.45945946, 1);
      expectCase(PACK, 'VC-THM-01.d', summary.heatBalance.residualRel);
      expectCase(PACK, 'VC-THM-01.a', summary.heatBalance.inW, 'W/m^2');
      expect(summary.maxT.value).toBeCloseTo(170.81081, 2);
      expect(summary.minT.value).toBeCloseTo(165.94595, 2);
      expect(summary.maxT.at[0]).toBeCloseTo(0, 9);
      expect(summary.minT.at[0]).toBeCloseTo(0.05 * scale, 9);
    },
  );

  it('VC-THM-02: slab with generation given as total power (converted to W/m^3 with the mesh volume) and both faces at 50 degC', () => {
    const base = thermalFixture({ size: [0.02, 0.01, 0.01], k: 20, cp: null, density: null });
    const left = addBc(base, {
      name: 'left',
      kind: 'temperature',
      value: 50,
      unit: 'degC',
      target: { entityId: base.boxId, facesNear: [[0, 0.005, 0.005]] },
    });
    const right = addBc(withDoc(base, left.doc), {
      name: 'right',
      kind: 'temperature',
      value: 50,
      unit: 'degC',
      target: { entityId: base.boxId, facesNear: [[0.02, 0.005, 0.005]] },
    });
    // 1e7 W/m^3 over 0.02 * 0.01 * 0.01 m^3 = 2e-6 m^3 -> 20 W in total
    const generation = addBc(withDoc(base, right.doc), {
      name: 'gen',
      kind: 'heat_generation',
      value: 20,
      unit: 'W',
      mode: 'total',
      entityId: base.boxId,
    });
    const fixture = withDoc(base, generation.doc);
    const bar = barTets(10, 0.002, 0.01, 0.01);
    const mesh = barMesh(fixture, bar, { nodeSets: { [`B_${left.id}`]: nodeIdsOn(bar, 0), [`B_${right.id}`]: nodeIdsOn(bar, 10) } });
    const { deck, results } = solveWithCcx(fixture, mesh);
    expect(deck).toContain('** total 20 W over 0.000002 m^3');
    const summary = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    expectCase(PACK, 'VC-THM-02', summary.maxT.value);
    expect(summary.maxT.at[0]).toBeCloseTo(0.01, 9);
    const flow = (id: string): number => summary.bcHeatFlowsW.find((entry) => entry.bcId === id)?.valueW ?? Number.NaN;
    expect(flow(left.id) + flow(right.id)).toBeCloseTo(-20, 6);
    expect(flow(generation.id)).toBe(20);
    expect(summary.heatBalance.residualRel).toBeLessThan(1e-6);
  });

  it('VC-THM-05: 1D slab radiating to 300 K (K scale, absolute temperature, nonlinear)', () => {
    const base = thermalFixture({ scale: 'K', size: [0.1, 0.01, 0.01], k: 55.6, cp: null, density: null });
    const left = addBc(base, {
      name: 'hot',
      kind: 'temperature',
      value: 1000,
      unit: 'K',
      target: { entityId: base.boxId, facesNear: [[0, 0.005, 0.005]] },
    });
    const rad = addBc(withDoc(base, left.doc), {
      name: 'rad',
      kind: 'radiation',
      emissivity: 0.98,
      sinkTemperature: { value: 300, unit: 'K' },
      source,
      target: { entityId: base.boxId, facesNear: [[0.1, 0.005, 0.005]] },
    });
    const fixture = withDoc(base, rad.doc);
    const bar = barTets(10, 0.01, 0.01, 0.01);
    const mesh = barMesh(fixture, bar, {
      nodeSets: { [`B_${left.id}`]: nodeIdsOn(bar, 0) },
      faceSets: { [`B_${rad.id}`]: facesOn(bar.tets, nodeIdsOn(bar, 10)) },
    });
    const { results } = solveWithCcx(fixture, mesh);
    const summary = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    expectCase(PACK, 'VC-THM-05', summary.minT.value, 'K');
    expect(summary.physicalConstants?.absoluteZero.value).toBe(0);
    expect(summary.heatBalance.residualRel).toBeLessThan(1e-3);
  });

  it('VC-THM-03: NAFEMS T3 bar, sine boundary amplitude, fixed 0.5 s increments, probe at x = 0.08 m after 32 s', () => {
    const base = thermalFixture({ type: 'heat_transient', size: [0.1, 0.001, 0.001], k: 35, cp: 440.5, density: 7200 });
    let fixture = base;
    const set = (command: string, params: Record<string, unknown>): string => {
      const result = must(fixture.doc, command, { analysisId: fixture.analysisId, ...params });
      fixture = withDoc(fixture, result.document);
      return result.affected[0] ?? '';
    };
    set('set_initial_temperature', { value: 0, unit: 'degC' });
    set('define_amplitude', { name: 'sine40', kind: 'sine', amplitude: 1, periodS: 80, sampleStepS: 0.5, durationS: 32 });
    const cold = set('add_thermal_bc', {
      name: 'A_cold',
      kind: 'temperature',
      value: 0,
      unit: 'degC',
      target: { entityId: fixture.boxId, facesNear: [[0, 0.0005, 0.0005]] },
    });
    const sine = set('add_thermal_bc', {
      name: 'B_sine',
      kind: 'temperature',
      value: 100,
      unit: 'degC',
      amplitude: 'sine40',
      target: { entityId: fixture.boxId, facesNear: [[0.1, 0.0005, 0.0005]] },
    });
    set('set_thermal_step', { endTimeS: 32, initialIncrementS: 0.5, maxIncrementS: 0.5, fixedIncrements: true, outputEveryS: 0.5 });
    const probe = set('add_result_probe', { name: 'x080', point: [0.08, 0.0005, 0.0005], quantity: 'temperature' });
    const bar = barTets(100, 0.001, 0.001, 0.001);
    const mesh = barMesh(fixture, bar, {
      nodeSets: { [`B_${cold}`]: nodeIdsOn(bar, 0), [`B_${sine}`]: nodeIdsOn(bar, 100), [`P_${probe}`]: [bar.nodeAt(80, 0, 0)] },
    });
    const { deck, results } = solveWithCcx(fixture, mesh);
    expect(deck).toContain('*HEAT TRANSFER, DIRECT\n0.5, 32\n');
    expect(deck).toContain('*NODE FILE, FREQUENCY=1\n');
    const summary = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    expect(summary.times).toHaveLength(64);
    const series = summary.probes.find((entry) => entry.probeId === probe)?.series ?? [];
    expect(series[series.length - 1]?.[0]).toBe(32);
    expectCase(PACK, 'VC-THM-03', series[series.length - 1]?.[1] ?? Number.NaN);
    expect(summary.heatBalance.timeS).toBe(32);
    // ccx closes the energy balance of a boundary driven by an amplitude to about 6 % only (see flowsAndBalance)
    expect(summary.heatBalance.residualRel).toBeLessThan(0.1);
  });
});

describe('material fixture', () => {
  it('builds a document with property models for the ccx bars', () => {
    const fixture = thermalFixture();
    expect(Object.keys(fixture.doc.materials)).toEqual(['steel']);
    expect(withMaterial).toBeTypeOf('function');
  });
});
