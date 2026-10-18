import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { addBc, machineContext, must, recorded, resultsFor, thermalFixture, twoTetMesh } from './fixtures';

const FILM_FACE: readonly (readonly [number, number])[] = [[2, 1]];

function steadyWithProbes(type: 'heat_steady' | 'heat_transient' = 'heat_steady'): {
  doc: ReturnType<typeof recorded>;
  analysisId: string;
} {
  let fixture = thermalFixture({ type });
  const film = addBc(fixture, {
    name: 'film',
    kind: 'film',
    filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
    sinkTemperature: { value: 20, unit: 'degC' },
    source: { citation: 'test source' },
    target: { entityId: fixture.boxId, facesNear: [[0.3, 0.3, 0.3]] },
  });
  fixture = { ...fixture, doc: film.doc };
  const flux = must(fixture.doc, 'add_result_probe', {
    analysisId: fixture.analysisId,
    name: 'q_hot',
    point: [1, 1, 1],
    quantity: 'heat_flux',
  });
  const temperature = must(flux.document, 'add_result_probe', {
    analysisId: fixture.analysisId,
    name: 't_hot',
    point: [1, 1, 1],
    quantity: 'temperature',
  });
  fixture = { ...fixture, doc: temperature.document };
  const mesh = twoTetMesh(fixture, {
    nodeSets: { [`P_${flux.affected[0]}`]: [5], [`P_${temperature.affected[0]}`]: [5] },
    faceSets: { [`B_${film.id}`]: FILM_FACE },
  });
  const results = resultsFor(fixture, mesh, [
    {
      time: 1,
      temperature: { 1: 100, 2: 100, 3: 110, 4: 120, 5: 150 },
      reaction: { 1: 10 * (Math.sqrt(3) / 2) * 90 },
      flux: { 5: [3, 4, 0] },
    },
  ]);
  return { doc: recorded(fixture, mesh, results), analysisId: fixture.analysisId };
}

describe('thermal_report heat-flux probes and steady wording', () => {
  const { doc, analysisId } = steadyWithProbes();
  const result = execute(doc, 'thermal_report', { analysisId }, machineContext());
  const data = result.data as {
    heatFluxProbes: { name: string; unit?: string; quantity: string; values: { time: number; value: number | null }[] }[];
    probes: { name: string }[];
  };

  it('lists heat_flux probes with their flux magnitude (W/m^2) beside the temperature probes', () => {
    expect(result.rejected).toBeUndefined();
    expect(data.probes.map((probe) => probe.name)).toEqual(['t_hot']);
    expect(data.heatFluxProbes).toHaveLength(1);
    expect(data.heatFluxProbes[0]).toMatchObject({ name: 'q_hot', quantity: 'heat_flux', unit: 'W/m^2' });
    expect(data.heatFluxProbes[0]?.values[0]?.value).toBeCloseTo(5, 9);
    expect(result.summary).toContain('heat flux probe q_hot 5 W/m^2');
  });

  it('prints steady state, not t=0 s, for a heat_steady case', () => {
    expect(result.summary).toContain('steady state');
    expect(result.summary).not.toContain('t=0 s');
  });

  it('the probes filter also selects heat-flux probes (an unknown id selects none)', () => {
    const none = execute(doc, 'thermal_report', { analysisId, probes: ['nope'] }, machineContext());
    expect((none.data as { heatFluxProbes: unknown[] }).heatFluxProbes).toEqual([]);
    expect(none.summary).not.toContain('heat flux probe');
  });
});
