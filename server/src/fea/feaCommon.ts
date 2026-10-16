/** Shared helpers of the FE transports: error results, stale-mesh check, the mesh artifact a case points at. */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { FeaToolResult } from '@mcp/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';

export const INSTALL_HINT: Readonly<Record<'gmsh' | 'ccx', string>> = {
  gmsh: 'Install Gmsh for the server Python (`pip install gmsh`); LLULL_GMSH_PYTHON / LLULL_PYTHON name the interpreter.',
  ccx: 'Install CalculiX (`apt install calculix-ccx`, or conda `calculix`); LLULL_CCX names the executable.',
};

export const feaFailure = (tool: string, code: string, message: string, ids: readonly string[] = []): FeaToolResult => ({
  summary: `${tool} ${code}: ${message}`,
  affected: [...ids],
  isError: true,
  data: { code },
});

/** The mesh artifact of a case whose recorded mesh is current, else a failure result. */
export function currentMesh(
  tool: string,
  doc: CadDocument,
  analysisId: string,
  store: FeArtifactStore,
  hooks: CaeHooks,
): { readonly mesh: FeMeshArtifact; readonly meshHash: string } | FeaToolResult {
  const analysisCase = doc.analysis?.cases[analysisId];
  if (analysisCase === undefined) return feaFailure(tool, 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
  const recorded = analysisCase.meshSummary;
  if (recorded === undefined)
    return feaFailure(tool, 'FEA_MESH_MISSING', `analysis '${analysisId}' has no mesh; run fea_mesh first`, [analysisId]);
  if (recorded.inputHash !== hooks.analysisInputHash(doc, analysisId, 'mesh')) {
    return feaFailure(tool, 'FEA_MESH_STALE', `the mesh of '${analysisId}' predates a set-up change; run fea_mesh again`, [analysisId]);
  }
  const mesh = store.get(recorded.meshHash);
  if (mesh === null || mesh.kind !== 'fe_mesh') {
    return feaFailure(
      tool,
      'FEA_ARTIFACT_NOT_FOUND',
      `mesh artifact ${recorded.meshHash.slice(0, 12)} is not in ${store.directory}; run fea_mesh again`,
      [analysisId],
    );
  }
  return { mesh, meshHash: recorded.meshHash };
}

export const isFailure = (value: object): value is FeaToolResult => 'summary' in value;
