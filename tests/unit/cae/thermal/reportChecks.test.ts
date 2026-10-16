import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { ThermalSetup } from '@core/model/analysis';
import { checkThermalItems } from '@cae/thermal/check';
import { thermalResultsSummary } from '@cae/thermal/summary';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { expectCase } from '../../physics/benchmarkCases';
import { addBc, must, recorded, resultsFor, thermalFixture, twoTetMesh } from './fixtures';
import { HOT_T, solvedWall } from './solved';

const PACK = '03-thermal-analysis';
const run = (doc: CadDocument, command: string, params: Record<string, unknown>, ctx = defaultContext()): CommandResult =>
  execute(doc, command, params, ctx);
const codes = (result: CommandResult): string[] => (result.data as { items: { code: string }[] }).items.map((item) => item.code);
const roundDeep = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, v: unknown) => (typeof v === 'number' ? Number(v.toPrecision(12)) : v)));

describe('thermal_report', () => {
  it('returns the numbers of a solved case with the heat balance, tolerance, review flag and no unverified input', () => {
    const wall = solvedWall();
    const result = run(wall.solved, 'thermal_report', { analysisId: wall.analysisId });
    const data = result.data as {
      state: string;
      temperatureScale: string;
      maxT: { value: number };
      heatBalance: { residualRel: number; withinTolerance: boolean; tolerance: unknown };
      bcHeatFlows: { bcId: string }[];
      unverified: boolean;
      physicalConstants: unknown;
      reviewRequired: boolean;
    };
    expect(result.rejected).toBeUndefined();
    expect(data.state).toBe('solved');
    expect(data.temperatureScale).toBe('degC');
    expect(data.maxT.value).toBeCloseTo(HOT_T, 9);
    expect(data.heatBalance.residualRel).toBeLessThan(1e-9);
    expect(data.heatBalance.withinTolerance).toBe(true);
    expect(data.heatBalance.tolerance).toEqual({ value: 0.01, unit: '1', source: 'llull acceptance rule', defaulted: true });
    expect(data.bcHeatFlows.map((flow) => flow.bcId)).toEqual([wall.hotId, wall.coldId]);
    expect(data.unverified).toBe(false);
    expect(data.physicalConstants).toBeNull();
    expect(data.reviewRequired).toBe(true);
    expect(result.summary).toContain('heat balance residual');
    expectPure(wall.solved, () => run(wall.solved, 'thermal_report', { analysisId: wall.analysisId }));
  });

  it('VC-THM-60: radiation cases name the physical constants (sigma, absolute zero) with source and defaulted', () => {
    const base = thermalFixture();
    const rad = addBc(base, {
      name: 'rad',
      kind: 'radiation',
      emissivity: 0.9,
      sinkTemperature: { value: 3, unit: 'K' },
      source: { citation: 's' },
      target: { entityId: base.boxId, facesNear: [[0, 0, 0]] },
    });
    const fixture = { ...base, doc: rad.doc };
    const mesh = twoTetMesh(fixture, { faceSets: { [`B_${rad.id}`]: [[1, 1]] } });
    const results = resultsFor(fixture, mesh, [{ time: 1, temperature: { 1: 100, 2: 100, 3: 100, 4: 100, 5: 100 } }]);
    const doc = recorded(fixture, mesh, results, thermalResultsSummary);
    const data = run(doc, 'thermal_report', { analysisId: base.analysisId }).data as { physicalConstants: unknown };
    expectCase(PACK, 'VC-THM-60', roundDeep({ physicalConstants: data.physicalConstants }) as never, '-');
  });

  it('VC-THM-50: a change after the solve makes the report stale and withholds the numbers', () => {
    const wall = solvedWall();
    const changed = must(wall.solved, 'update_thermal_bc', {
      analysisId: wall.analysisId,
      bcId: wall.hotId,
      filmCoefficient: { value: 60, unit: 'W/(m^2*K)' },
    }).document;
    const stale = run(changed, 'thermal_report', { analysisId: wall.analysisId });
    const data = stale.data as Record<string, unknown>;
    expect(data['state']).toBe('stale');
    expect(data['maxT']).toBeUndefined();
    expect(stale.summary).toContain('stale');
    expect(run(changed, 'check_thermal', { analysisId: wall.analysisId }).data).toMatchObject({ status: 'fail' });
    expect(codes(run(changed, 'check_thermal', { analysisId: wall.analysisId }))).toContain('FEA_RESULTS_STALE');
  });

  it('reports state missing when the recorded artifacts are not in the store, and selects times and probes', () => {
    const wall = solvedWall();
    const missing = run(
      wall.solved,
      'thermal_report',
      { analysisId: wall.analysisId },
      { ...defaultContext(), feaArtifacts: { get: () => null } },
    );
    expect((missing.data as { state: string }).state).toBe('missing');
    const present = run(
      wall.solved,
      'thermal_report',
      { analysisId: wall.analysisId, timeS: 99, probes: [] },
      { ...defaultContext(), feaArtifacts: wall.port },
    );
    expect(present.data).toMatchObject({ state: 'solved', reportedTimeS: 0, probes: [] });
  });

  it('refuses unknown analyses and non-thermal cases', () => {
    const wall = solvedWall();
    const ghost = run(wall.solved, 'thermal_report', { analysisId: 'ghost' });
    expectNoOp(ghost, wall.solved);
    expect(ghost.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const mechanical = must(wall.solved, 'create_analysis', { name: 's', analysisType: 'static' });
    const refused = run(mechanical.document, 'thermal_report', { analysisId: mechanical.affected[0] });
    expect(refused.error?.code).toBe('THM_CASE_TYPE');
  });

  it('VC-THM-63: an unverified conductivity flags the report and the check', () => {
    const wall = solvedWall({ basis: 'typical' });
    const report = run(wall.solved, 'thermal_report', { analysisId: wall.analysisId }).data as {
      unverified: boolean;
      unverifiedReasons: string[];
    };
    expect(report.unverified).toBe(true);
    expect(report.unverifiedReasons).toEqual(['steel.k: basis typical']);
    const checked = run(wall.solved, 'check_thermal', { analysisId: wall.analysisId });
    expect(codes(checked)).toContain('THM_MATERIAL_UNVERIFIED');
    expect(checked.data).toMatchObject({ status: 'warn', unverified: true, reviewRequired: true });
  });
});

describe('check_thermal', () => {
  it('passes a complete steady set-up with no meshed warning once solved, and is pure', () => {
    const wall = solvedWall();
    const result = run(wall.solved, 'check_thermal', { analysisId: wall.analysisId });
    expect(result.data).toMatchObject({ status: 'pass', items: [], reviewRequired: true });
    expect(checkThermalItems(wall.solved, wall.analysisId)).toEqual([]);
    expectPure(wall.solved, () => run(wall.solved, 'check_thermal', { analysisId: wall.analysisId }));
    const unmeshed = run(wall.doc, 'check_thermal', { analysisId: wall.analysisId });
    expect(codes(unmeshed)).toEqual(['FEA_MESH_MISSING']);
    expect(unmeshed.data).toMatchObject({ status: 'warn' });
  });

  it('VC-THM-61: reports the stable codes of the deliberately wrong set-ups, each with a remediation and ids', () => {
    const noCp = thermalFixture({ type: 'heat_transient', cp: null });
    const items = checkThermalItems(noCp.doc, noCp.analysisId);
    expect(items.map((item) => item.code)).toEqual(['THM_INITIAL_TEMPERATURE_MISSING', 'THM_STEP_INVALID', 'THM_MATERIAL_NO_CP']);
    const steady = thermalFixture();
    const flux = addBc(steady, {
      name: 'q',
      kind: 'surface_flux',
      value: 1,
      unit: 'W/m^2',
      target: { entityId: steady.boxId, facesNear: [[0, 0, 0]] },
    });
    expect(checkThermalItems(flux.doc, steady.analysisId).map((item) => item.code)).toEqual(['THM_NO_HEAT_PATH']);
    for (const item of [...items, ...checkThermalItems(flux.doc, steady.analysisId)]) {
      expect(item.remediation.length).toBeGreaterThan(10);
      expect(item.ids.length).toBeGreaterThan(0);
      expect(item.severity).toBe('error');
    }
    const noK = thermalFixture({ k: null });
    expect(checkThermalItems(noK.doc, noK.analysisId).find((item) => item.code === 'THM_MATERIAL_NO_K')).toMatchObject({ path: 'k' });
    expect(checkThermalItems(noK.doc, 'ghost')[0]?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
    const mechanical = must(noK.doc, 'create_analysis', { name: 's', analysisType: 'static' });
    expect(checkThermalItems(mechanical.document, mechanical.affected[0] ?? '')[0]?.code).toBe('THM_CASE_TYPE');
    const refused = run(noK.doc, 'check_thermal', { analysisId: 'ghost' });
    expect(refused.error?.code).toBe('FEA_ANALYSIS_NOT_FOUND');
  });

  it('flags records that bypassed the commands (loaded documents): bad emissivity, missing source, amplitude, cavity, contact, limit, scale', () => {
    const base = thermalFixture({ type: 'heat_transient' });
    const film = addBc(base, {
      name: 'f',
      kind: 'film',
      filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
      sinkTemperature: { value: 20, unit: 'degC' },
      source: { citation: 's' },
      target: { entityId: base.boxId, facesNear: [[0, 0, 0]] },
    });
    const rad = addBc(
      { ...base, doc: film.doc },
      {
        name: 'r',
        kind: 'radiation',
        emissivity: 0.5,
        sinkTemperature: { value: 20, unit: 'degC' },
        source: { citation: 's' },
        target: { entityId: base.boxId, facesNear: [[0, 0, 0]] },
      },
    );
    const setup = rad.doc.analysis!.cases[base.analysisId]!.thermal!;
    const broken = {
      ...setup,
      temperatureScale: 'degF' as never,
      bcs: {
        ...setup.bcs,
        [rad.id]: {
          ...setup.bcs[rad.id]!,
          bc: { ...(setup.bcs[rad.id]!.bc as object), emissivity: 2 } as never,
          source: undefined,
        } as never,
      },
      amplitudes: {
        'am-1.1': {
          id: 'am-1.1',
          name: 'bad',
          points: [
            [1, 0],
            [0, 1],
          ],
        },
      },
      cavities: { 'cv-1.1': { id: 'cv-1.1', name: 'TOOLONG', environment: { kind: 'closed' as const }, faces: [] } },
      contacts: {
        'tc-1.1': {
          id: 'tc-1.1',
          name: 'c',
          master: { entityId: base.boxId },
          slave: { entityId: base.boxId },
          conductance: { value: 1, unit: 'W/(m^2*K)' },
        },
      },
      limits: {
        'tl-1.1': { id: 'tl-1.1', name: 'l', scope: { entityId: base.boxId }, max: { value: 1, unit: 'K' }, source: { citation: ' ' } },
      },
      limitOrder: ['tl-1.1'],
    };
    const doc: CadDocument = {
      ...rad.doc,
      analysis: {
        ...rad.doc.analysis!,
        cases: { [base.analysisId]: { ...rad.doc.analysis!.cases[base.analysisId]!, thermal: broken as unknown as ThermalSetup } },
      },
    };
    const found = checkThermalItems(doc, base.analysisId).map((item) => item.code);
    for (const code of [
      'THM_INITIAL_TEMPERATURE_MISSING',
      'THM_EMISSIVITY_INVALID',
      'THM_AMPLITUDE_INVALID',
      'THM_RADIATION_SCALE',
      'THM_CAVITY_INVALID',
      'THM_CONTACT_UNSUPPORTED',
      'THM_LIMIT_SOURCE_REQUIRED',
    ])
      expect(found, code).toContain(code);
  });

  it('warns THM_HEAT_BALANCE with the numbers when the recorded residual is above the named tolerance (5 % case)', () => {
    const wall = solvedWall({}, 1);
    const unbalanced = solvedWall({}, 1.05);
    const mismatch = (doc: CadDocument): CommandResult => run(doc, 'check_thermal', { analysisId: wall.analysisId });
    expect(codes(mismatch(wall.solved))).toEqual([]);
    // cold film flow 5 % off: residual 0.05 / 1.05
    const result = mismatch({
      ...wall.solved,
      analysis: {
        ...wall.solved.analysis!,
        cases: {
          [wall.analysisId]: {
            ...wall.solved.analysis!.cases[wall.analysisId]!,
            results: {
              ...wall.solved.analysis!.cases[wall.analysisId]!.results!,
              thermal: unbalanced.solved.analysis!.cases[unbalanced.analysisId]!.results!.thermal!,
            },
          },
        },
      },
    });
    expect(codes(result)).toEqual(['THM_HEAT_BALANCE']);
    expect(result.data).toMatchObject({ status: 'warn' });
    const item = (result.data as { items: { message: string }[] }).items[0];
    expect(item?.message).toContain('0.04');
  });

  it('warns THM_PROPERTY_OUT_OF_RANGE for tables the field left', () => {
    const wall = solvedWall(
      {
        k: [
          [0, 10],
          [100, 20],
          [400, 40],
        ],
      },
      1,
      300,
    );
    const summary = wall.solved.analysis!.cases[wall.analysisId]!.results!.thermal!;
    expect(summary.propertyRangeExceeded.length).toBeGreaterThan(0);
    const result = run(wall.solved, 'check_thermal', { analysisId: wall.analysisId });
    expect(codes(result)).toContain('THM_PROPERTY_OUT_OF_RANGE');
  });
});
