/**
 * fea_mesh: the analysed solids -> mesher (llull-mesh, or the Python bridge op `mesh`; both Gmsh) -> FeMeshArtifact -> store -> `record_fe_mesh`. The server only gathers
 * geometry, forwards the request and records the artifact; target resolution and meshing are the bridge's, summaries are @cae's.
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { GeometryKernel } from '@core/geometry/kernel';
import { isRecord } from '@lib/isRecord';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeCode, CaeHooks } from './caeHooks';
import { feaFailure, INSTALL_HINT } from './feaCommon';
import { partFaces } from './faceRefs';
import { partGeometry } from './feaGeometry';

export interface MeshBridgeResponse {
  readonly ok: boolean;
  readonly code?: string;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface FeaMeshDeps {
  /** Sends one request to the mesher (nativeMesher.ts); rejects with an Error when the process cannot run. */
  readonly bridge: (request: Record<string, unknown>) => Promise<MeshBridgeResponse>;
  readonly store: FeArtifactStore;
  readonly hooks: CaeHooks;
  readonly kernel: () => GeometryKernel | null;
}

const isCode = (value: object): value is CaeCode => 'code' in value && 'message' in value;

function bridgeFailure(message: string): FeaToolResult {
  const missing = /No module named '?gmsh|cannot start Python|FEA_TOOL_MISSING|Gmsh library was not found/.test(message);
  return missing
    ? feaFailure('fea_mesh', 'FEA_TOOL_MISSING', `${message} ${INSTALL_HINT.gmsh}`)
    : feaFailure('fea_mesh', 'FEA_MESH_FAILED', message);
}

/** The `faceMap` entries of a bridge response that have the expected shape (anything else is dropped). */
function faceMapOf(value: unknown): NonNullable<FeMeshArtifact['faceMap']> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) =>
    isRecord(entry) &&
    typeof entry['entityId'] === 'string' &&
    typeof entry['faceIndex'] === 'number' &&
    typeof entry['tag'] === 'number' &&
    typeof entry['residual'] === 'number'
      ? [{ entityId: entry['entityId'], faceIndex: entry['faceIndex'], tag: entry['tag'], residual: entry['residual'] }]
      : [],
  );
}

function meshArtifact(
  response: MeshBridgeResponse,
  request: { unitSystem: FeMeshArtifact['unitSystem']; inputHash: string },
  facetedParts: readonly string[],
): FeMeshArtifact | null {
  const faceMap = faceMapOf(response['faceMap']);
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
    ...(facetedParts.length > 0 ? { facetedParts } : {}),
    ...(faceMap.length > 0 ? { faceMap } : {}),
  };
}

/** `faceIndices`: the kernel face of every `facesNear` point, only when ALL of them resolve (else the mesher resolves the target by the nearest surface). */
function faceIndicesOf(
  faces: ReturnType<typeof partFaces> | undefined,
  facesNear: readonly (readonly [number, number, number])[] | undefined,
): { faceIndices?: number[] } {
  if (faces === null || faces === undefined || facesNear === undefined || facesNear.length === 0) return {};
  const found = faces.nearest(facesNear);
  return found.every((index) => index !== null) ? { faceIndices: [...new Set(found as number[])] } : {};
}

/**
 * @failure unknown analysis / no part -> the @cae code; kernel cannot build a part -> FEA_KERNEL_REQUIRED; bridge error -> its code
 *   (FEA_TARGET_UNRESOLVED, FEA_TARGET_AMBIGUOUS, FEA_MESH_FAILED); no gmsh -> FEA_TOOL_MISSING
 */
export async function runFeaMesh(analysisId: string, host: FeaHost, deps: FeaMeshDeps): Promise<FeaToolResult> {
  const doc = host.getDoc();
  const request = deps.hooks.meshRequest(doc, analysisId);
  if (isCode(request)) return feaFailure('fea_mesh', request.code, request.message, [analysisId]);
  const parts: { entityId: string; geometry: unknown; faces?: unknown; defeature?: unknown }[] = [];
  const kernelFaces = new Map<string, ReturnType<typeof partFaces>>();
  const defeature = doc.analysis?.cases[analysisId]?.defeature ?? {};
  const warnings: string[] = [];
  for (const entityId of request.entityIds) {
    const midsurface = deps.hooks.partMidsurface(doc, analysisId, entityId, deps.kernel());
    if (midsurface !== null && 'code' in midsurface)
      return feaFailure('fea_mesh', midsurface.code, midsurface.message, [analysisId, entityId]);
    if (midsurface !== null) {
      warnings.push(...midsurface.warnings.map((warning) => `${entityId}: ${warning}`));
      parts.push({ entityId, geometry: midsurface });
      kernelFaces.set(entityId, null);
      continue;
    }
    const geometry = partGeometry(doc, entityId, deps.kernel());
    if ('code' in geometry) return feaFailure('fea_mesh', geometry.code, geometry.message, [analysisId, entityId]);
    const faces = geometry.kind === 'step' && request.controls.bonding === undefined ? partFaces(doc, entityId, deps.kernel()) : null;
    kernelFaces.set(entityId, faces);
    const removed = Object.hasOwn(defeature, entityId) ? defeature[entityId] : undefined;
    parts.push({
      entityId,
      geometry,
      ...(faces === null ? {} : { faces: faces.faces }),
      ...(removed === undefined ? {} : { defeature: removed }),
    });
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
        ...faceIndicesOf(kernelFaces.get(entityId ?? ''), facesNear),
        ...(edgesNear !== undefined ? { edgesNear } : {}),
        ...(pointsNear !== undefined ? { pointsNear } : {}),
      })),
      controls: {
        order: request.controls.order,
        elementFamily: request.controls.elementFamily,
        ...(request.controls.bonding !== undefined ? { bonding: request.controls.bonding } : {}),
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
  const faceted = parts
    .filter(
      (part) =>
        (part.geometry as { kind?: string; curved?: boolean }).kind === 'stl' && (part.geometry as { curved?: boolean }).curved === true,
    )
    .map((part) => part.entityId);
  const mesh = meshArtifact(response, request, faceted);
  if (mesh === null) return feaFailure('fea_mesh', 'FEA_MESH_FAILED', 'the mesher returned a malformed mesh');
  const meshHash = deps.store.put(mesh);
  const recorded = host.applyCommand('record_fe_mesh', { analysisId, summary: deps.hooks.meshSummary(mesh, meshHash) });
  const facetedNote =
    faceted.length === 0
      ? ''
      : ` WARNING: ${faceted.join(', ')} meshed from a faceted tessellation (no exact B-rep with this kernel): curved faces are polygons, ` +
        'so stresses at curved features are off by several % (either sign) and facesNear targets snap to facets; for stress results re-run ' +
        'with the OCC kernel (--kernel occt-native or LLULL_KERNEL=occt-native).';
  const counts = mesh.blocks.reduce<Record<string, number>>(
    (all, block) => ({ ...all, [block.type]: (all[block.type] ?? 0) + block.elements.length }),
    {},
  );
  return {
    summary: `fea_mesh: ${mesh.nodes.length} nodes, ${Object.entries(counts)
      .map(([type, n]) => `${n} ${type}`)
      .join(
        ', ',
      )} (${mesh.mesher} ${mesh.mesherVersion}). ${recorded.summary}${facetedNote}${warnings.length > 0 ? ` WARNING: ${warnings.join('; ')}` : ''}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: {
      meshHash,
      nodes: mesh.nodes.length,
      elements: counts,
      targets: Object.keys(mesh.nodeSets).length,
      facetedParts: faceted,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(Array.isArray(response['defeatured']) ? { defeatured: response['defeatured'] } : {}),
    },
  };
}
