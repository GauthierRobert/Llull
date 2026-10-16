/** PHY-03 benchmark support: explicit Stefan-Boltzmann constant, cavity-radiation start warning, temperature probes between nodes. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { STEFAN_BOLTZMANN } from '@lib/thermalClosedForms';
import { buildDeckContext } from '@cae/decks/context';
import { thermalSections } from '@cae/thermal/deck';
import { thermalResultsSummary } from '@cae/thermal/summary';
import { evaluateProbes } from '@cae/results/probes';
import { locatePoint } from '@cae/results/probeInterpolation';
import { solvedWall } from './solved';
import { addBc, caseOf, must, resultsFor, thermalFixture, twoTetMesh, type ThermalFixture } from './fixtures';

const source = { citation: 'test source' };
const FACE_234: [number, number][] = [[2, 3]];

function radiating(options: { constant?: number } = {}): { fixture: ThermalFixture; bcId: string } {
  const base = thermalFixture({ units: 'm' });
  const bc = addBc(base, {
    name: 'rad',
    kind: 'radiation',
    emissivity: 1,
    sinkTemperature: { value: 300, unit: 'K' },
    source,
    target: { entityId: base.boxId, facesNear: [[0.3, 0.3, 0.3]] },
  });
  let doc = bc.doc;
  if (options.constant !== undefined)
    doc = must(doc, 'set_thermal_physical_constants', {
      analysisId: base.analysisId,
      stefanBoltzmann: { value: options.constant, source: 'benchmark statement' },
    }).document;
  return { fixture: { ...base, doc }, bcId: bc.id };
}

describe('set_thermal_physical_constants', () => {
  it('records a sourced override (defaulted: false), writes it to the deck and reports it', () => {
    const { fixture, bcId } = radiating({ constant: 5.669e-8 });
    expect(caseOf(fixture.doc, fixture.analysisId).thermal?.stefanBoltzmann).toEqual({
      value: 5.669e-8,
      unit: 'W/(m^2 K^4)',
      source: 'benchmark statement',
      defaulted: false,
    });
    const mesh = twoTetMesh(fixture, { faceSets: { [`B_${bcId}`]: FACE_234 } });
    const ctx = buildDeckContext(fixture.doc, fixture.analysisId, mesh);
    const sections = ctx === null ? null : thermalSections(ctx);
    expect(sections !== null && 'text' in sections ? sections.text : '').toContain('STEFAN BOLTZMANN=5.669e-8');
    const results = resultsFor(fixture, mesh, [{ time: 1, temperature: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100 } }]);
    const summary = thermalResultsSummary(fixture.doc, fixture.analysisId, mesh, results);
    expect(summary.physicalConstants?.stefanBoltzmann).toMatchObject({ value: 5.669e-8, defaulted: false, source: 'benchmark statement' });
    const flow = summary.bcHeatFlowsW.find((entry) => entry.bcId === bcId)?.valueW ?? Number.NaN;
    const area = Math.sqrt(3) / 2;
    expect(flow).toBeCloseTo(5.669e-8 * area * (300 ** 4 - 373.15 ** 4), 6);
  });

  it('changes the input hash, and clearing the override restores the SI default', () => {
    const { fixture } = radiating();
    const before = JSON.stringify(caseOf(fixture.doc, fixture.analysisId));
    const set = must(fixture.doc, 'set_thermal_physical_constants', {
      analysisId: fixture.analysisId,
      stefanBoltzmann: { value: 5.67e-8, source: 'NAFEMS T2 statement' },
    });
    expect(JSON.stringify(caseOf(set.document, fixture.analysisId))).not.toBe(before);
    const cleared = must(set.document, 'set_thermal_physical_constants', { analysisId: fixture.analysisId });
    expect(cleared.summary).toContain(String(STEFAN_BOLTZMANN));
    expect(caseOf(cleared.document, fixture.analysisId).thermal?.stefanBoltzmann).toBeUndefined();
  });

  it('is pure and refuses unknown analyses, bad values and a missing source', () => {
    const { fixture } = radiating();
    const snapshot = JSON.stringify(fixture.doc);
    must(fixture.doc, 'set_thermal_physical_constants', {
      analysisId: fixture.analysisId,
      stefanBoltzmann: { value: 5.67e-8, source: 's' },
    });
    expect(JSON.stringify(fixture.doc)).toBe(snapshot);
    const refused = (params: Record<string, unknown>): { summary: string; changed: boolean } => {
      const result = execute(fixture.doc, 'set_thermal_physical_constants', params);
      expect(result.document).toBe(fixture.doc);
      return { summary: result.summary, changed: result.document !== fixture.doc };
    };
    expect(refused({ analysisId: 'ghost' }).summary).toContain('FEA_ANALYSIS_NOT_FOUND');
    for (const value of [0, -1, Number.POSITIVE_INFINITY])
      expect(refused({ analysisId: fixture.analysisId, stefanBoltzmann: { value, source: 's' } }).summary).toMatch(
        /THM_CONSTANT_INVALID|invalid params/,
      );
    expect(refused({ analysisId: fixture.analysisId, stefanBoltzmann: { value: 5.67e-8, source: '  ' } }).summary).toContain(
      'THM_CONSTANT_INVALID',
    );
  });
});

describe('check_thermal: steady cavity radiation without an initial temperature', () => {
  const codes = (doc: ThermalFixture['doc'], analysisId: string): { code: string; severity: string }[] =>
    ((execute(doc, 'check_thermal', { analysisId }).data as { items: { code: string; severity: string }[] }).items ?? [])
      .filter((item) => item.code === 'THM_INITIAL_TEMPERATURE_MISSING')
      .map(({ code, severity }) => ({ code, severity }));

  it('warns, and stops warning once the start temperature is set', () => {
    const base = thermalFixture({ scale: 'K' });
    const temperature = addBc(base, {
      name: 'T',
      kind: 'temperature',
      value: 400,
      unit: 'K',
      target: { entityId: base.boxId, facesNear: [[0.5, 0.5, 0]] },
    });
    const cavity = must(temperature.doc, 'add_cavity_radiation', {
      analysisId: base.analysisId,
      name: 'C1',
      environmentTemperature: { value: 300, unit: 'K' },
      faces: [
        { target: { entityId: base.boxId, facesNear: [[0.5, 0.5, 0]] }, emissivity: 1 },
        { target: { entityId: base.boxId, facesNear: [[0.5, 0.5, 0.05]] }, emissivity: 1 },
      ],
    });
    expect(codes(cavity.document, base.analysisId)).toEqual([{ code: 'THM_INITIAL_TEMPERATURE_MISSING', severity: 'warning' }]);
    const started = must(cavity.document, 'set_initial_temperature', { analysisId: base.analysisId, value: 350, unit: 'K' });
    expect(codes(started.document, base.analysisId)).toEqual([]);
    expect(codes(temperature.doc, base.analysisId)).toEqual([]);
  });
});

describe('check_thermal: heat balance of a cavity case', () => {
  it('says the balance is not evaluated instead of reporting a one-sided residual', () => {
    const cavity = solvedWall({}, 1, undefined, (fixture) => ({
      doc: must(fixture.doc, 'add_cavity_radiation', {
        analysisId: fixture.analysisId,
        name: 'C1',
        environmentTemperature: { value: 300, unit: 'K' },
        faces: [
          { target: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0]] }, emissivity: 1 },
          { target: { entityId: fixture.boxId, facesNear: [[0.5, 0.5, 0.05]] }, emissivity: 1 },
        ],
      }).document,
    }));
    const items = (
      execute(cavity.solved, 'check_thermal', { analysisId: cavity.analysisId }).data as { items: { code: string; message: string }[] }
    ).items;
    const balance = items.filter((item) => item.code === 'THM_HEAT_BALANCE');
    expect(balance).toHaveLength(1);
    expect(balance[0]?.message).toContain('not evaluated');
    const plain = solvedWall();
    const plainItems = (execute(plain.solved, 'check_thermal', { analysisId: plain.analysisId }).data as { items: { code: string }[] })
      .items;
    expect(plainItems.some((item) => item.code === 'THM_HEAT_BALANCE')).toBe(false);
  });
});

describe('temperature probes between nodes', () => {
  const probeAt = (point: [number, number, number], temperature: Record<number, number>, quantity = 'temperature'): number | null => {
    const base = thermalFixture({ units: 'm' });
    const probe = must(base.doc, 'add_result_probe', { analysisId: base.analysisId, name: 'p', point, quantity });
    const fixture = { ...base, doc: probe.document };
    const mesh = twoTetMesh(fixture);
    const results = resultsFor(fixture, mesh, [{ time: 1, temperature }]);
    return evaluateProbes(caseOf(fixture.doc, fixture.analysisId), mesh, results, 1)[0]?.values[0]?.value ?? null;
  };
  const LINEAR = { 1: 10, 2: 11, 3: 12, 4: 13, 5: 16 }; // T = 10 + x + 2 y + 3 z over the two tets? node 5 (1,1,1) -> 16

  it('reproduces a linear field exactly inside an element and on a shared face', () => {
    expect(probeAt([0.2, 0.2, 0.2], LINEAR)).toBeCloseTo(10 + 0.2 + 0.4 + 0.6, 12);
    expect(probeAt([0.7, 0.7, 0.5], LINEAR)).toBeCloseTo(10 + 0.7 + 1.4 + 1.5, 12);
    expect(probeAt([1 / 3, 1 / 3, 1 / 3], LINEAR)).toBeCloseTo(10 + 2, 12);
  });

  it('keeps the exact nodal value at a node and the nearest node outside the mesh; other quantities stay nodal', () => {
    expect(probeAt([1, 0, 0], LINEAR)).toBe(11);
    expect(probeAt([3, 3, 3], LINEAR)).toBe(16);
    expect(probeAt([0.2, 0.2, 0.2], LINEAR, 'u_x')).toBeNull();
  });

  it('gives NaN-safe null when a corner has no value', () => {
    expect(probeAt([0.2, 0.2, 0.2], { 1: 10, 2: 11, 3: 12 })).toBeNull();
  });
});

describe('locatePoint', () => {
  it('uses quadratic C3D10 shape functions that sum to one and are zero at the other corners', () => {
    const corners = [
      [1, 0, 0, 0],
      [2, 1, 0, 0],
      [3, 0, 1, 0],
      [4, 0, 0, 1],
      [5, 0.5, 0, 0],
      [6, 0.5, 0.5, 0],
      [7, 0, 0.5, 0],
      [8, 0, 0, 0.5],
      [9, 0.5, 0, 0.5],
      [10, 0, 0.5, 0.5],
    ] as const;
    const mesh = {
      kind: 'fe_mesh',
      unitSystem: 'N-m-kg-s',
      mesher: 't',
      mesherVersion: '1',
      inputHash: '',
      nodes: corners,
      blocks: [{ type: 'C3D10', entityId: 'e', elements: [[1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]] }],
      nodeSets: {},
      faceSets: {},
      targets: {},
    } as const;
    const at = locatePoint(mesh, [0.2, 0.1, 0.3]);
    expect(at?.nodes).toHaveLength(10);
    expect(at?.nodes.reduce((sum, [, weight]) => sum + weight, 0)).toBeCloseTo(1, 12);
    const quadraticField = (x: number, y: number, z: number): number => 1 + x * x + 2 * x * y - z * z + y;
    const interpolated = at?.nodes.reduce((sum, [node, weight]) => {
      const c = corners[node - 1];
      return sum + weight * quadraticField(c?.[1] ?? 0, c?.[2] ?? 0, c?.[3] ?? 0);
    }, 0);
    expect(interpolated).toBeCloseTo(quadraticField(0.2, 0.1, 0.3), 12);
    expect(locatePoint(mesh, [2, 2, 2])).toBeNull();
    expect(locatePoint({ ...mesh, blocks: [{ type: 'S3', entityId: 'e', elements: [[1, 1, 2, 3]] }] }, [0.1, 0.1, 0])).toBeNull();
  });
});
