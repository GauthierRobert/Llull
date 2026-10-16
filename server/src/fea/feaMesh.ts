/**
 * fea_mesh: the analysed solids -> bridge op `mesh` (Gmsh) -> FeMeshArtifact -> store -> `record_fe_mesh`. The server only gathers
 * geometry, forwards the request and records the artifact; target resolution and meshing are the bridge's, summaries are @cae's.
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { GeometryKernel } from '@core/geometry/kernel';
import { isRecord } from '@lib/isRecord';
import type { FeaHost, FeaToolResult } from '@mcp/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeCode, CaeHooks } from './caeHooks';
import { feaFailure, INSTALL_HINT } from './feaCommon';
import { partGeometry } from './feaGeometry';

export interface MeshBridgeResponse {
  readonly ok: boolean;
  readonly code?: string;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface FeaMeshDeps {
  /** Sends one request to the Python bridge; rejects with an Error when the process cannot run. */
  readonly bridge: (request: Record<string, unknown>) => Promise<MeshBridgeResponse>;
  readonly store: FeArtifactStore;
  readonly hooks: CaeHooks;
  readonly kernel: () => GeometryKernel | null;
}

const isCode = (value: object): value is CaeCode => 'code' in value && 'message' in value;

function bridgeFailure(message: string): FeaToolResult {
  const missing = /No module named '?gmsh|cannot start Python|FEA_TOOL_MISSING/.test(message);
  return missing
    ? feaFailure('fea_mesh', 'FEA_TOOL_MISSING', `${message} ${INSTALL_HINT.gmsh}`)
    : feaFailure('fea_mesh', 'FEA_MESH_FAILED', message);
}

function meshArtifact(
  response: MeshBridgeResponse,
  request: { unitSystem: FeMeshArtifact['unitSystem']; inputHash: string },
): FeMeshArtifact | null {
  const { nodes, blocks, nodeSets, faceSets, targets } = response;
  if (!Array.isArray(nodes) || !Array.isArray(blocks) || !isRecord(nodeSets) || !isRecord(faceSets) || !isRecord(targets)) return null;
  return {
    kind: 'fe_mesh',
    unitSystem: request.unitSystem,
    mesher: typeof response['mesher'] === 'string' ? response['mesher'] : 'gmsh',
    mesherVersion: typeof response['mesherVersion'] === 'string' ? response['mesherVersion'] : 'unknown',
    inputHash: request.inputHash,
    nodes: nodes as FeMeshArtifact['nodes'],
    blocks: blocks as FeMeshArtifact['blocks'],
    nodeSets: nodeSets as FeMeshArtifact['nodeSets'],
    faceSets: faceSets as FeMeshArtifact['faceSets'],
    targets: targets as FeMeshArtifact['targets'],
  };
}

/**
 * @failure unknown analysis / no part -> the @cae code; kernel cannot build a part -> FEA_KERNEL_REQUIRED; bridge error -> its code
 *   (FEA_TARGET_UNRESOLVED, FEA_TARGET_AMBIGUOUS, FEA_MESH_FAILED); no gmsh -> FEA_TOOL_MISSING
 */
export async function runFeaMesh(analysisId: string, host: FeaHost, deps: FeaMeshDeps): Promise<FeaToolResult> {
  const doc = host.getDoc();
  const request = deps.hooks.meshRequest(doc, analysisId);
  if (isCode(request)) return feaFailure('fea_mesh', request.code, request.message, [analysisId]);
  const parts: { entityId: string; geometry: unknown }[] = [];
  for (const entityId of request.entityIds) {
    const geometry = partGeometry(doc, entityId, deps.kernel());
    if ('code' in geometry) return feaFailure('fea_mesh', geometry.code, geometry.message, [analysisId, entityId]);
    parts.push({ entityId, geometry });
  }
  let response: MeshBridgeResponse;
  try {
    response = await deps.bridge({
      op: 'mesh',
      lengthScale: request.lengthToAnalysis,
      parts,
      targets: request.targets.map(({ key, entityId, facesNear, edgesNear, pointsNear }) => ({
        key,
        entityId,
        ...(facesNear !== undefined ? { facesNear } : {}),
        ...(edgesNear !== undefined ? { edgesNear } : {}),
        ...(pointsNear !== undefined ? { pointsNear } : {}),
      })),
      controls: {
        order: request.controls.order,
        globalSize: request.controls.globalSize,
        ...(request.controls.minSize !== undefined ? { minSize: request.controls.minSize } : {}),
        refinements: request.controls.refinements.map((refinement, index) => ({ key: `R_${index}`, size: refinement.size })),
      },
    });
  } catch (error) {
    return bridgeFailure(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const message = response.error ?? 'unknown error';
    return response.code === undefined || response.code === 'FEA_TOOL_MISSING' || /No module named/.test(message)
      ? bridgeFailure(message)
      : feaFailure('fea_mesh', response.code, message, [analysisId]);
  }
  const mesh = meshArtifact(response, request);
  if (mesh === null) return feaFailure('fea_mesh', 'FEA_MESH_FAILED', 'the mesher returned a malformed mesh');
  const meshHash = deps.store.put(mesh);
  const recorded = host.applyCommand('record_fe_mesh', { analysisId, summary: deps.hooks.meshSummary(mesh, meshHash) });
  const counts = mesh.blocks.reduce<Record<string, number>>(
    (all, block) => ({ ...all, [block.type]: (all[block.type] ?? 0) + block.elements.length }),
    {},
  );
  return {
    summary: `fea_mesh: ${mesh.nodes.length} nodes, ${Object.entries(counts)
      .map(([type, n]) => `${n} ${type}`)
      .join(', ')} (${mesh.mesher} ${mesh.mesherVersion}). ${recorded.summary}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: { meshHash, nodes: mesh.nodes.length, elements: counts, targets: Object.keys(mesh.nodeSets).length },
  };
}
