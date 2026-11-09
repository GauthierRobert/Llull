/** fea_export format vtu of a pretensioned case through the host transport: the duplicates of the cut are written (PHY-06 M3b), the hook is wired. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseFrd } from '@cae/results/frdReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { createFeArtifactStore, type FeArtifactStore } from '../../../../server/src/fea/artifactStore';
import { caeHooks } from '../../../../server/src/fea/caeHooks';
import { runFeaExport } from '../../../../server/src/fea/feaExport';
import { hashOf } from '../deckFixtures';
import { must } from './support';
import { bolted, boltedMesh, frdBlock, frdSet, sectionParams } from './boltSupport';

let directory = '';
let store: FeArtifactStore;
let doc: CadDocument;
let analysisId = '';

const host = (): FeaHost => ({
  getDoc: () => doc,
  applyCommand: (name, params): FeaToolResult => {
    const result = execute(doc, name, params, { ...defaultContext(), feaArtifacts: store });
    if (result.rejected !== true) doc = result.document;
    return { summary: result.summary, affected: result.affected, isError: result.rejected === true };
  },
});

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-pretension-vtu-'));
  store = createFeArtifactStore(directory);
  const b = bolted();
  analysisId = b.analysisId;
  doc = must(b.doc, 'add_bolt_pretension', sectionParams(b)).doc;
  const mesh = boltedMesh(b, doc);
  const values: Record<number, number[]> = {};
  for (const [id, , , z] of mesh.nodes) values[id] = [0, 0, 0.001 * z];
  for (const copy of [29, 30, 31, 32]) values[copy] = [0, 0, 0.0025];
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(doc, analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: parseFrd(frdSet(1, 1, [frdBlock('DISP', ['D1', 'D2', 'D3'], values)])),
  };
  const meshHash = store.put(mesh);
  const resultsHash = store.put(results);
  const meshed = host().applyCommand('record_fe_mesh', { analysisId, summary: meshSummary(mesh, meshHash) });
  if (meshed.isError) throw new Error(meshed.summary);
  const recorded = host().applyCommand('record_fea_results', {
    analysisId,
    summary: resultsSummary(doc, analysisId, mesh, results, resultsHash),
  });
  if (recorded.isError) throw new Error(recorded.summary);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('fea_export vtu of a pretensioned case', () => {
  it('writes the 4 duplicate nodes as extra points with their own displacement (32 points, 30 cells)', () => {
    const exported = runFeaExport(analysisId, host(), { store, hooks: caeHooks }, { format: 'vtu' });
    expect(exported.isError, exported.summary).toBe(false);
    const text = isRecord(exported.data) ? String(exported.data['text']) : '';
    expect(text).toContain('NumberOfPoints="32"');
    expect(exported.data).toMatchObject({ cells: 30, droppedElements: 0, withResults: true });
    const displacement = (/Name="U_1"[^>]*>([^<]*)</.exec(text)?.[1] ?? '').trim().split(/\s+/).map(Number);
    expect(displacement[28 * 3 + 2]).toBeCloseTo(0.0025, 12);
    expect(displacement[8 * 3 + 2]).toBeCloseTo(0.002, 12);
  });
});
