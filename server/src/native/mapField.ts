/**
 * `fea_map_field` transport and the fea_solve pre-step (PHY-04 TR-TMC-24, RS1 RS-7): the interpolation of a thermal result onto the
 * mechanical mesh runs in `llull-compute post map` (Rust, rayon over target nodes, `llull-bvh`); the result is stored as an artifact under
 * the mapping request key, bound to the thermal results and the mechanical mesh hash. The deck writer (`thermomech/field.ts`) checks both
 * before it writes a single `*TEMPERATURE` line; without the artifact it maps in TypeScript (the reference). The document is never written.
 * Environment: LLULL_NATIVE_MAP_MIN_NODES  target node count from which fea_solve maps natively (default MAP_MIN_NODES; 0 = always).
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { temperatureMappingRequest } from '@cae/thermomech/field';
import { mappedFieldArtifact, mappingJobBuffers, readMappedField, type MappingRequest } from '@cae/thermomech/mappedField';
import { positiveInteger } from '../env';
import { caeHooks } from '../fea/caeHooks';
import { currentMesh, feaFailure, isFailure } from '../fea/feaCommon';
import { f64Bytes, f64Values, readOutput, withJobFolder, type JobRun } from './computeJob';
import { DEFAULT_NATIVE_TIMEOUT_S, type NativeDeps } from './fatigueField';

const TOOL = 'fea_map_field';
/** Target nodes from which fea_solve maps natively: below it the TypeScript mapping is fast enough (VC-TMC-10 crossover, measured). */
const MAP_MIN_NODES = 20_000;

interface Mapped {
  readonly run: JobRun;
  readonly fieldHash: string | null;
  readonly report: unknown;
}

/** Runs the job for `request` and stores its artifact; `fieldHash` null = the job failed (see `run`). */
async function mapNatively(request: MappingRequest, timeoutS: number, deps: NativeDeps): Promise<Mapped | string> {
  const files = Object.fromEntries(Object.entries(mappingJobBuffers(request)).map(([name, values]) => [name, f64Bytes(values)]));
  try {
    return await withJobFolder(
      files,
      async (folder): Promise<Mapped | string> => {
        const run = await deps.runner.run(['post', 'map'], folder, timeoutS * 1000);
        if (!run.ok) return { run, fieldHash: null, report: null };
        const mapped = f64Values(await readOutput(folder, run, 'mapped.f64'));
        const report: unknown = JSON.parse((await readOutput(folder, run, 'map.json')).toString('utf8'));
        const artifact = mappedFieldArtifact(request, mapped, await deps.runner.version());
        if (typeof artifact === 'string') return artifact;
        const fieldHash = deps.store.put(artifact);
        deps.store.alias(request.key, fieldHash);
        return readMappedField(deps.store, request) === null ? 'the stored mapped field cannot be read back' : { run, fieldHash, report };
      },
      deps.env,
    );
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function requestFor(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, deps: NativeDeps): MappingRequest | FeaToolResult {
  const request = temperatureMappingRequest(doc, analysisId, mesh, deps.store);
  if (request === null)
    return feaFailure(
      TOOL,
      'TMC_FIELD_SOURCE_INVALID',
      `analysis '${analysisId}' has no thermal_result field with mapping 'interpolate' (set_temperature_field); nothing to map`,
      [analysisId],
    );
  return 'key' in request ? request : feaFailure(TOOL, request.code, request.message, request.ids);
}

/**
 * @failure unknown / unmeshed / stale mesh -> the fea_* codes of `currentMesh`; no interpolate thermal_result field -> TMC_FIELD_SOURCE_INVALID;
 *   thermal source refusals -> their code; binary absent -> NATIVE_TOOL_MISSING (fea_solve maps in TypeScript); job failures -> their code
 */
export async function runMapField(
  analysisId: string,
  options: { readonly timeoutS?: number },
  host: FeaHost,
  deps: NativeDeps,
): Promise<FeaToolResult> {
  const doc = host.getDoc();
  const current = currentMesh(TOOL, doc, analysisId, deps.store, caeHooks);
  if (isFailure(current)) return current;
  const request = requestFor(doc, analysisId, current.mesh, deps);
  if (!('key' in request)) return request;
  const existing = readMappedField(deps.store, request);
  if (existing !== null)
    return {
      summary: `${TOOL}: '${analysisId}' already has a native mapped field for request ${request.key.slice(0, 12)} (${request.target.nodes.length} nodes); fea_solve will use it.`,
      affected: [analysisId],
      isError: false,
      data: { key: request.key, nodes: request.target.nodes.length, report: existing.report, cached: true },
    };
  const mapped = await mapNatively(request, Math.max(1, Math.min(86_400, options.timeoutS ?? DEFAULT_NATIVE_TIMEOUT_S)), deps);
  if (typeof mapped === 'string') return feaFailure(TOOL, 'NATIVE_PROTOCOL', mapped, [analysisId]);
  if (mapped.fieldHash === null) {
    const fallback = mapped.run.code === 'NATIVE_TOOL_MISSING' ? ' fea_solve maps in TypeScript instead (slower on large meshes).' : '';
    return {
      ...feaFailure(TOOL, mapped.run.code ?? 'NATIVE_JOB_FAILED', `${mapped.run.message ?? 'llull-compute failed'}.${fallback}`, [
        analysisId,
      ]),
      data: { code: mapped.run.code, log: mapped.run.log.slice(-4000) },
    };
  }
  return {
    summary: `${TOOL}: '${analysisId}' ${request.target.nodes.length} mechanical nodes mapped natively in ${mapped.run.elapsedMs} ms (field ${mapped.fieldHash.slice(0, 12)}, request ${request.key.slice(0, 12)}); the deck of fea_solve reads it after checking both hashes.`,
    affected: [analysisId],
    isError: false,
    data: {
      key: request.key,
      fieldHash: mapped.fieldHash,
      nodes: request.target.nodes.length,
      report: mapped.report,
      elapsedMs: mapped.run.elapsedMs,
      engine: 'native-cpu',
      deterministic: true,
    },
  };
}

/**
 * fea_solve pre-step: maps natively when the case reads an interpolate thermal result onto at least `minNodes` nodes and the binary
 * exists. Never fails the solve: any problem leaves the TypeScript mapping in place and is returned as a note.
 */
export function nativeMappingStep(
  deps: NativeDeps,
  env: NodeJS.ProcessEnv = process.env,
): (doc: CadDocument, analysisId: string, mesh: FeMeshArtifact) => Promise<string | null> {
  const configured = env['LLULL_NATIVE_MAP_MIN_NODES'];
  const minNodes = configured === '0' ? 0 : positiveInteger(configured, MAP_MIN_NODES);
  return async (doc, analysisId, mesh) => {
    if (deps.runner.binary === null || mesh.nodes.length < minNodes) return null;
    const request = temperatureMappingRequest(doc, analysisId, mesh, deps.store);
    if (request === null || !('key' in request) || readMappedField(deps.store, request) !== null) return null;
    const mapped = await mapNatively(request, DEFAULT_NATIVE_TIMEOUT_S, deps);
    if (typeof mapped === 'string') return `native mapping skipped (${mapped}); mapped in TypeScript`;
    return mapped.fieldHash === null
      ? `native mapping skipped (${mapped.run.code ?? 'failed'}); mapped in TypeScript`
      : `temperature field mapped natively in ${mapped.run.elapsedMs} ms`;
  };
}
