/** Result access (FEA-REST part 2): set_result_view, fea_result_field, set_buckling_preload and the preloaded buckling deck. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { writeBdf } from '@cae/decks/bdfWriter';
import { writeInp } from '@cae/decks/inpWriter';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { stateOf } from '@cae/shared/state';
import { X0_NODES, X2_NODES, barDocument, barMesh, mustRun, solvedBar } from './deckFixtures';
import { eigenCase, modalDat } from './eigenFixtures';
import { caseIn } from './helpers';
import { marginBar } from './marginsFixtures';

const bar = marginBar();
interface Field {
  field: string;
  unit: string;
  count: number;
  selection: string;
  resultSet: string;
  min: { value: number; node: number } | null;
  max: { value: number; node: number; at: number[] } | null;
  mean: number | null;
  rows: { node: number; value: number; at: number[]; distance?: number; entityId: string }[];
  missingNodes: number[];
}
const read = (params: Record<string, unknown>, doc = bar.recorded): ReturnType<typeof execute> =>
  execute(doc, 'fea_result_field', { analysisId: bar.analysisId, ...params }, bar.ctx);
const dataOf = (result: ReturnType<typeof execute>): Field => result.data as unknown as Field;

describe('fea_result_field', () => {
  it('reads the nodes with the largest von Mises value and the statistics of the whole result set', () => {
    const result = read({ field: 'von_mises' });
    expect(result.rejected).not.toBe(true);
    const data = dataOf(result);
    expect(data).toMatchObject({ field: 'von_mises', unit: 'MPa', count: 8, selection: 'extremes', resultSet: 'load case LC1' });
    expect(data.rows.length).toBe(8);
    expect(data.rows[0]?.value).toBe(data.max?.value);
    expect(data.rows.map((row) => row.value)).toEqual([...data.rows.map((row) => row.value)].sort((a, b) => b - a));
    expect(data.max?.value).toBeGreaterThan(150);
    expect(data.mean).toBeLessThanOrEqual(data.max?.value ?? 0);
    expect(result.summary).toContain('fea_result_field: von_mises');
  });

  it('smallest first with a limit; displacement fields use the length unit', () => {
    const data = dataOf(read({ field: 'u_x', order: 'smallest', limit: 3 }));
    expect(data.unit).toBe('mm');
    expect(data.rows).toHaveLength(3);
    expect(data.rows[0]?.value).toBeLessThanOrEqual(data.rows[2]?.value ?? 0);
    expect(data.min?.value).toBe(data.rows[0]?.value);
  });

  it('reads named nodes (unknown ones are reported), nearest nodes of points (document units) and of the probes', () => {
    const named = dataOf(read({ field: 'u_mag', nodes: [2, 99] }));
    expect(named).toMatchObject({ selection: 'nodes', missingNodes: [99] });
    expect(named.rows.map((row) => row.node)).toEqual([2]);
    const points = dataOf(read({ field: 'u_x', points: [[2, 0.1, 0]] }));
    expect(points).toMatchObject({ selection: 'points' });
    expect(points.rows[0]?.node).toBe(2);
    expect(points.rows[0]?.distance).toBeCloseTo(0.1, 9);
  });

  it('reads the nearest node of every result probe', () => {
    const solved = solvedBar();
    const ctx = { ...defaultContext(), feaArtifacts: solved.port };
    const meshed = execute(
      solved.doc,
      'record_fe_mesh',
      { analysisId: solved.analysisId, summary: meshSummary(solved.mesh, solved.meshHash) },
      ctx,
    ).document;
    const recorded = execute(
      meshed,
      'record_fea_results',
      {
        analysisId: solved.analysisId,
        summary: resultsSummary(meshed, solved.analysisId, solved.mesh, solved.results, solved.resultsHash),
      },
      ctx,
    ).document;
    const result = execute(recorded, 'fea_result_field', { analysisId: solved.analysisId, field: 'von_mises', probes: true }, ctx);
    const probes = result.data as unknown as Field;
    expect(probes.selection).toBe('probes');
    expect(probes.rows).toHaveLength(2);
    expect(probes.rows.map((row) => row.node)).toContain(2);
  });

  it('refuses unknown analyses, two selections, unsolved cases, unknown load cases / modes and absent fields; is pure', () => {
    const before = JSON.stringify(bar.recorded);
    expect(execute(bar.recorded, 'fea_result_field', { analysisId: 'nope', field: 'von_mises' }, bar.ctx).summary).toContain(
      'FEA_ANALYSIS_NOT_FOUND',
    );
    expect(read({ field: 'von_mises', nodes: [1], probes: true }).summary).toContain('FEA_PARAM_INVALID');
    expect(read({ field: 'von_mises', loadCase: 'nope' }).summary).toContain("no load case 'nope'");
    expect(read({ field: 'temperature' }).summary).toContain('FEA_FIELD_MISSING');
    const unsolved = execute(bar.doc, 'fea_result_field', { analysisId: bar.analysisId, field: 'von_mises' }, bar.ctx);
    expect(unsolved.summary).toContain('FEA_RESULTS_MISSING');
    expect(unsolved.document).toBe(bar.doc);
    expect(JSON.stringify(bar.recorded)).toBe(before);
  });

  it('a modal case without displacement fields has no field to read, and a mode beyond the results is named', () => {
    const modal = eigenCase({ type: 'modal', dat: modalDat([100, 200]) });
    const call = (params: Record<string, unknown>): ReturnType<typeof execute> =>
      execute(modal.recorded, 'fea_result_field', { analysisId: modal.bar.analysisId, ...params }, modal.ctx);
    expect(call({ field: 'u_mag' }).summary).toContain('FEA_FIELD_MISSING');
    expect(call({ field: 'u_mag', mode: 5 }).summary).toContain('no mode 5');
  });
});

describe('set_result_view', () => {
  it('records the field, load case and scale on the case without making results stale', () => {
    const before = analysisInputHash(bar.recorded, bar.analysisId, 'full');
    const result = execute(bar.recorded, 'set_result_view', {
      analysisId: bar.analysisId,
      field: 'von_mises',
      loadCase: 'LC1',
      deformationScale: 50,
    });
    expect(result.rejected).not.toBe(true);
    expect(result.affected).toEqual([bar.analysisId]);
    expect(caseIn(result.document, bar.analysisId).view).toEqual({ field: 'von_mises', loadCase: 'LC1', deformationScale: 50 });
    expect(analysisInputHash(result.document, bar.analysisId, 'full')).toBe(before);
    expect(stateOf(result.document, caseIn(result.document, bar.analysisId))).toBe('solved');
    expect(execute(bar.recorded, 'set_result_view', { analysisId: bar.analysisId, field: 'u_mag' }).document).not.toBe(bar.recorded);
    expect(
      caseIn(execute(bar.recorded, 'set_result_view', { analysisId: bar.analysisId, field: 'u_mag' }).document, bar.analysisId).view
        ?.deformationScale,
    ).toBe(1);
  });

  it('modal cases take a mode (default 1)', () => {
    const modal = eigenCase({ type: 'modal' });
    const result = execute(modal.recorded, 'set_result_view', { analysisId: modal.bar.analysisId, field: 'mode' });
    expect(caseIn(result.document, modal.bar.analysisId).view).toEqual({ field: 'mode', mode: 1, deformationScale: 1 });
    expect(execute(modal.recorded, 'set_result_view', { analysisId: modal.bar.analysisId, field: 'mode', mode: 3 }).summary).toContain(
      'mode 3',
    );
  });

  it('refuses unknown analyses, the mode field on other types, a mode with another field, bad scales and bad load case names', () => {
    const refused = (params: Record<string, unknown>): string => {
      const result = execute(bar.recorded, 'set_result_view', { analysisId: bar.analysisId, field: 'u_mag', ...params });
      expect(result.document).toBe(bar.recorded);
      return result.summary;
    };
    expect(refused({ analysisId: 'nope' })).toContain('FEA_ANALYSIS_NOT_FOUND');
    expect(refused({ field: 'mode' })).toContain("field 'mode' needs a modal / buckling analysis");
    expect(refused({ mode: 2 })).toContain("mode applies to field 'mode' only");
    expect(refused({ deformationScale: -1 })).toContain('deformationScale');
    expect(refused({ deformationScale: Number.POSITIVE_INFINITY })).toContain('deformationScale');
    expect(refused({ loadCase: 'bad name!' })).toContain('FEA_PARAM_INVALID');
  });
});

describe('set_buckling_preload and the preloaded buckling deck', () => {
  const model = (): {
    doc: ReturnType<typeof barDocument>['doc'];
    analysisId: string;
    boxId: string;
    sets: Record<string, number[]>;
    faces: Record<string, never[]>;
  } => {
    const base = barDocument({ analysisType: 'buckling' });
    let doc = base.doc;
    const sets: Record<string, number[]> = {
      [`C_${base.constraints['x0']}`]: X0_NODES,
      [`C_${base.constraints['nodeA']}`]: [1],
      [`C_${base.constraints['nodeB']}`]: [3],
    };
    for (const [loadCase, vector] of [
      ['dead', [0, 0, -50]],
      ['LC2', [-1000, 0, 0]],
    ] as const) {
      doc = mustRun(doc, 'add_fea_load', {
        analysisId: base.analysisId,
        name: loadCase,
        kind: 'force',
        loadCase,
        vector,
        target: { entityId: base.boxId, facesNear: [[2, 0.5, 0.5]] },
      });
      sets[`L_${caseIn(doc, base.analysisId).loadOrder.at(-1)}`] = X2_NODES;
    }
    return { doc, analysisId: base.analysisId, boxId: base.boxId, sets, faces: {} };
  };

  it('stores the preload load case and makes results stale (not the mesh)', () => {
    const { doc, analysisId } = model();
    const meshHashBefore = analysisInputHash(doc, analysisId, 'mesh');
    const fullBefore = analysisInputHash(doc, analysisId, 'full');
    const result = execute(doc, 'set_buckling_preload', { analysisId, preloadLoadCase: 'dead' });
    expect(result.rejected).not.toBe(true);
    expect(result.affected).toEqual([analysisId]);
    expect(caseIn(result.document, analysisId).preloadLoadCase).toBe('dead');
    expect(analysisInputHash(result.document, analysisId, 'mesh')).toBe(meshHashBefore);
    expect(analysisInputHash(result.document, analysisId, 'full')).not.toBe(fullBefore);
    const cleared = execute(result.document, 'set_buckling_preload', { analysisId });
    expect(caseIn(cleared.document, analysisId)).not.toHaveProperty('preloadLoadCase');
  });

  it('refuses other analysis types, unknown or empty load cases, bad names and unknown analyses; is pure', () => {
    const { doc, analysisId } = model();
    const before = JSON.stringify(doc);
    expect(execute(doc, 'set_buckling_preload', { analysisId: 'nope', preloadLoadCase: 'dead' }).summary).toContain(
      'FEA_ANALYSIS_NOT_FOUND',
    );
    expect(execute(doc, 'set_buckling_preload', { analysisId, preloadLoadCase: 'ghost' }).summary).toContain(
      "no load of load case 'ghost'",
    );
    expect(execute(doc, 'set_buckling_preload', { analysisId, preloadLoadCase: 'bad name' }).summary).toContain('FEA_LOAD_INVALID');
    const staticBar = barDocument();
    expect(execute(staticBar.doc, 'set_buckling_preload', { analysisId: staticBar.analysisId, preloadLoadCase: 'LC1' }).summary).toContain(
      'FEA_PARAM_NOT_APPLICABLE',
    );
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('without a preload the deck is one *BUCKLE step; with one a *STATIC preload step comes first and the reference loads are added without OP=NEW', () => {
    const { doc, analysisId, boxId, sets } = model();
    const plain = writeInp(doc, analysisId, barMesh(doc, analysisId, boxId, sets));
    const plainText = 'text' in plain ? plain.text : JSON.stringify(plain);
    expect(plainText.match(/^\*STEP$/gm)).toHaveLength(1);
    expect(plainText).toContain('** buckling reference load case dead');
    const preloaded = execute(doc, 'set_buckling_preload', { analysisId, preloadLoadCase: 'dead' }).document;
    const written = writeInp(preloaded, analysisId, barMesh(preloaded, analysisId, boxId, sets));
    const text = 'text' in written ? written.text : JSON.stringify(written);
    const steps = text.slice(text.indexOf('** buckling preload'));
    expect(steps).toContain('** buckling preload (ccx scales it with the reference): load case dead\n*STEP\n*STATIC\n*BOUNDARY, OP=NEW');
    expect(steps).toContain('*CLOAD, OP=NEW\n');
    expect(steps).toMatch(/\*END STEP\n\*\* buckling reference load case LC2\n\*STEP\n\*BUCKLE\n3\n\*CLOAD\n/);
    expect(steps).not.toMatch(/\*BUCKLE\n3\n\*BOUNDARY/);
    expect(steps.match(/^\*STEP$/gm)).toHaveLength(2);
  });

  it('a preload with no other load case has nothing to scale: the deck and check_analysis say so; the BDF refuses a preload', () => {
    const base = barDocument({ analysisType: 'buckling' });
    let doc = mustRun(base.doc, 'add_fea_load', {
      analysisId: base.analysisId,
      name: 'dead',
      kind: 'force',
      loadCase: 'dead',
      vector: [0, 0, -50],
      target: { entityId: base.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    doc = execute(doc, 'set_buckling_preload', { analysisId: base.analysisId, preloadLoadCase: 'dead' }).document;
    const loadId = caseIn(doc, base.analysisId).loadOrder[0] ?? '';
    const mesh = barMesh(doc, base.analysisId, base.boxId, {
      [`C_${base.constraints['x0']}`]: X0_NODES,
      [`C_${base.constraints['nodeA']}`]: [1],
      [`C_${base.constraints['nodeB']}`]: [3],
      [`L_${loadId}`]: X2_NODES,
    });
    expect(writeInp(doc, base.analysisId, mesh)).toMatchObject({ code: 'FEA_NO_LOADS' });
    expect(writeBdf(doc, base.analysisId, mesh)).toMatchObject({ code: 'FEA_BDF_UNSUPPORTED' });
    const check = execute(doc, 'check_analysis', { analysisId: base.analysisId });
    expect(
      (check.data as { items: { code: string; message: string }[] }).items.some(
        (item) => item.code === 'FEA_NO_LOADS' && item.message.includes('preload'),
      ),
    ).toBe(true);
  });
});
