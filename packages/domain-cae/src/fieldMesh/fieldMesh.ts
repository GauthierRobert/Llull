/**
 * FE meshes of implicit bodies straight from their field (14 FLL-M1, FR-FLL-05): the request of one llull-field `tets` job per part, the
 * quality gate and the assembly of the per-part results into the one FeMeshArtifact every deck writer reads (same shape as a Netgen mesh).
 * The host runs the jobs; everything that decides lives here.
 * @invariant node and element ids are 1..n over the parts in request order, each part's nodes then elements in job order: same job outputs,
 *   same artifact (and the same meshHash)
 * @invariant a mesh below the dihedral bounds, or with a folded, non-manifold or degenerate element, is refused (FLL_IMPLICIT_MESH_QUALITY)
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import { isRecord } from '@lib/isRecord';
import type { MeshRequest } from '../hash/meshRequest';

/** Named budgets of one part job: lattice vertices (checked before the field is evaluated) and tetrahedra (checked while stuffing). */
export const FIELD_MESH_LIMITS = { maxLatticeVertices: 2 ** 26, maxTets: 2e6 } as const;
/** Dihedral bounds of isosurface stuffing with warping on a BCC lattice, Labelle & Shewchuk 2007 [R9] (TECHNICAL_SPEC FLL-D1). */
const FIELD_MESH_DIHEDRAL_DEG = { min: 10.7832, max: 164.817 } as const;
/** Padding of the lattice around the body bounds, in lattice spacings (the outermost layer is held outside). */
export const FIELD_MESH_PAD = 2;

export interface CaeFailure {
  readonly code: string;
  readonly message: string;
}

/** The `targets` of the job of `entityId`: its own targets, plus every probe target (no entity) as a nearest-node query. */
export function fieldJobTargets(request: MeshRequest, entityId: string): Record<string, unknown>[] | CaeFailure {
  const out: Record<string, unknown>[] = [];
  for (const target of request.targets) {
    if (target.intersectPlane !== undefined)
      return {
        code: 'FEA_TARGET_UNRESOLVED',
        message: `target ${target.key}: a plane intersection needs the geometry mesher (source geometry)`,
      };
    if (target.entityId === null) {
      out.push({ key: target.key, global: true, pointsNear: target.pointsNear ?? [] });
      continue;
    }
    if (!request.entityIds.includes(target.entityId))
      return { code: 'FEA_TARGET_UNRESOLVED', message: `target ${target.key}: entity '${target.entityId}' is not a meshed part` };
    if (target.entityId !== entityId) continue;
    out.push({
      key: target.key,
      ...(target.facesNear !== undefined ? { facesNear: target.facesNear } : {}),
      ...(target.pointsNear !== undefined ? { pointsNear: target.pointsNear } : {}),
      ...(target.edgesNear !== undefined ? { edgesNear: target.edgesNear } : {}),
    });
  }
  return out;
}

/** What one part job produced: the node / element files and its report.json. */
export interface FieldPartMesh {
  readonly entityId: string;
  /** x y z per node, analysis length unit. */
  readonly nodes: Float64Array;
  /** 4 (C3D4) or 10 (C3D10) 0-based node indices per element. */
  readonly elements: Uint32Array;
  readonly report: Readonly<Record<string, unknown>>;
}

/** Per-part figures for the summary. */
export interface FieldPartFigures {
  readonly entityId: string;
  readonly nodes: number;
  readonly elements: number;
  /** Document units^3 (the exact integral of det J of the elements). */
  readonly volume: number;
  readonly minDihedralDeg: number;
  readonly maxDihedralDeg: number;
  readonly curvedMidNodes: number;
  readonly warpedVertices: number;
  readonly steinerVertices: number;
  readonly clippedCorners: number;
}

const num = (value: unknown): number => (typeof value === 'number' ? value : NaN);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

function figuresOf(part: FieldPartMesh): FieldPartFigures {
  const quality = record(part.report['quality']);
  return {
    entityId: part.entityId,
    nodes: num(part.report['nodes']),
    elements: num(part.report['elements']),
    volume: num(part.report['volume']),
    minDihedralDeg: num(quality['minDihedralDeg']),
    maxDihedralDeg: num(quality['maxDihedralDeg']),
    curvedMidNodes: num(part.report['curvedMidNodes']),
    warpedVertices: num(part.report['warpedVertices']),
    steinerVertices: num(part.report['steinerVertices']),
    clippedCorners: num(part.report['clippedCorners']),
  };
}

/** The quality refusal of one part, or null. */
export function fieldMeshQualityProblem(part: FieldPartMesh, globalSize: number): CaeFailure | null {
  const quality = record(part.report['quality']);
  const [min, max] = [num(quality['minDihedralDeg']), num(quality['maxDihedralDeg'])];
  const invalid = num(quality['folded']) + num(quality['nonManifold']) + num(quality['degenerate']);
  const problems = [
    ...(invalid !== 0 ? [`${invalid} folded / non-manifold / degenerate element(s)`] : []),
    ...(!(min >= FIELD_MESH_DIHEDRAL_DEG.min) ? [`min dihedral ${min.toFixed(2)} deg below ${FIELD_MESH_DIHEDRAL_DEG.min}`] : []),
    ...(!(max <= FIELD_MESH_DIHEDRAL_DEG.max) ? [`max dihedral ${max.toFixed(2)} deg above ${FIELD_MESH_DIHEDRAL_DEG.max}`] : []),
  ];
  if (problems.length === 0) return null;
  return {
    code: 'FLL_IMPLICIT_MESH_QUALITY',
    message:
      `'${part.entityId}' meshed from its field: ${problems.join('; ')} (bounds of isosurface stuffing [R9]). Features thinner than about ` +
      `two lattice spacings cause this: lower globalSize (now ${globalSize}) with set_mesh_controls, or thicken the field.`,
  };
}

const sortedNumbers = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/**
 * The mesh artifact of `parts` (in `request.entityIds` order) and the figures of each part.
 * @failure a part below the quality bounds -> FLL_IMPLICIT_MESH_QUALITY; a malformed job output -> FEA_MESH_FAILED; a target that resolved to
 *   no node -> FEA_TARGET_UNRESOLVED
 */
export function assembleFieldMesh(
  request: MeshRequest,
  parts: readonly FieldPartMesh[],
  mesherVersion: string,
): { readonly artifact: FeMeshArtifact; readonly figures: readonly FieldPartFigures[] } | CaeFailure {
  const nodes: (readonly [number, number, number, number])[] = [];
  const blocks: FeMeshArtifact['blocks'][number][] = [];
  const nodeSets: Record<string, number[]> = {};
  const faceSets: Record<string, (readonly [number, number])[]> = {};
  const targets: Record<string, { readonly residual: number }> = {};
  const nearest = new Map<string, { node: number; distance: number }>();
  let elementBase = 0;
  for (const part of parts) {
    const quality = fieldMeshQualityProblem(part, request.controls.globalSize);
    if (quality !== null) return quality;
    const perElement = request.controls.order === 2 ? 10 : 4;
    const count = part.nodes.length / 3;
    const nodeBase = nodes.length;
    if (!Number.isInteger(count) || part.elements.length % perElement !== 0 || part.elements.some((v) => v >= count))
      return { code: 'FEA_MESH_FAILED', message: `the field mesh of '${part.entityId}' is malformed (node or element file)` };
    for (let n = 0; n < count; n += 1)
      nodes.push([nodeBase + n + 1, part.nodes[3 * n] ?? NaN, part.nodes[3 * n + 1] ?? NaN, part.nodes[3 * n + 2] ?? NaN]);
    const elements: number[][] = [];
    for (let e = 0; e < part.elements.length / perElement; e += 1) {
      const row = [elementBase + e + 1];
      for (let k = 0; k < perElement; k += 1) row.push(nodeBase + (part.elements[e * perElement + k] ?? 0) + 1);
      elements.push(row);
    }
    blocks.push({ type: perElement === 10 ? 'C3D10' : 'C3D4', entityId: part.entityId, elements });
    for (const [key, raw] of Object.entries(record(part.report['sets']))) {
      const set = record(raw);
      const setNodes = Array.isArray(set['nodes']) ? set['nodes'].map((v) => nodeBase + num(v) + 1) : [];
      const setFaces = Array.isArray(set['faces'])
        ? set['faces'].map((f) => [elementBase + num(Array.isArray(f) ? f[0] : NaN) + 1, num(Array.isArray(f) ? f[1] : NaN)] as const)
        : [];
      if (setNodes.length === 0)
        return { code: 'FEA_TARGET_UNRESOLVED', message: `target ${key} resolved to no node of '${part.entityId}'` };
      nodeSets[key] = sortedNumbers(setNodes);
      if (setFaces.length > 0) faceSets[key] = setFaces;
      targets[key] = { residual: num(set['residual']) };
    }
    for (const [key, raw] of Object.entries(record(part.report['nearest']))) {
      const hit = record(raw);
      const distance = num(hit['distance']);
      const known = nearest.get(key);
      if (Number.isFinite(distance) && (known === undefined || distance < known.distance))
        nearest.set(key, { node: nodeBase + num(hit['node']) + 1, distance });
    }
    elementBase += elements.length;
  }
  for (const target of request.targets) {
    if (target.entityId !== null) continue;
    const hit = nearest.get(target.key);
    if (hit === undefined) return { code: 'FEA_TARGET_UNRESOLVED', message: `target ${target.key}: no mesh node found` };
    nodeSets[target.key] = [hit.node];
    targets[target.key] = { residual: hit.distance };
  }
  const missing = request.targets.find((target) => targets[target.key] === undefined);
  if (missing !== undefined) return { code: 'FEA_TARGET_UNRESOLVED', message: `target ${missing.key} resolved to no mesh node` };
  return {
    artifact: {
      kind: 'fe_mesh',
      unitSystem: request.unitSystem,
      mesher: 'llull-field',
      mesherVersion,
      inputHash: request.inputHash,
      nodes,
      blocks,
      nodeSets,
      faceSets,
      targets,
    },
    figures: parts.map(figuresOf),
  };
}
