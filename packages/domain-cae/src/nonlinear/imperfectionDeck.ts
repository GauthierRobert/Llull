/** PHY-05 TR-NLS-30: the `*NODE` coordinates of a nonlinear deck moved by sum(amplitude_i x phi_i / max|phi_i|) over pinned buckling mode shapes. */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { Imperfection } from '@core/model/nonlinear';
import type { DeckContext, DeckRefusal } from '../decks/context';
import { commentText } from '../decks/format';
import { fetchArtifact } from '../shared/trust';
import { imperfectionsOf } from './imperfectionShape';

/** Element i of a numeric array; 0 for an index past the end (noUncheckedIndexedAccess identity, never an engineering default). */
const at = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

/** Two meshes are the same when every node keeps its id and lies within this fraction of the mesh size of its twin. */
const SAME_NODE_FRACTION = 1e-9;

type Node = FeMeshArtifact['nodes'][number];

const invalid = (message: string, ids: readonly string[]): DeckRefusal => ({ code: 'NLS_IMPERFECTION_SOURCE_INVALID', message, ids });

/** Mode result sets of a buckling results artifact in mode order: every set but the zero-factor reference set (the rule of plotSetup's modeSteps). */
const bucklingModeSets = (results: FeResultsArtifact): FeResultsArtifact['steps'][number][] => results.steps.filter((set) => set.time > 0);

/** Diagonal of the bounding box of the mesh nodes (0 for an empty mesh). */
function meshSize(mesh: FeMeshArtifact): number {
  if (mesh.nodes.length === 0) return 0;
  const lows = [Infinity, Infinity, Infinity];
  const highs = [-Infinity, -Infinity, -Infinity];
  for (const node of mesh.nodes)
    for (let axis = 0; axis < 3; axis++) {
      const value = node[axis + 1] ?? 0;
      lows[axis] = Math.min(lows[axis] ?? value, value);
      highs[axis] = Math.max(highs[axis] ?? value, value);
    }
  return Math.hypot(...highs.map((high, axis) => high - (lows[axis] ?? high)));
}

/** Refusal when `source` is not node-for-node the mesh of the deck (same ids, coordinates within SAME_NODE_FRACTION of the mesh size). */
function meshMismatch(mesh: FeMeshArtifact, source: FeMeshArtifact, imperfection: Imperfection, analysisId: string): DeckRefusal | null {
  const twins = new Map<number, Node>(source.nodes.map((node) => [node[0], node]));
  const tolerance = SAME_NODE_FRACTION * Math.max(1, meshSize(mesh));
  let differing = 0;
  for (const node of mesh.nodes) {
    const twin = twins.get(node[0]);
    if (twin === undefined || !(Math.hypot(node[1] - twin[1], node[2] - twin[2], node[3] - twin[3]) <= tolerance)) differing++;
  }
  if (source.unitSystem === mesh.unitSystem && source.nodes.length === mesh.nodes.length && differing === 0) return null;
  return invalid(
    `imperfection '${imperfection.id}': the mesh of '${analysisId}' (${mesh.nodes.length} nodes, ${mesh.unitSystem}) is not the mesh buckling case '${imperfection.fromAnalysisId}' was solved on (${source.nodes.length} nodes, ${source.unitSystem}; ${differing} node(s) differ): give both cases the same parts and mesh controls, mesh and solve the buckling case again, then delete_imperfection + add_imperfection`,
    [imperfection.id, imperfection.fromAnalysisId],
  );
}

/** Adds the offsets (analysis length units) of one imperfection into `offsets` by node id; or the refusal. */
function addOffsets(ctx: DeckContext, imperfection: Imperfection, offsets: Map<number, [number, number, number]>): DeckRefusal | null {
  const ids = [imperfection.id, imperfection.fromAnalysisId];
  const fetched = fetchArtifact(ctx.artifacts, imperfection.sourceResultsHash, 'fe_results');
  if ('code' in fetched)
    return invalid(
      `imperfection '${imperfection.id}': the pinned buckling results are not readable (${fetched.code}: ${fetched.message})`,
      ids,
    );
  const results = fetched.artifact;
  const sourceMesh = fetchArtifact(ctx.artifacts, results.meshHash, 'fe_mesh');
  if ('code' in sourceMesh)
    return invalid(
      `imperfection '${imperfection.id}': the mesh of the pinned buckling results is not readable (${sourceMesh.message})`,
      ids,
    );
  const mismatch = meshMismatch(ctx.mesh, sourceMesh.artifact, imperfection, ctx.analysisId);
  if (mismatch !== null) return mismatch;
  const sets = bucklingModeSets(results);
  for (const { mode, amplitude } of imperfection.modes) {
    const values = sets[mode - 1]?.fields['DISP']?.values;
    if (values === undefined)
      return invalid(`imperfection '${imperfection.id}': the pinned results hold ${sets.length} mode shape(s), not mode ${mode}`, ids);
    const shape: (readonly number[])[] = [];
    let peak = 0;
    for (const node of ctx.mesh.nodes) {
      const value = Object.hasOwn(values, String(node[0])) ? values[String(node[0])] : undefined;
      const magnitude = value === undefined ? Number.NaN : Math.hypot(at(value, 0), at(value, 1), at(value, 2));
      if (value === undefined || !Number.isFinite(magnitude))
        return invalid(`imperfection '${imperfection.id}': mode ${mode} has no finite displacement at node ${node[0]}`, ids);
      shape.push(value);
      peak = Math.max(peak, magnitude);
    }
    if (!(peak > 0)) return invalid(`imperfection '${imperfection.id}': mode ${mode} is zero everywhere`, ids);
    const scale = (amplitude * ctx.lengthToAnalysis) / peak;
    ctx.mesh.nodes.forEach((node, index) => {
      const value = shape[index] ?? [];
      const offset = offsets.get(node[0]) ?? [0, 0, 0];
      offsets.set(node[0], [offset[0] + scale * at(value, 0), offset[1] + scale * at(value, 1), offset[2] + scale * at(value, 2)]);
    });
  }
  return null;
}

/**
 * The `*NODE` rows of the deck (the mesh nodes, moved by the imperfections of a nonlinear_static case) and one comment line per imperfection.
 * @invariant no imperfection -> exactly `mesh.nodes`, no comment; pure and deterministic (offsets summed in imperfection then mode order)
 * @failure pinned results / mesh not in the store, a different mesh, a missing mode or node value -> NLS_IMPERFECTION_SOURCE_INVALID
 */
export function imperfectNodes(ctx: DeckContext): { readonly nodes: readonly Node[]; readonly comments: readonly string[] } | DeckRefusal {
  const imperfections = ctx.analysis.nonlinear === undefined ? [] : imperfectionsOf(ctx.analysis.nonlinear);
  if (imperfections.length === 0) return { nodes: ctx.mesh.nodes, comments: [] };
  const offsets = new Map<number, [number, number, number]>();
  const comments: string[] = [];
  for (const imperfection of imperfections) {
    const refusal = addOffsets(ctx, imperfection, offsets);
    if (refusal !== null) return refusal;
    const modes = imperfection.modes.map(({ mode, amplitude }) => `mode ${mode} x ${amplitude}`).join(' + ');
    comments.push(
      `** imperfection ${commentText(imperfection.id)}: ${modes} (document length units) from ${commentText(imperfection.fromAnalysisId)} results ${imperfection.sourceResultsHash.slice(0, 12)}; amplitude source ${commentText(imperfection.amplitudeSource, 120)}`,
    );
  }
  const nodes = ctx.mesh.nodes.map((node): Node => {
    const offset = offsets.get(node[0]) ?? [0, 0, 0];
    return [node[0], node[1] + offset[0], node[2] + offset[1], node[3] + offset[2]];
  });
  return { nodes, comments };
}
