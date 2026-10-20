/** fea_export (inp / bdf / vtu) and fea_import_results (frd / op2) transports against a real document and an on-disk artifact store; no solver needed. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { uint8ArrayToBase64 } from '@lib/base64';
import { applyExchangeToolCall, type FeaHost, type FeaToolResult, type FeaToolsPort } from '@protocol/index';
import { createFeArtifactStore, type FeArtifactStore } from '../../../server/src/fea/artifactStore';
import { caeHooks } from '../../../server/src/fea/caeHooks';
import { runFeaExport } from '../../../server/src/fea/feaExport';
import { runFeaImportResults } from '../../../server/src/fea/feaImportResults';
import { meshSummary } from '@cae/results/summary';
import { X0_NODES, barDocument, barMesh } from './deckFixtures';
import { Op2Builder, displacementRow, tetStressElement } from './op2Fixture';

let directory = '';
let store: FeArtifactStore;
let doc: CadDocument;
let analysisId = '';
let mesh: ReturnType<typeof barMesh>;
let meshHash = '';

const host = (): FeaHost => ({
  getDoc: () => doc,
  applyCommand: (name, params): FeaToolResult => {
    const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
    if (result.rejected !== true) doc = result.document;
    return { summary: result.summary, affected: result.affected, isError: result.rejected === true };
  },
});
const deps = (): { store: FeArtifactStore; hooks: typeof caeHooks } => ({ store, hooks: caeHooks });

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-fea-transports-'));
  store = createFeArtifactStore(directory);
  const bar = barDocument();
  analysisId = bar.analysisId;
  mesh = barMesh(bar.doc, bar.analysisId, bar.boxId, {
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
  });
  meshHash = store.put(mesh);
  doc = bar.doc;
  const recorded = host().applyCommand('record_fe_mesh', { analysisId, summary: meshSummary(mesh, meshHash) });
  if (recorded.isError) throw new Error(recorded.summary);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const op2Bytes = (): Uint8Array => {
  const builder = new Op2Builder();
  builder.table('OUGV1', [
    {
      approach: 11,
      tableCode: 1,
      subcase: 1,
      numWide: 8,
      data: mesh.nodes.flatMap(([id, x]) => displacementRow(id, [0.001 * x, 0, 0, 0, 0, 0])),
    },
  ]);
  builder.table('OES1X1', [
    {
      approach: 11,
      tableCode: 5,
      elementType: 39,
      subcase: 1,
      numWide: 109,
      data: (mesh.blocks[0]?.elements ?? []).flatMap((element) =>
        tetStressElement(element[0] ?? 0, element.slice(1), [105, 0, 0, 0, 0, 0]),
      ),
    },
  ]);
  return builder.build();
};

describe('fea_export formats', () => {
  it('calculix_inp stays the default and keeps its data keys', () => {
    const result = runFeaExport(analysisId, host(), deps());
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ format: 'inp', fileName: `${analysisId}.inp`, meshHash });
    expect(String(result.data?.['text'])).toContain('*STEP');
  });

  it('nastran_bdf writes the bulk data with its warnings and a sha256', () => {
    const result = runFeaExport(analysisId, host(), deps(), { format: 'nastran_bdf' });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ format: 'bdf', fileName: `${analysisId}.bdf`, warnings: [] });
    expect(String(result.data?.['text'])).toContain('SOL 101');
    expect(result.summary).toContain('.bdf');
  });

  it('vtu is mesh only until results are recorded, then carries them; base64 arrays are binary', () => {
    const before = runFeaExport(analysisId, host(), deps(), { format: 'vtu' });
    expect(before.data).toMatchObject({ format: 'vtu', withResults: false, cells: 6 });
    expect(before.summary).toContain('mesh only');
    const imported = runFeaImportResults(analysisId, { format: 'op2', bytes: op2Bytes() }, host(), deps());
    expect(imported.isError).toBe(false);
    const after = runFeaExport(analysisId, host(), deps(), { format: 'vtu' });
    expect(after.data).toMatchObject({ withResults: true });
    expect(String(after.data?.['text'])).toContain('Name="von_mises_1"');
    const binary = runFeaExport(analysisId, host(), deps(), { format: 'vtu', encoding: 'base64' });
    expect(String(binary.data?.['text'])).toContain('format="binary"');
  });

  it('refuses an unknown analysis and a deck the writer cannot write', () => {
    expect(runFeaExport('nope', host(), deps(), { format: 'nastran_bdf' })).toMatchObject({ isError: true });
    const thermal = execute(doc, 'create_analysis', { name: 't', analysisType: 'heat_steady' });
    const thermalId = thermal.affected[0] ?? '';
    const withMesh = { ...thermal.document };
    const refused = runFeaExport(
      thermalId,
      { getDoc: () => withMesh, applyCommand: () => ({ summary: '', affected: [], isError: false }) },
      deps(),
      { format: 'nastran_bdf' },
    );
    expect(refused.isError).toBe(true);
  });
});

describe('fea_import_results', () => {
  it('records an OP2 of the current mesh through record_fea_results; fea_report reads it as solved', () => {
    const imported = runFeaImportResults(analysisId, { format: 'op2', bytes: op2Bytes() }, host(), deps());
    expect(imported).toMatchObject({ isError: false, data: { format: 'op2', steps: 1, solver: 'nastran' } });
    expect(imported.summary).toContain('record_fea_results');
    const report = execute(doc, 'fea_report', { analysisId }, { ...defaultContext(), feaArtifacts: store });
    expect((report.data as { state: string }).state).toBe('solved');
    expect(report.summary).toContain('105');
  });

  it('records a CalculiX FRD the same way and refuses an FRD of another mesh', () => {
    const frd = (nodes: readonly number[]): Uint8Array => {
      const lines = [
        ' 1PSTEP                         1           1           1',
        '  100CL  101 0.10000E+01                 4                     1           1'.replace('100CL  101', '100CL  101'),
        ' -4  DISP        4    1',
        ' -5  D1          1    2    1    0',
        ' -5  D2          1    2    2    0',
        ' -5  D3          1    2    3    0',
        ' -5  ALL         1    2    0    0    1ALL',
      ];
      for (const node of nodes)
        lines.push(
          ` -1${String(node).padStart(10)}${(0.001 * node).toExponential(5).toUpperCase().padStart(12)}${'0.00000E+00'.padStart(12)}${'0.00000E+00'.padStart(12)}`,
        );
      lines.push(' -3');
      return new TextEncoder().encode(`${lines.join('\n')}\n`);
    };
    const all = mesh.nodes.map((node) => node[0]);
    const ok = runFeaImportResults(analysisId, { format: 'frd', bytes: frd(all) }, host(), deps());
    expect(ok.isError).toBe(false);
    expect(ok.data).toMatchObject({ solver: 'calculix' });
    expect(runFeaImportResults(analysisId, { format: 'frd', bytes: frd(all.slice(1)) }, host(), deps()).summary).toContain(
      'FEA_RESULTS_MESH_MISMATCH',
    );
    expect(runFeaImportResults(analysisId, { format: 'frd', bytes: frd([...all, 99]) }, host(), deps()).summary).toContain('node 99');
    expect(
      runFeaImportResults(analysisId, { format: 'frd', bytes: new TextEncoder().encode('nothing') }, host(), deps()).summary,
    ).toContain('FEA_RESULTS_EMPTY');
    const infinite = new TextEncoder().encode(
      [
        ' 1PSTEP                         1           1           1',
        ' 100CL  101 0.10000E+01                 4                     1           1',
        ' -4  DISP        4    1',
        ' -5  D1          1    2    1    0',
        ' -1         1',
      ].join('\n'),
    );
    expect(runFeaImportResults(analysisId, { format: 'frd', bytes: infinite }, host(), deps()).summary).toContain('FEA_SOLVER_FAILED');
  });

  it('refuses what is not an OP2, an OP2 of another mesh, a missing / stale mesh and an unknown analysis', () => {
    expect(
      runFeaImportResults(analysisId, { format: 'op2', bytes: new TextEncoder().encode('not an op2 at all!') }, host(), deps()).summary,
    ).toContain('FEA_OP2_INVALID');
    const builder = new Op2Builder();
    builder.table('OUGV1', [
      {
        approach: 11,
        tableCode: 1,
        subcase: 1,
        numWide: 8,
        data: mesh.nodes.slice(1).flatMap(([id]) => displacementRow(id, [0, 0, 0, 0, 0, 0])),
      },
    ]);
    expect(runFeaImportResults(analysisId, { format: 'op2', bytes: builder.build() }, host(), deps()).summary).toContain(
      'FEA_OP2_MESH_MISMATCH',
    );
    expect(runFeaImportResults('nope', { format: 'op2', bytes: op2Bytes() }, host(), deps()).isError).toBe(true);
    const stale = host().applyCommand('set_mesh_controls', { analysisId, globalSize: 0.5 });
    expect(stale.isError).toBe(false);
    expect(runFeaImportResults(analysisId, { format: 'op2', bytes: op2Bytes() }, host(), deps()).summary).toContain('FEA_MESH_STALE');
  });
});

describe('the protocol tools', () => {
  const calls: string[] = [];
  const port = (): FeaToolsPort => ({
    mesh: () => Promise.reject(new Error('unused')),
    solve: () => Promise.reject(new Error('unused')),
    exportDeck: (id, _host, options) => {
      calls.push(`export ${id} ${options?.format ?? 'default'} ${options?.encoding ?? '-'}`);
      return Promise.resolve({ summary: 'ok', affected: [], isError: false });
    },
    importField: () => Promise.reject(new Error('unused')),
    importResults: (id, file) => {
      calls.push(`import ${id} ${file.format} ${file.bytes.byteLength}`);
      return Promise.resolve({ summary: 'ok', affected: [], isError: false });
    },
  });
  const run = async (name: string, args: unknown, extra: Record<string, unknown> = {}): Promise<string> => {
    const result = await applyExchangeToolCall(name, args, {
      getDoc: () => doc,
      applyCommand: () => ({ summary: '', affected: [], isError: false }),
      fea: port(),
      ...extra,
    });
    return JSON.stringify(result);
  };

  it('fea_export passes format and encoding and refuses an unknown format', async () => {
    await run('fea_export', { analysisId: 'an', format: 'vtu', encoding: 'base64' });
    await run('fea_export', { analysisId: 'an', format: 'nastran_bdf' });
    await run('fea_export', { analysisId: 'an' });
    expect(calls).toEqual(['export an vtu base64', 'export an nastran_bdf -', 'export an default -']);
    expect(await run('fea_export', { analysisId: 'an', format: 'step' })).toContain('format must be one of');
  });

  it('fea_import_results decodes dataBase64, reads path from the exchange directory, and names missing parameters', async () => {
    calls.length = 0;
    const bytes = new Uint8Array([4, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0]);
    await run('fea_import_results', { analysisId: 'an', format: 'op2', dataBase64: uint8ArrayToBase64(bytes) });
    await run(
      'fea_import_results',
      { analysisId: 'an', format: 'frd', path: 'r.frd' },
      { port: { readExchangeFile: () => Promise.resolve(uint8ArrayToBase64(bytes)) } },
    );
    expect(calls).toEqual(['import an op2 12', 'import an frd 12']);
    expect(await run('fea_import_results', { analysisId: 'an', format: 'xml', dataBase64: 'AA==' })).toContain('format must be one of');
    expect(await run('fea_import_results', { analysisId: 'an', format: 'op2' })).toContain('provide dataBase64');
    expect(await run('fea_import_results', { analysisId: 'an', format: 'op2', path: 'r.op2' })).toContain('path is unavailable');
    expect(await run('fea_import_results', { analysisId: 'an', format: 'op2', dataBase64: '***' })).toContain('not valid base64');
  });
});
