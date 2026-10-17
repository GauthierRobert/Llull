/** PHY-04 VC-TMC-50 in full: after editing the thermal case, the dependent thermo_static case reports state stale, margins refused, check item. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { expectCase } from '../../physics/benchmarkCases';
import { PACK } from '../../physics/thermomech/thermomechFixtures';
import { strengthModel } from '../marginsFixtures';
import { mustRun } from '../deckFixtures';
import { hashOf, portOf, thermoFixture, withThermalSource, type ThermalSource } from './fixtures';

interface Item {
  code: string;
  severity: string;
}
interface Report {
  state: string;
}

/** thermo_static case (Ftu / Fty on its material, a thermal load case) reading a solved heat case; both solved with recorded artifacts. */
interface Chain {
  readonly source: ThermalSource;
  readonly ctx: ExecutionContext;
  readonly analysisId: string;
  readonly doc: CadDocument;
}

function solvedChain(): Chain {
  const base = thermoFixture();
  let doc = mustRun(base.doc, 'define_property_model', { material: 'mat', model: strengthModel('Ftu', 400) });
  doc = mustRun(doc, 'define_property_model', { material: 'mat', model: strengthModel('Fty', 250) });
  doc = mustRun(doc, 'add_fea_load', {
    analysisId: base.analysisId,
    name: 'thermal load',
    kind: 'gravity',
    loadCase: 'thermal',
    category: 'limit',
    vector: [0, 0, -1],
  });
  const source = withThermalSource({ ...base, doc });
  const { analysisId } = source.fixture;
  const mesh = { ...source.fixture.mesh, inputHash: analysisInputHash(source.fixture.doc, analysisId, 'mesh') };
  const meshHash = hashOf(mesh);
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash,
    inputHash: analysisInputHash(source.fixture.doc, analysisId, 'full'),
    solver: 'ccx',
    solverVersion: '2.21',
    steps: [
      {
        step: 1,
        time: 1,
        fields: {
          DISP: { components: ['D1', 'D2', 'D3'], values: Object.fromEntries(mesh.nodes.map(([id]) => [String(id), [0.001 * id, 0, 0]])) },
          STRESS: {
            components: ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'],
            values: Object.fromEntries(mesh.nodes.map(([id]) => [String(id), [100 + id, 0, 0, 0, 0, 0]])),
          },
        },
      },
    ],
  };
  const resultsHash = hashOf(results);
  const port = portOf({
    [hashOf(source.thermalMesh)]: source.thermalMesh,
    [source.resultsHash]: source.results,
    [meshHash]: mesh,
    [resultsHash]: results,
  });
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: port };
  const meshed = execute(source.fixture.doc, 'record_fe_mesh', { analysisId, summary: meshSummary(mesh, meshHash) }, ctx);
  const solved = execute(
    meshed.document,
    'record_fea_results',
    { analysisId, summary: resultsSummary(source.fixture.doc, analysisId, mesh, results, resultsHash) },
    ctx,
  );
  return { source, ctx, analysisId, doc: solved.document };
}

describe('VC-TMC-50 staleness chain thermal -> thermo_static', () => {
  it('is solved, with a margin, before the thermal case is edited', () => {
    const { doc, ctx, analysisId } = solvedChain();
    expect((execute(doc, 'fea_report', { analysisId }, ctx).data as Report).state).toBe('solved');
    const margins = execute(doc, 'compute_margins', { analysisId, allowable: 'ftu' }, ctx);
    expect(margins.rejected).not.toBe(true);
    // max sxx = 105 MPa at the largest node id, thermal load case limit: MS = 400 / (105 x 1.5) - 1
    expect((margins.data as { rows: { ms: number; loadCase: string }[] }).rows[0]).toMatchObject({ loadCase: 'thermal' });
    expect((margins.data as { rows: { ms: number }[] }).rows[0]?.ms).toBeCloseTo(400 / (105 * 1.5) - 1, 9);
    const items = (execute(doc, 'check_thermo_mechanical', { analysisId }, ctx).data as { items: Item[] }).items;
    expect(items.map((item) => item.code)).toEqual([]);
  });

  it('judges fea_report state, compute_margins code and check_thermo_mechanical items after editing the thermal case (all three keys)', () => {
    const { doc, ctx, analysisId, source } = solvedChain();
    const edited = mustRun(doc, 'add_result_probe', { analysisId: source.thermalId, name: 'p', point: [1, 1, 1], quantity: 'temperature' });
    const report = execute(edited, 'fea_report', { analysisId }, ctx);
    const margins = execute(edited, 'compute_margins', { analysisId }, ctx);
    const check = execute(edited, 'check_thermo_mechanical', { analysisId }, ctx);
    expect(margins.document).toBe(edited);
    expectCase(PACK, 'VC-TMC-50', {
      'fea_report(ms).state': (report.data as Report).state,
      'compute_margins(ms).code': margins.error?.code ?? null,
      'check_thermo_mechanical(ms).items': (check.data as { items: Item[] }).items.map((item) => item.code),
    });
  });
});
