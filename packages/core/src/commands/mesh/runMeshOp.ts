/** The common flow of a single-mesh constructive command: load, optionally require a closed mesh, run one engine op, commit, report. */

import type { CadDocument, Entity, MeshData } from '../../model/types';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import type { MeshOp, MeshOpResult } from '../../geometry/mesh/engineTypes';
import type { CommandResult, ExecutionContext } from '../types';
import {
  type NamedDefault,
  type SolidMesh,
  commitMesh,
  contextOf,
  engineOutcome,
  isCommandResult,
  isLoadFailure,
  loadSolidMesh,
  measureMesh,
  meshRejection,
  outwardMesh,
  withConventions,
} from './meshCommon';

export interface Measure {
  readonly area: number;
  readonly volume: number | null;
  readonly closed: boolean;
  readonly faces: number;
  readonly vertices: number;
}

export interface MeshOpSpec {
  readonly command: string;
  readonly id: string;
  readonly keepSource: boolean;
  /** Refuse (MESH_NOT_CLOSED) unless the input is a closed manifold mesh. */
  readonly requireClosed: boolean;
  /** Reject before running the engine: a coded message, or null. */
  readonly precheck?: (loaded: SolidMesh, before: Measure) => { code: string; message: string; path?: string } | null;
  readonly op: (loaded: SolidMesh, before: Measure) => MeshOp;
  readonly defaults?: (loaded: SolidMesh) => NamedDefault[];
  readonly fields: (before: Measure, after: Measure, result: MeshOpResult) => Record<string, unknown>;
  readonly summary: (id: string, resultId: string, before: Measure, after: Measure, unit: string) => string;
}

/** Run `spec` on entity `spec.id`; returns the new document (source rewritten in place or kept) and the data conventions. */
export function runMeshOp(doc: CadDocument, ctx: ExecutionContext | undefined, spec: MeshOpSpec): CommandResult {
  const loaded = loadSolidMesh(doc, spec.id);
  if (isLoadFailure(loaded)) return meshRejection(doc, spec.command, loaded.code, loaded.message, loaded.ids);
  const before = measureMesh(loaded.mesh);
  if (spec.requireClosed && !before.closed) {
    return meshRejection(doc, spec.command, 'MESH_NOT_CLOSED', `entity '${spec.id}' has open or non-manifold edges`, [spec.id]);
  }
  const problem = spec.precheck?.(loaded, before) ?? null;
  if (problem !== null)
    return meshRejection(doc, spec.command, problem.code, problem.message, [spec.id], problem.path !== undefined ? [problem.path] : []);
  const input: MeshData = spec.requireClosed ? outwardMesh(loaded.mesh) : loaded.mesh;
  const engine = resolveMeshEngine(contextOf(ctx).meshProcessing);
  const outcome = engineOutcome(doc, spec.command, engine.run({ mesh: input }, spec.op(loaded, before)), [spec.id]);
  if (isCommandResult(outcome)) return outcome;
  if (outcome.mesh === undefined || outcome.mesh.indices.length === 0) {
    return meshRejection(doc, spec.command, 'MESH_PARAM_INVALID', 'the result is empty: the operation removes the whole body', [spec.id]);
  }
  const after = measureMesh(outcome.mesh);
  const committed = commitMesh(doc, loaded.entity as Entity, outcome.mesh, { keepSource: spec.keepSource, unverified: loaded.unverified });
  const data = withConventions(
    doc,
    {
      id: committed.id,
      sourceId: spec.id,
      faces: after.faces,
      vertices: after.vertices,
      volume: after.volume,
      area: after.area,
      closed: after.closed,
      ...spec.fields(before, after, outcome),
    },
    { unverified: loaded.unverified, provenance: outcome.provenance, defaults: spec.defaults?.(loaded) ?? [] },
  );
  return {
    document: committed.document,
    summary: spec.summary(spec.id, committed.id, before, after, doc.units),
    affected: [committed.id],
    data,
  };
}
