/** The common flow of a single-mesh constructive command: load, optionally require a closed mesh, run one engine op, commit, report. */

import type { CadDocument, Entity, MeshData } from '../../model/types';
import { DEVIATION_MAX_SAMPLES, type DeviationSummary } from '../../geometry/mesh/deviation';
import { resolveMeshEngine } from '../../geometry/mesh/engine';
import type { MeshEngineFailure, MeshOp, MeshOpResult, MeshProcessingEngine } from '../../geometry/mesh/engineTypes';
import type { CommandResult, ExecutionContext } from '../types';
import {
  type NamedDefault,
  type SolidMesh,
  commitMesh,
  contextOf,
  engineOutcome,
  isCommandResult,
  isLoadFailure,
  isStoreFailure,
  loadSolidMesh,
  measureMesh,
  meshRejection,
  outwardMesh,
  storeMesh,
  withConventions,
} from './meshCommon';

/** Symmetric deviation of two meshes through the installed engines (native for big meshes), or the engine's refusal. */
export function engineDeviation(engine: MeshProcessingEngine, from: MeshData, to: MeshData): DeviationSummary | MeshEngineFailure {
  const result = engine.run({ mesh: from }, { op: 'deviation', other: { mesh: to }, maxSamples: DEVIATION_MAX_SAMPLES });
  if ('code' in result) return result;
  return result.deviation ?? { code: 'MESH_ENGINE_UNSUPPORTED', message: 'the engine returned no deviation' };
}

/** What the deviation samples are (the Hausdorff value is a lower bound of the exact one). */
export const DEVIATION_BASIS = 'closest-surface distance from vertices and triangle centroids, both ways';

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
  /** Weld tolerance (document units) for loading the entity; default 1e-6 x diagonal. */
  readonly weldTolerance?: number;
  /** Report the symmetric deviation of the result from the input in data.deviation (FR-MSH-25). */
  readonly deviation?: boolean;
  /** Reject before running the engine: a coded message, or null. */
  readonly precheck?: (loaded: SolidMesh, before: Measure) => { code: string; message: string; path?: string } | null;
  /** Reject after the engine ran (the result is discarded): a coded message, or null. */
  readonly accept?: (result: MeshOpResult) => { code: string; message: string; path?: string } | null;
  readonly op: (loaded: SolidMesh, before: Measure) => MeshOp;
  /** A second step on the engine result (e.g. drain holes after a hollow); its result replaces the first. */
  readonly post?: (
    result: MeshOpResult,
    loaded: SolidMesh,
    input: MeshData,
    engine: MeshProcessingEngine,
  ) => MeshOpResult | MeshEngineFailure;
  readonly defaults?: (loaded: SolidMesh) => NamedDefault[];
  readonly fields: (before: Measure, after: Measure, result: MeshOpResult) => Record<string, unknown>;
  readonly summary: (id: string, resultId: string, before: Measure, after: Measure, unit: string, result: MeshOpResult) => string;
}

/** Run `spec` on entity `spec.id`; returns the new document (source rewritten in place or kept) and the data conventions. */
export function runMeshOp(doc: CadDocument, ctx: ExecutionContext | undefined, spec: MeshOpSpec): CommandResult {
  const assets = contextOf(ctx).meshAssets;
  const loaded = loadSolidMesh(doc, spec.id, spec.weldTolerance, assets);
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
  const first = engineOutcome(doc, spec.command, engine.run({ mesh: input }, spec.op(loaded, before)), [spec.id]);
  if (isCommandResult(first)) return first;
  const outcome = spec.post === undefined ? first : engineOutcome(doc, spec.command, spec.post(first, loaded, input, engine), [spec.id]);
  if (isCommandResult(outcome)) return outcome;
  const refused = spec.accept?.(outcome) ?? null;
  if (refused !== null)
    return meshRejection(doc, spec.command, refused.code, refused.message, [spec.id], refused.path !== undefined ? [refused.path] : []);
  if (outcome.mesh === undefined || outcome.mesh.indices.length === 0) {
    return meshRejection(doc, spec.command, 'MESH_PARAM_INVALID', 'the result is empty: the operation removes the whole body', [spec.id]);
  }
  const after = measureMesh(outcome.mesh);
  const stored = storeMesh(outcome.mesh, assets);
  if (isStoreFailure(stored)) return meshRejection(doc, spec.command, stored.code, stored.message, [spec.id]);
  const committed = commitMesh(doc, loaded.entity as Entity, stored, { keepSource: spec.keepSource, unverified: loaded.unverified });
  const measured = spec.deviation === true ? engineDeviation(engine, input, outcome.mesh) : null;
  const deviation = measured === null || 'code' in measured ? null : measured;
  const deviationSkipped = measured !== null && 'code' in measured ? measured.code : null;
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
      ...(deviation !== null ? { deviation: { ...deviation, max: deviation.hausdorff, unit: doc.units, basis: DEVIATION_BASIS } } : {}),
      ...(deviationSkipped !== null ? { deviation: null, deviationSkipped } : {}),
      ...spec.fields(before, after, outcome),
    },
    { unverified: loaded.unverified, provenance: outcome.provenance, defaults: spec.defaults?.(loaded) ?? [] },
  );
  return {
    document: committed.document,
    summary: spec.summary(spec.id, committed.id, before, after, doc.units, outcome),
    affected: [committed.id],
    data,
  };
}
