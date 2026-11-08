/**
 * fea_mesh with mesh source implicit_field (14 FLL-M1, FR-FLL-05): every part is an implicit body meshed from its field by `llull-compute field`
 * op `tets` (isosurface stuffing, one job per part: solver/crates/llull-field/src/tets_job.rs). @cae builds each job's targets and assembles the
 * results into the usual FeMeshArtifact; this module only runs the jobs, stores the artifact and records it with record_fe_mesh. No Netgen, no STL.
 * Environment: LLULL_FIELD_TETS_STALL_S (default 120: a job silent that long is stopped), LLULL_FIELD_TETS_TIMEOUT_S (default 14400, a backstop).
 * @invariant a cancelled, stalled, timed-out, refused or failed job commits nothing (no artifact stored, record_fe_mesh not run)
 * @invariant concurrent calls whose job files are identical share one job (key: sha256 over the job files); each caller waits with its own
 *   signal and leaving cancels only its own wait; the job (its whole process tree) is killed when its last caller leaves
 * @invariant the bound is on progress: the job reports every whole percent and is stopped after LLULL_FIELD_TETS_STALL_S without a report
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { implicitBodyField } from '@implicit/index';
import { assembleFieldMesh, fieldJobTargets, FIELD_MESH_LIMITS, FIELD_MESH_PAD, type FieldPartMesh, type MeshRequest } from '@cae/index';
import { isRecord } from '@lib/isRecord';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { positiveInteger } from '../env';
import { sha256Hex } from '../sha256';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';
import { feaFailure } from './feaCommon';
import { f64Values, readOutput, withJobFolder, type ComputeRunner } from '../native/computeJob';
import { packProgram, type Files } from '../native/fieldEngine';
import { createSharedRuns } from '../native/sharedRun';

const DEFAULT_STALL_S = 120;
const DEFAULT_TIMEOUT_S = 4 * 3600;

export interface FieldMeshDeps {
  readonly runner: ComputeRunner;
  readonly store: FeArtifactStore;
  readonly hooks: CaeHooks;
  readonly env: NodeJS.ProcessEnv;
}

type PartOutcome =
  | { readonly ok: true; readonly part: FieldPartMesh }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface Progress {
  readonly step: number;
  readonly message: string;
}

const runs = createSharedRuns<PartOutcome, Progress, { readonly entityId: string }>({ replayLatest: true });

/** The job files of one part, or the reason it cannot be meshed from its field. */
function partJob(
  doc: CadDocument,
  request: MeshRequest,
  entityId: string,
): { readonly ok: true; readonly files: Files } | { readonly ok: false; readonly code: string; readonly message: string } {
  const body = implicitBodyField(doc, entityId);
  if (!body.ok) return body;
  const targets = fieldJobTargets(request, entityId);
  if (!Array.isArray(targets)) return { ok: false, ...targets };
  const h = request.controls.globalSize;
  const files: Files = {};
  const program = packProgram(body.program, '', files);
  files['job.json'] = JSON.stringify({
    op: 'tets',
    program,
    grid: { min: body.bounds.min.map((v) => v - FIELD_MESH_PAD * h), max: body.bounds.max.map((v) => v + FIELD_MESH_PAD * h), voxel: h },
    order: request.controls.order,
    maxLatticeVertices: FIELD_MESH_LIMITS.maxLatticeVertices,
    maxTets: FIELD_MESH_LIMITS.maxTets,
    lengthScale: request.lengthToAnalysis,
    targets,
  });
  return { ok: true, files };
}

/** Content key of a job: sha256 over the sorted file names and their bytes. */
function jobKey(files: Files): string {
  const parts = Object.keys(files)
    .sort()
    .map((name) => `${name}:${sha256Hex(typeof files[name] === 'string' ? (files[name] as string) : (files[name] as Buffer))}`);
  return sha256Hex(parts.join('\n'));
}

const u32Values = (bytes: Buffer): Uint32Array => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Uint32Array(copy.buffer, 0, Math.floor(bytes.length / 4));
};

/** Runs one part job; resolves with the part or a named failure, never rejects. */
async function runPart(
  entityId: string,
  files: Files,
  deps: FieldMeshDeps,
  signal: AbortSignal,
  publish: (progress: Progress) => void,
): Promise<PartOutcome> {
  const stallMs = positiveInteger(deps.env['LLULL_FIELD_TETS_STALL_S'], DEFAULT_STALL_S) * 1000;
  const timeoutMs = positiveInteger(deps.env['LLULL_FIELD_TETS_TIMEOUT_S'], DEFAULT_TIMEOUT_S) * 1000;
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), stallMs);
  const onProgress = (event: Readonly<Record<string, unknown>>): void => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), stallMs);
    publish({ step: typeof event['step'] === 'number' ? event['step'] : 0, message: String(event['message'] ?? '') });
  };
  try {
    return await withJobFolder(
      files,
      async (folder): Promise<PartOutcome> => {
        const run = await deps.runner.run(['field'], folder, timeoutMs, onProgress, AbortSignal.any([signal, stall.signal]));
        if (!run.ok && stall.signal.aborted)
          return {
            ok: false,
            code: 'FLL_IMPLICIT_MESH_STALLED',
            message: `the field mesh job of '${entityId}' reported no progress for ${stallMs / 1000} s and was stopped`,
          };
        if (!run.ok) return { ok: false, code: run.code ?? 'NATIVE_JOB_FAILED', message: run.message ?? 'the field mesh job failed' };
        const report: unknown = JSON.parse((await readOutput(folder, run, 'report.json')).toString('utf8'));
        if (!isRecord(report)) return { ok: false, code: 'FEA_MESH_FAILED', message: 'the field mesh report is not an object' };
        const refused = report['refusal'];
        if (isRecord(refused))
          return {
            ok: false,
            code: String(refused['code'] ?? 'FEA_MESH_FAILED'),
            message: `'${entityId}': ${String(refused['message'] ?? '')}`,
          };
        const nodes = f64Values(await readOutput(folder, run, 'nodes.f64'));
        const elements = u32Values(await readOutput(folder, run, 'elements.u32'));
        return { ok: true, part: { entityId, nodes, elements, report } };
      },
      deps.env,
    );
  } catch (error) {
    return { ok: false, code: 'FEA_MESH_FAILED', message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Meshes every part of `request` from its field and records the mesh.
 * @failure part not an implicit body -> FLL_IMPLICIT_FIELD_MISSING; body older than its field -> IMP_BODY_STALE; no llull-compute ->
 *   NATIVE_TOOL_MISSING; budget -> FLL_IMPLICIT_MESH_TOO_LARGE; quality -> FLL_IMPLICIT_MESH_QUALITY; no progress -> FLL_IMPLICIT_MESH_STALLED;
 *   caller cancelled -> FEA_MESH_CANCELLED; target -> FEA_TARGET_UNRESOLVED / FEA_TARGET_AMBIGUOUS (all: nothing recorded)
 */
export async function runFieldMesh(request: MeshRequest, host: FeaHost, deps: FieldMeshDeps): Promise<FeaToolResult> {
  const fail = (code: string, message: string, ids: readonly string[] = []): FeaToolResult =>
    feaFailure('fea_mesh', code, message, [request.analysisId, ...ids]);
  const doc = host.getDoc();
  if (deps.runner.binary === null)
    return fail(
      'NATIVE_TOOL_MISSING',
      'mesh source implicit_field needs llull-compute (cargo build --profile compute -p llull-compute in solver/)',
    );
  const jobs: { readonly entityId: string; readonly files: Files }[] = [];
  for (const entityId of request.entityIds) {
    const job = partJob(doc, request, entityId);
    if (!job.ok) return fail(job.code, job.message, [entityId]);
    jobs.push({ entityId, files: job.files });
  }
  const parts: FieldPartMesh[] = [];
  for (const { entityId, files } of jobs) {
    const outcome = await runs.join(jobKey(files), { entityId }, (signal, publish) => runPart(entityId, files, deps, signal, publish), {
      signal: host.signal,
      onProgress: (p) => host.onProgress?.(`fea_mesh ${entityId}: ${p.message} ${p.step} %`),
    });
    if (outcome.kind === 'detached' || outcome.kind === 'stopped')
      return fail('FEA_MESH_CANCELLED', `meshing '${entityId}' from its field was cancelled; nothing was recorded`, [entityId]);
    if (outcome.kind === 'failed') return fail('FEA_MESH_FAILED', outcome.error, [entityId]);
    if (!outcome.value.ok) return fail(outcome.value.code, outcome.value.message, [entityId]);
    parts.push(outcome.value.part);
  }
  const assembled = assembleFieldMesh(request, parts, `${await deps.runner.version()} (isosurface stuffing)`);
  if ('code' in assembled) return fail(assembled.code, assembled.message);
  if (host.signal?.aborted === true) return fail('FEA_MESH_CANCELLED', 'fea_mesh was cancelled; nothing was recorded');
  const mesh: FeMeshArtifact = assembled.artifact;
  const meshHash = deps.store.put(mesh);
  const recorded = host.applyCommand('record_fe_mesh', { analysisId: request.analysisId, summary: deps.hooks.meshSummary(mesh, meshHash) });
  const elements = mesh.blocks.reduce((sum, block) => sum + block.elements.length, 0);
  const figures = assembled.figures
    .map(
      (f) =>
        `'${f.entityId}' ${f.elements} elements, volume ${f.volume.toPrecision(7)} ${request.documentUnit}^3, dihedral ${f.minDihedralDeg.toFixed(1)}-${f.maxDihedralDeg.toFixed(1)} deg`,
    )
    .join('; ');
  return {
    summary: `fea_mesh: ${mesh.nodes.length} nodes, ${elements} ${request.controls.order === 2 ? 'C3D10' : 'C3D4'} from the implicit field (${mesh.mesher} ${mesh.mesherVersion}, lattice ${request.controls.globalSize} ${request.documentUnit}): ${figures}. ${recorded.summary}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: {
      meshHash,
      nodes: mesh.nodes.length,
      elements: { [request.controls.order === 2 ? 'C3D10' : 'C3D4']: elements },
      targets: Object.keys(mesh.nodeSets).length,
      facetedParts: [],
      fieldParts: assembled.figures,
    },
  };
}
