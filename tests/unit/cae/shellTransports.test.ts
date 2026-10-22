/** M6 transports (no Gmsh / ccx here: fake mesher): fea_mesh sends midsurface geometry for shells, defeature specs for solids, refuses midsurface problems. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { createFeArtifactStore } from '../../../server/src/fea/artifactStore';
import { caeHooks } from '../../../server/src/fea/caeHooks';
import { runFeaMesh, type MesherResponse } from '../../../server/src/fea/feaMesh';
import { must, plateDocument } from './shellFixtures';

const directory = mkdtempSync(path.join(tmpdir(), 'llull-shellmesh-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function meshWith(
  doc: CadDocument,
  analysisId: string,
  extra: Record<string, unknown> = {},
): Promise<{ request: Record<string, unknown>; summary: string; data: unknown }> {
  let request: Record<string, unknown> = {};
  const mesher = (sent: Record<string, unknown>): Promise<MesherResponse> => {
    request = sent;
    return Promise.resolve({
      ok: true,
      mesher: 'gmsh',
      mesherVersion: '4',
      nodes: [],
      blocks: [],
      nodeSets: {},
      faceSets: {},
      targets: {},
      ...extra,
    });
  };
  const host = { getDoc: () => doc, applyCommand: () => ({ summary: 'recorded', affected: [], isError: false }) };
  const store = createFeArtifactStore(mkdtempSync(path.join(directory, 's-')));
  const kernel = { evaluate: () => ({}), exportStep: () => 'ISO-10303-21;', tessellate: () => null } as unknown as GeometryKernel;
  const result = await runFeaMesh(analysisId, host, { mesher, store, hooks: caeHooks, kernel: () => kernel });
  return { request, summary: result.summary, data: result.data };
}

describe('fea_mesh for 2D parts', () => {
  it('sends the midsurface faces, thickness and element family of a shell part', async () => {
    const plate = plateDocument();
    let doc = must(plate.doc, 'set_part_idealization', { analysisId: plate.analysisId, entityId: plate.plateId, idealization: 'shell' });
    doc = must(doc, 'set_mesh_controls', { analysisId: plate.analysisId, elementFamily: 'shell_quad', globalSize: 10 });
    const { request } = await meshWith(doc, plate.analysisId);
    const part = (request['parts'] as { geometry: Record<string, unknown> }[])[0];
    expect(part?.geometry).toMatchObject({ kind: 'midsurface', element: 'shell', thickness: 2, faces: [{ normal: [0, 0, 1] }] });
    expect(request['controls']).toMatchObject({ elementFamily: 'shell_quad' });
  });

  it('sends a defeature spec with a solid part and reports removed faces', async () => {
    const plate = plateDocument();
    let doc = must(plate.doc, 'set_part_idealization', { analysisId: plate.analysisId, entityId: plate.plateId });
    doc = must(doc, 'defeature_for_analysis', { analysisId: plate.analysisId, entityId: plate.plateId, maxFeatureSize: 1 });
    const { request, data } = await meshWith(doc, plate.analysisId, { defeatured: [{ entityId: plate.plateId, faces: [7] }] });
    expect((request['parts'] as { defeature?: unknown }[])[0]?.defeature).toEqual({ maxFeatureSize: 1 });
    expect(data).toMatchObject({ defeatured: [{ entityId: plate.plateId, faces: [7] }] });
  });

  it('passes midsurface warnings and refuses a part whose midsurface fails at mesh time', async () => {
    const plate = plateDocument();
    const doc = must(plate.doc, 'set_part_idealization', { analysisId: plate.analysisId, entityId: plate.plateId, idealization: 'shell' });
    const shrunk: CadDocument = {
      ...doc,
      entities: {
        ...doc.entities,
        [plate.plateId]: { ...doc.entities[plate.plateId], size: [100, 50, 20] } as CadDocument['entities'][string],
      },
    };
    const refused = await meshWith(shrunk, plate.analysisId);
    expect(refused.summary).toContain('FEA_MIDSURFACE_NOT_THIN');
  });
});
