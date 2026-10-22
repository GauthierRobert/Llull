/**
 * Compliance ratio of a rebuilt solid (TR-TOP-10): F^T u from its current 05 results artifact over the compliance of the optimum. The external work
 * is rebuilt load by load: nodal forces x nodal displacements, pressure x face area x the mean face displacement along the inward normal (linear
 * tetrahedron faces, outward normal away from the opposite corner), gravity as density x element volume x the mean element displacement along the
 * acceleration (linear tetrahedra). All of them are exact for linear shape functions.
 */

import type { AnalysisCase, FeaLoad, FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { TopologyStudy } from '@core/model/topology';
import type { CadDocument, Vec3 } from '@core/model/types';
import { cross3, dot3, len3, sub3 } from '@lib/vec3';
import { TET_FACES } from '../decks/loadDistribution';
import { densityToAnalysis, unitSystemFactors } from '../decks/units';
import { loadCasesOf } from '../decks/context';
import { analysisOf } from '../shared/access';
import { trustedRecord } from '../shared/trust';
import { stepOfLoadCase } from '../results/fields';

export interface RebuildCompliance {
  readonly available: true;
  /** Id of the 05 analysis of the rebuilt solid. */
  readonly analysisId: string;
  /** Weighted F^T u of the rebuild and the compliance of the optimum, both in N*mm. */
  readonly rebuildNmm: number;
  readonly optimumNmm: number;
  readonly ratio: number;
}

export interface ComplianceUnavailable {
  readonly available: false;
  readonly code: 'TOP_REBUILD_NOT_ANALYSED';
  readonly reason: 'no_analysis' | 'not_solved' | 'stale' | 'unverified' | 'unsupported' | 'optimum_zero';
  readonly message: string;
}

const unavailable = (reason: ComplianceUnavailable['reason'], message: string): ComplianceUnavailable => ({
  available: false,
  code: 'TOP_REBUILD_NOT_ANALYSED',
  reason,
  message,
});

type Displacement = Readonly<Record<string, readonly number[]>>;

interface MeshElement {
  readonly type: string;
  readonly entityId: string;
  readonly nodes: readonly number[];
}

/** Node positions and elements of a mesh by id (analysis length units). */
function indexMesh(mesh: FeMeshArtifact): {
  readonly position: ReadonlyMap<number, Vec3>;
  readonly elements: ReadonlyMap<number, MeshElement>;
} {
  const position = new Map<number, Vec3>(mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]]]));
  const elements = new Map<number, MeshElement>();
  for (const block of mesh.blocks)
    for (const element of block.elements)
      elements.set(element[0] ?? -1, { type: block.type, entityId: block.entityId, nodes: element.slice(1) });
  return { position, elements };
}

/** Linear tetrahedra only: the works below weigh the corner displacements equally (linear shape functions; a C3D10 would need midside weights). */
const isTet = (type: string): boolean => type === 'C3D4';

/** Mean displacement of `nodes`, or the node that has none. */
function meanDisplacement(nodes: readonly number[], displacement: Displacement): Vec3 | number {
  const mean: [number, number, number] = [0, 0, 0];
  for (const node of nodes) {
    const u = Object.hasOwn(displacement, String(node)) ? displacement[String(node)] : undefined;
    if (u === undefined) return node;
    mean[0] += (u[0] ?? 0) / nodes.length;
    mean[1] += (u[1] ?? 0) / nodes.length;
    mean[2] += (u[2] ?? 0) / nodes.length;
  }
  return mean;
}

/** F^T u of a nodal force load: its share at every node of the mesh node set `L_<id>` times that node's displacement. */
function forceWork(load: FeaLoad, mesh: FeMeshArtifact, displacement: Displacement): number | string {
  if (load.vector === undefined) return `force '${load.id}' has no vector`;
  const nodes = Object.hasOwn(mesh.nodeSets, `L_${load.id}`) ? (mesh.nodeSets[`L_${load.id}`] ?? []) : [];
  if (nodes.length === 0) return `force '${load.id}' has no nodes in the mesh`;
  const share = load.distribution === 'per_node' ? 1 : 1 / nodes.length;
  let work = 0;
  for (const node of nodes) {
    const u = meanDisplacement([node], displacement);
    if (typeof u === 'number') return `node ${u} of force '${load.id}' has no displacement`;
    work += share * dot3(load.vector, u);
  }
  return work;
}

/** F^T u of a pressure: −p · A · (n_out · ū) over the tetrahedron faces of the face set `L_<id>` (positive pressure pushes into the material). */
function pressureWork(load: FeaLoad, mesh: FeMeshArtifact, displacement: Displacement): number | string {
  const faces = Object.hasOwn(mesh.faceSets, `L_${load.id}`) ? (mesh.faceSets[`L_${load.id}`] ?? []) : [];
  if (faces.length === 0 || load.magnitude === undefined) return `pressure '${load.id}' has no faces in the mesh`;
  const { position, elements } = indexMesh(mesh);
  let work = 0;
  for (const [elementId, face] of faces) {
    const element = elements.get(elementId);
    const corners = TET_FACES[face - 1];
    if (element === undefined || corners === undefined || !isTet(element.type))
      return `pressure '${load.id}': face loads are rebuilt on linear tetrahedra (C3D4) only (element ${elementId} is ${element?.type ?? 'missing'})`;
    const nodes = corners.map((corner) => element.nodes[corner] ?? -1);
    const opposite = element.nodes.find((_, index) => index < 4 && !corners.includes(index)) ?? -1;
    const points = [...nodes, opposite].map((node) => position.get(node));
    if (points.some((point) => point === undefined)) return `pressure '${load.id}': element ${elementId} has a node without coordinates`;
    const [a, b, c, d] = points as [Vec3, Vec3, Vec3, Vec3];
    const cross = cross3(sub3(b, a), sub3(c, a));
    const area = len3(cross) / 2;
    if (!(area > 0)) return `pressure '${load.id}': face ${face} of element ${elementId} has no area`;
    const outward = dot3(cross, sub3(d, a)) > 0 ? -1 / (2 * area) : 1 / (2 * area);
    const u = meanDisplacement(nodes, displacement);
    if (typeof u === 'number') return `node ${u} of pressure '${load.id}' has no displacement`;
    work += -load.magnitude * area * outward * dot3(cross, u);
  }
  return work;
}

/** F^T u of gravity on the rebuilt solid: ρ · V_e · (a · ū_e) over its linear tetrahedra (`density` in analysis units). */
function gravityWork(load: FeaLoad, mesh: FeMeshArtifact, displacement: Displacement, entityId: string, density: number): number | string {
  if (load.vector === undefined) return `gravity '${load.id}' has no acceleration vector`;
  const { position, elements } = indexMesh(mesh);
  let work = 0;
  let counted = 0;
  for (const element of elements.values()) {
    if (element.entityId !== entityId) continue;
    if (!isTet(element.type)) return `gravity '${load.id}': body loads are rebuilt on linear tetrahedra (C3D4) only (${element.type})`;
    const corners = element.nodes.slice(0, 4);
    const points = corners.map((node) => position.get(node));
    if (points.some((point) => point === undefined)) return `gravity '${load.id}': an element has a node without coordinates`;
    const [a, b, c, d] = points as [Vec3, Vec3, Vec3, Vec3];
    const volume = Math.abs(dot3(cross3(sub3(b, a), sub3(c, a)), sub3(d, a))) / 6;
    const u = meanDisplacement(corners, displacement);
    if (typeof u === 'number') return `node ${u} of the solid has no displacement (gravity '${load.id}')`;
    work += density * volume * dot3(load.vector, u);
    counted += 1;
  }
  return counted === 0 ? `gravity '${load.id}': the mesh has no element of '${entityId}'` : work;
}

/** F^T u of one load case: the sum over its loads, or the reason it cannot be rebuilt. */
function externalWork(
  doc: CadDocument,
  analysis: AnalysisCase,
  name: string,
  index: number,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  entityId: string,
): number | string {
  const displacement = stepOfLoadCase(results, index)?.fields['DISP']?.values;
  if (displacement === undefined) return `load case '${name}' has no displacement field in the results`;
  let work = 0;
  for (const id of analysis.loadOrder) {
    const load = analysis.loads[id];
    if (load === undefined || load.loadCase !== name) continue;
    let own: number | string;
    if (load.kind === 'force') own = forceWork(load, mesh, displacement);
    else if (load.kind === 'pressure') own = pressureWork(load, mesh, displacement);
    else if (load.kind === 'gravity') {
      const materialId = doc.entities[entityId]?.materialId;
      const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
      if (material === undefined || !(material.density > 0)) return `gravity '${id}': the solid '${entityId}' has no material density`;
      own = gravityWork(load, mesh, displacement, entityId, densityToAnalysis(material.density, doc.units, analysis.unitSystem));
    } else return `load '${id}' is a ${load.kind}: F^T u is rebuilt for force, pressure and gravity loads`;
    if (typeof own === 'string') return own;
    work += own;
  }
  return work;
}

/**
 * Ratio of the weighted compliance F^T u of the solid `entityId` (first static analysis that has it as a part) to `optimumCompliance` of the study.
 * @invariant uses only an artifact-verified, non-stale 05 result (`trustedRecord` solved); weights are the study's load case weights; both
 *   compliances are converted to N*mm; only the load cases of the optimum are summed
 * @failure no analysis of the entity, unsolved, stale, unverifiable, a moment load, non-tetrahedral face / body loads, missing displacement ->
 *   ComplianceUnavailable
 */
export function rebuildCompliance(
  doc: CadDocument,
  study: TopologyStudy,
  optimumCompliance: number,
  optimumLoadCases: readonly string[],
  entityId: string,
  port: FeArtifactPort | null | undefined,
): RebuildCompliance | ComplianceUnavailable {
  const model = analysisOf(doc);
  const analysis = model.caseOrder
    .map((id) => model.cases[id])
    .find((candidate) => candidate?.type === 'static' && Object.hasOwn(candidate.parts, entityId));
  if (analysis === undefined) return unavailable('no_analysis', `no static 05 analysis has '${entityId}' as a part`);
  const trust = trustedRecord(doc, analysis, port);
  if (trust.state === 'stale') return unavailable('stale', `the 05 results of ${analysis.id} are stale: re-run fea_mesh and fea_solve`);
  if (trust.state === 'unmeshed' || trust.state === 'meshed')
    return unavailable('not_solved', `the 05 analysis ${analysis.id} of '${entityId}' has no results`);
  if (trust.state !== 'solved' || trust.meshArtifact === null || trust.resultsArtifact === null)
    return unavailable(
      'unverified',
      trust.problem?.message ?? `the 05 results of ${analysis.id} cannot be verified against their artifacts`,
    );
  const names = loadCasesOf(analysis).map((entry) => entry.name);
  let rebuild = 0;
  for (const name of optimumLoadCases) {
    const index = names.indexOf(name);
    if (index < 0) return unavailable('unsupported', `analysis ${analysis.id} has no load case '${name}' of the optimum`);
    const work = externalWork(doc, analysis, name, index, trust.meshArtifact, trust.resultsArtifact, entityId);
    if (typeof work === 'string') return unavailable('unsupported', work);
    rebuild += (study.objective.loadCaseWeights[name] ?? 1) * work;
  }
  const optimumNmm = optimumCompliance * unitSystemFactors(model.cases[study.analysisId]?.unitSystem ?? 'N-mm-t-s').nmmPerForceLength;
  if (!(optimumNmm > 0)) return unavailable('optimum_zero', 'the compliance of the optimum is not positive');
  const rebuildNmm = rebuild * unitSystemFactors(analysis.unitSystem).nmmPerForceLength;
  return { available: true, analysisId: analysis.id, rebuildNmm, optimumNmm, ratio: rebuildNmm / optimumNmm };
}
