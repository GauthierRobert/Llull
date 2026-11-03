/**
 * PST-M4 review surface: `pipe_stress_report` (HTML / CSV, escaping, approval states, refusals) and `render_view overlay: "pipe_stress"` (ratio colours, stats,
 * perspective note, isolate, unknown kind without the plugin).
 */

import { describe, expect, it, vi } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { HumanSignaturePort } from '@core/model/analysis';
import { pluginRenderOverlays } from '@core/plugins/host';
import { humanGatePayload } from '@core/model/humanGate';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { analyzeStressModel } from '@aec/plant/stress/analysis';
import { pipeStressOverlay, bandOf } from '@aec/plant/stress/report/overlay';
import { buildReportData, type ReportData } from '@aec/plant/stress/report/reportData';
import { reportCsv, reportHtml } from '@aec/plant/stress/report/reportFiles';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { valveScene } from '../piping/rteFixtures';
import { anchorAt, baseDoc, conditioned, recordedModel, withModel, withPipe, DN100 } from './m3Fixtures';

const AT = '2026-11-02T09:30:00Z';

interface ReportOut {
  text: string;
  fileName: string;
  sha256: string;
  format: string;
  status: string;
  record: { status: string };
  approval: { status: string; signer: string | null };
  stationCount: number;
  failingStations: number;
  reviewRequired: boolean;
  unverified: { code: string }[];
  findings: { code: string }[];
}
const report = (doc: CadDocument, params: Record<string, unknown>): ReportOut => data<ReportOut>(doc, 'pipe_stress_report', params);

function approved(doc: CadDocument, id: string): CadDocument {
  const results = doc.plant?.stress?.models[id]?.recorded;
  if (results === undefined) throw new Error('not recorded');
  const payload = humanGatePayload(
    'plant:approve_pipe_stress',
    [id],
    { inputHash: results.inputHash, resultHash: results.resultHash },
    'n1',
  );
  const signature = { payload, nonce: 'n1' };
  const spent = new Set<string>();
  const port: HumanSignaturePort = {
    verify: vi.fn((s: unknown, p: string) =>
      (s as { payload?: string }).payload === p ? { signer: 'alice', signatureId: 'sig-1' } : null,
    ),
    spend: vi.fn((s: unknown) => !spent.has(JSON.stringify(s)) && (spent.add(JSON.stringify(s)), true)),
  };
  const ctx: ExecutionContext = { ...defaultContext(), humanSignature: port };
  const result = execute(doc, 'approve_pipe_stress', { modelId: id, confirmation: signature, at: AT }, ctx);
  expect(result.rejected, result.summary).toBeUndefined();
  return result.document;
}

describe('pipe_stress_report', () => {
  it('HTML: model, code and edition, cases, stations, approval none, review required; the file name and hash come with it', () => {
    const { doc, id } = recordedModel();
    const out = report(doc, { modelId: id });
    expect(out.format).toBe('html');
    expect(out.fileName).toBe(`${id}-stress-report.html`);
    expect(out.status).toBe('pass');
    expect(out.record.status).toBe('current');
    expect(out.approval).toEqual({ status: 'none', signer: null, at: null });
    expect(out.reviewRequired).toBe(true);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.text.startsWith('<!DOCTYPE html>')).toBe(true);
    for (const needle of [
      'B31.3',
      '2018',
      'Load cases: governing ratio',
      'Support loads',
      'Stations',
      'SUS',
      'OPE',
      'EXP',
      'Review required',
    ])
      expect(out.text).toContain(needle);
    expect(out.stationCount).toBeGreaterThan(0);
    expect(out.failingStations).toBe(0);
  });

  it('is deterministic and read-only', () => {
    const { doc, id } = recordedModel();
    expect(report(doc, { modelId: id }).text).toBe(report(doc, { modelId: id }).text);
    expect(execute(doc, 'pipe_stress_report', { modelId: id }).document).toBe(doc);
    expectPure(doc, () => execute(doc, 'pipe_stress_report', { modelId: id, format: 'csv' }));
  });

  it('approval states: none -> approved after the human gate -> stale for a forged approval over other results; an edit makes the record stale', () => {
    const { doc, id } = recordedModel();
    const signed = approved(doc, id);
    expect(report(signed, { modelId: id }).approval).toEqual({ status: 'approved', signer: 'alice', at: AT });
    const stale = apply(signed, 'update_stress_model', { modelId: id, elbowRadiusFactor: 0.2 });
    const staleOut = report(stale, { modelId: id });
    expect(staleOut.record.status).toBe('stale');
    expect(staleOut.findings.map((finding) => finding.code)).toContain('PST_RESULTS_STALE');
    expect(staleOut.text).toContain('PST_RESULTS_STALE');
    const model = stale.plant?.stress?.models[id];
    if (model === undefined) throw new Error('model');
    const forged: CadDocument = {
      ...stale,
      plant: {
        ...stale.plant,
        stress: { ...stale.plant?.stress, models: { [id]: { ...model, approval: signed.plant?.stress?.models[id]?.approval } } },
      },
    } as CadDocument;
    expect(report(forged, { modelId: id }).approval.status).toBe('stale');
  });

  it('unverified inputs: a constant secant coefficient is listed as unverified', () => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [4000, 0, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(pipes, [pipeId]);
    const withCte = conditioned(doc, id, {}, { thermal: { meanCtePerK: 1.2e-5 } });
    const anchored = apply(
      apply(withCte, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: 0 }, kind: 'anchor' }),
      'add_stress_restraint',
      { modelId: id, at: { pipeId, atMm: 4000 }, kind: 'anchor' },
    );
    const out = report(apply(anchored, 'set_stress_load_cases', { modelId: id, preset: 'b31.3-default' }), { modelId: id });
    expect(out.unverified.map((finding) => finding.code)).toContain('PST_MATERIAL_UNVERIFIED');
    expect(out.text).toContain('PST_MATERIAL_UNVERIFIED');
  });

  it('CSV: header + one row per station, RFC 4180; the cases, supports and findings tables', () => {
    const { doc, id } = recordedModel();
    const stations = report(doc, { modelId: id, format: 'csv' });
    expect(stations.fileName).toBe(`${id}-stress-stations.csv`);
    const lines = stations.text.trimEnd().split('\n');
    expect(lines[0]).toBe('case,pipeId,element,node,xMm,stressMPa,allowableMPa,ratio,result,rule');
    expect(lines).toHaveLength(stations.stationCount + 1);
    const cases = report(doc, { modelId: id, format: 'csv', table: 'cases' }).text.trimEnd().split('\n');
    expect(cases[0]).toBe('case,type,governingNode,governingRatio,result,rule');
    expect(cases).toHaveLength(4);
    expect(report(doc, { modelId: id, format: 'csv', table: 'supports' }).text).toContain('Fx_N');
    expect(report(doc, { modelId: id, format: 'csv', table: 'findings' }).text.startsWith('code,severity')).toBe(true);
  });

  it('escapes HTML and quotes CSV (RFC 4180) with the spreadsheet formula guard', () => {
    const { doc, id } = recordedModel();
    const model = doc.plant?.stress?.models[id];
    const analysis = model === undefined ? null : analyzeStressModel(doc, model);
    if (model === undefined || analysis === null || !analysis.ok) throw new Error('fixture');
    const base = buildReportData({ ...model, name: '<img src=x onerror=alert(1)> & "q"' }, analysis);
    const hostile: ReportData = {
      ...base,
      findings: [
        { code: 'X', severity: 'warn', ids: ['a', 'b'], paths: [], message: 'says "hi", then\nnewline', remediation: '=cmd|calc' },
      ],
    };
    const html = reportHtml(hostile);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;');
    const csv = reportCsv(hostile, 'findings');
    expect(csv).toBe('code,severity,ids,message,remediation\nX,warn,a b,"says ""hi"", then\nnewline",\'=cmd|calc\n');
  });

  it('refuses coded: unknown model, no conditions, an unstable model; the document is unchanged', () => {
    const { doc, id } = recordedModel();
    expectRefusal(doc, 'pipe_stress_report', { modelId: 'nope' }, 'PST_MODEL_NOT_FOUND', 'modelId');
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [4000, 0, 3000],
      ],
      DN100.odMm,
    );
    const bare = withModel(pipes, [pipeId]);
    expectRefusal(bare.doc, 'pipe_stress_report', { modelId: bare.id }, 'PST_CONDITIONS_MISSING');
    const unstable = conditioned(bare.doc, bare.id);
    expect(execute(unstable, 'pipe_stress_report', { modelId: bare.id, format: 'csv' }).rejected).toBe(true);
    expect(execute(doc, 'pipe_stress_report', { modelId: id, format: 'pdf' }).error?.code).toBe('CMD_INVALID_PARAMS');
  });
});

/** An anchored L-shaped pipe (two legs of `legMm` along x then y) at `tempC`: the bend carries the expansion stress. */
function lShape(tempC: number, legMm: number): CadDocument {
  const { doc: pipes, id: pipeId } = withPipe(
    baseDoc(),
    [
      [0, 0, 3000],
      [legMm, 0, 3000],
      [legMm, legMm, 3000],
    ],
    DN100.odMm,
  );
  const { doc, id } = withModel(pipes, [pipeId]);
  const anchored = [0, 2 * legMm].reduce(
    (d, at) => apply(d, 'add_stress_restraint', { modelId: id, at: { pipeId, atMm: at }, kind: 'anchor' }),
    conditioned(doc, id, { temperatures: [{ name: 'T1', tempC }] }),
  );
  return apply(anchored, 'set_stress_load_cases', { modelId: id, preset: 'b31.3-default' });
}

describe('render_view overlay "pipe_stress"', () => {
  const render = (doc: CadDocument, params: object = {}): ReturnType<typeof execute> =>
    execute(doc, 'render_view', { view: 'top', showAxes: false, showGrid: false, mode: 'vector', overlay: 'pipe_stress', ...params });
  interface Drawn {
    svg: string;
    overlays?: Record<
      string,
      { entities: string[]; lines: number; points: number; detail?: { models: Record<string, number>[]; skipped: unknown[] } }
    >;
  }
  const dataOf = (result: { data?: unknown }): Drawn => result.data as Drawn;
  const segments = (svg: string): { color: string; ratio: string; element: string }[] =>
    [...svg.matchAll(/<line [^>]*stroke="(#[0-9a-f]{6})" data-element="([^"]*)" data-pipe="[^"]*" data-ratio="([^"]*)"/g)].map((m) => ({
      color: m[1] as string,
      element: m[2] as string,
      ratio: m[3] as string,
    }));

  it('draws every element coloured by its ratio: green when low, red when overstressed; stats count them', () => {
    const { doc, id, pipeId } = recordedModel();
    const low = dataOf(render(doc));
    const drawn = segments(low.svg);
    expect(drawn.length).toBeGreaterThan(0);
    expect(new Set(drawn.map((s) => s.color))).toEqual(new Set(['#35c759']));
    expect(low.overlays?.['pipe_stress']).toMatchObject({ entities: [pipeId], lines: drawn.length, points: 0 });
    expect(low.overlays?.['pipe_stress']?.detail?.models[0]).toMatchObject({
      modelId: id,
      elements: drawn.length,
      ok: drawn.length,
      over: 0,
    });
    const hotData = dataOf(render(lShape(400, 500)));
    const hotSegments = segments(hotData.svg);
    expect(hotSegments.length).toBeGreaterThan(0);
    expect(new Set(hotSegments.map((s) => s.color))).toEqual(new Set(['#ff3b30']));
    expect(Number(hotSegments[0]?.ratio)).toBeGreaterThan(1);
    expect(hotData.overlays?.['pipe_stress']?.detail?.models[0]).toMatchObject({ over: hotSegments.length, ok: 0, status: 'fail' });
    const amber = segments(dataOf(render(lShape(400, 1000))).svg);
    expect(amber.map((s) => s.color)).toContain('#ffb020');
    expect(amber.every((s) => Number(s.ratio) >= 0.8 && Number(s.ratio) <= 1)).toBe(true);
  });

  it('bands: green below 0.8, amber from 0.8 to 1, red above 1, grey without a station', () => {
    expect([bandOf(0.79), bandOf(0.8), bandOf(1), bandOf(1.001), bandOf(null)]).toEqual(['ok', 'warn', 'warn', 'over', 'none']);
  });

  it('lists a model that cannot be analysed as skipped with its code and draws nothing for it; no model draws nothing', () => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [4000, 0, 3000],
      ],
      DN100.odMm,
    );
    const bare = withModel(pipes, [pipeId]);
    const out = dataOf(render(bare.doc));
    expect(segments(out.svg)).toHaveLength(0);
    expect(out.overlays?.['pipe_stress']?.detail?.skipped).toEqual([
      { modelId: bare.id, code: 'PST_CONDITIONS_MISSING', message: expect.any(String) },
    ]);
    const empty = dataOf(render(createEmptyDocument()));
    expect(empty.overlays?.['pipe_stress']).toMatchObject({ entities: [], lines: 0, points: 0 });
  });

  it('isolate limits it to the isolated pipes; perspective says it is not drawn; it combines with the built-in kinds; is read-only', () => {
    const { doc, pipeId } = recordedModel();
    expect(segments(dataOf(render(doc, { isolate: 'someOtherEntity' })).svg)).toHaveLength(0);
    expect(segments(dataOf(render(doc, { isolate: pipeId })).svg).length).toBeGreaterThan(0);
    const perspective = render(doc, { projection: 'perspective', mode: 'raster' });
    expect(perspective.summary).toContain('not drawn: it needs an orthographic view');
    expect(dataOf(perspective).svg).not.toContain('pipe-stress-overlay');
    const both = render(doc, { overlay: ['pipe_stress', 'cage'] });
    expect(Object.keys(dataOf(both).overlays ?? {})).toEqual(['cage', 'pipe_stress']);
    expect(render(doc).document).toBe(doc);
    expectPure(doc, () => render(doc));
  });

  it('the stress plugin registers the kind pipe_stress and the schema accepts it', () => {
    expect(pipeStressOverlay.kind).toBe('pipe_stress');
    expect(pluginRenderOverlays()).toContain(pipeStressOverlay);
    expect(execute(createEmptyDocument(), 'render_view', { overlay: 'wires' }).error?.code).toBe('CMD_INVALID_PARAMS');
  });
});

describe('analyze_pipe_stress include: "geometry"', () => {
  interface Geometry {
    nodes: { id: string; positionMm: number[] }[];
    elements: { id: string; pipeId: string; kind: string; nodeIds: string[]; pointsMm: number[][]; bendRadiusMm: number | null }[];
    pipes: { id: string; kind: string; pointsMm: number[][]; elementIds: string[] }[];
  }
  const geometryOf = (doc: CadDocument, modelId: string): Geometry =>
    (execute(doc, 'analyze_pipe_stress', { modelId, include: ['geometry'] }).data as { geometry: Geometry }).geometry;

  it('a building pipe: node positions are the model nodes, elements reference them, the centreline is the pipe; omitted without include; deterministic', () => {
    const { doc, id, pipeId } = recordedModel();
    const geometry = geometryOf(doc, id);
    expect(geometry.nodes.map((n) => n.id)).toEqual(['N1', 'N2']);
    expect(geometry.nodes.map((n) => n.positionMm)).toEqual([
      [0, 0, 3000],
      [4000, 0, 3000],
    ]);
    expect(geometry.pipes).toEqual([
      {
        id: pipeId,
        kind: 'pipe',
        pointsMm: [
          [0, 0, 3000],
          [4000, 0, 3000],
        ],
        elementIds: geometry.elements.map((e) => e.id),
      },
    ]);
    for (const element of geometry.elements) {
      const byId = new Map(geometry.nodes.map((n) => [n.id, n.positionMm]));
      expect(element.pointsMm).toEqual(element.nodeIds.map((n) => byId.get(n)));
    }
    expect(JSON.stringify(geometryOf(doc, id))).toBe(JSON.stringify(geometry));
    expect((execute(doc, 'analyze_pipe_stress', { modelId: id }).data as { geometry?: unknown }).geometry).toBeUndefined();
  });

  it('an RTE run: the run is a pipe of kind run, its bends are chord elements with a radius, node positions lie on the run centreline ends', () => {
    const s = valveScene();
    const created = execute(s.doc, 'create_stress_model', { name: 'P-1001', lineId: s.line, rule: 'B31.3-2018' });
    const id = (created.data as { modelId: string }).modelId;
    const ready = apply(
      apply(
        anchorAt(anchorAt(conditioned(created.document, id, { wallMm: undefined }), id, s.runId, 0), id, s.runId, 1e6),
        'set_stress_load_cases',
        { modelId: id, cases: [{ name: 'S', type: 'SUS', basic: ['W'] }] },
      ),
      'update_stress_model',
      { modelId: id, maxElementLengthMm: 100000 },
    );
    const geometry = geometryOf(ready, id);
    expect(geometry.pipes).toHaveLength(1);
    expect(geometry.pipes[0]).toMatchObject({ id: s.runId, kind: 'run' });
    const ends = geometry.pipes[0]?.pointsMm ?? [];
    expect(geometry.nodes[0]?.positionMm).toEqual(ends[0]);
    expect(geometry.elements.some((e) => e.kind === 'bend' && typeof e.bendRadiusMm === 'number')).toBe(true);
    expect(geometry.pipes[0]?.elementIds.length).toBe(geometry.elements.length);
    expect(JSON.stringify(geometryOf(ready, id))).toBe(JSON.stringify(geometry));
  });

  it('is refused like the analysis for an unknown model', () => {
    expectRefusal(recordedModel().doc, 'analyze_pipe_stress', { modelId: 'nope', include: ['geometry'] }, 'PST_MODEL_NOT_FOUND');
  });
});
