/**
 * `cfd_probe`, `cfd_slice`, `cfd_streamlines` transports (12 CFD TECHNICAL_SPEC §4 / §5.5, M3a): read-only queries on the recorded result of a
 * case. `flowQueryInput` (@aero, pure) refuses unless the result is trusted (bundle present, hash and recomputed summary equal) and current
 * (not stale); the field file the bundle binds by hash is read from the CFD file store; `llull-compute flow-query` samples / traces it (Rust:
 * trilinear sampling, RK4 streamlines, GPU when asked and present); the answer is cross-checked and its file (slice / streamlines) stored
 * content-addressed for the overlay. The document is never changed. No TypeScript fallback: without the binary CFD_SOLVER_MISSING.
 */

import { defaultContext } from '@core/commands/context';
import { withFullResolution } from '@core/geometry/entityTriangles';
import type { FeaHost, FeaToolResult } from '@protocol/index';
import { cfdCaseOf, flowQueryInput, flowQueryReport, parseFlowQuery, parseFlowQueryAnswer, type FlowQueryOp } from '@aero/index';
import { feaFailure } from '../fea/feaCommon';
import { defaultMeshAssetStore } from '../meshAssets/store';
import { readOutput, withJobFolder } from '../native/computeJob';
import type { NativeDeps } from '../native/fatigueField';
import { nativeInstallHint } from '../native/nativeBinary';
import { cfdFileStore } from './fileStore';
import { cfdResultPort } from './resultPort';

/** Named default: wall-clock limit of one query job (4096 streamlines take seconds; the field read dominates large grids). */
const DEFAULT_CFD_QUERY_TIMEOUT_S = 600;

const FILE_OF: Readonly<Record<FlowQueryOp, string | null>> = { probe: null, slice: 'slice.bin', streamlines: 'streamlines.bin' };

const fail = (tool: string, code: string, message: string, ids: readonly string[], extra: Record<string, unknown> = {}): FeaToolResult => ({
  ...feaFailure(tool, code, message, ids),
  data: { code, ...extra },
});

/**
 * @failure invalid params -> CFD_PARAM_INVALID; the trust / staleness refusals of `flowQueryInput` (CFD_CASE_NOT_FOUND, CFD_NO_RESULT,
 *   CFD_RESULT_MISSING, CFD_RESULT_HASH_MISMATCH, CFD_RESULT_STALE); the field file missing or damaged -> CFD_RESULT_MISSING; no binary ->
 *   CFD_SOLVER_MISSING; caller cancelled -> CFD_CANCELLED (process tree killed); job error / bad answer -> CFD_SOLVER_FAILED (data.nativeCode)
 */
export async function runCfdQuery(
  op: FlowQueryOp,
  params: unknown,
  host: FeaHost,
  deps: NativeDeps,
  options: { readonly timeoutS?: number; readonly signal?: AbortSignal | undefined } = {},
): Promise<FeaToolResult> {
  const tool = `cfd_${op}`;
  const request = parseFlowQuery(op, params);
  if ('ok' in request) return fail(tool, request.code, request.message, request.ids);
  const { caseId } = request.params;
  const raw = host.getDoc();
  const doc = withFullResolution(raw, cfdCaseOf(raw, caseId)?.entityIds ?? [], defaultMeshAssetStore());
  const input = flowQueryInput(doc, request, cfdResultPort(deps.store), defaultContext().kernel);
  if (!input.ok) return fail(tool, input.code, input.message, input.ids);
  if (deps.runner.binary === null)
    return fail(tool, 'CFD_SOLVER_MISSING', `llull-compute is not installed. NATIVE_TOOL_MISSING: ${nativeInstallHint('llull-compute')}.`, [
      caseId,
    ]);
  const files = cfdFileStore(deps.store.directory);
  const field = files.get(input.artifact.field.sha256);
  if (field === null)
    return fail(
      tool,
      'CFD_RESULT_MISSING',
      `the field file ${input.artifact.field.sha256.slice(0, 12)} of result ${input.resultsHash.slice(0, 12)} is not in this machine's store: run cfd_solve`,
      [caseId, input.resultsHash],
    );
  const output = FILE_OF[op];
  const seconds = Math.max(1, Math.min(86_400, options.timeoutS ?? DEFAULT_CFD_QUERY_TIMEOUT_S));
  const outcome = await withJobFolder(
    { 'job.json': JSON.stringify(input.job), 'field.bin': field },
    async (folder) => {
      const run = await deps.runner.run(['flow-query'], folder, seconds * 1000, undefined, options.signal);
      if (!run.ok) return { run, text: null, file: null };
      const [text, file] = await Promise.all([
        readOutput(folder, run, 'query.json'),
        output === null ? Promise.resolve(Buffer.alloc(0)) : readOutput(folder, run, output),
      ]);
      return { run, text: text.toString('utf8'), file };
    },
    deps.env,
  ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  if ('error' in outcome) return fail(tool, 'CFD_SOLVER_FAILED', `the job folder or its outputs failed: ${outcome.error}`, [caseId]);
  const { run, text, file } = outcome;
  if (text === null || file === null) {
    if (run.code === 'NATIVE_CANCELLED')
      return fail(tool, 'CFD_CANCELLED', 'the query was cancelled: the process tree was killed', [caseId]);
    if (run.code === 'NATIVE_TOOL_MISSING') return fail(tool, 'CFD_SOLVER_MISSING', run.message ?? 'llull-compute is missing', [caseId]);
    const code = run.code === 'NATIVE_TIMEOUT' ? 'CFD_TIMEOUT' : 'CFD_SOLVER_FAILED';
    return fail(tool, code, `${run.message ?? 'llull-compute flow-query failed'}. Last output:\n${run.log.slice(-2000)}`, [caseId], {
      nativeCode: run.code,
    });
  }
  const answered = parseFlowQueryAnswer(op, text, new Uint8Array(file));
  if (typeof answered === 'string') return fail(tool, 'CFD_SOLVER_FAILED', answered, [caseId]);
  const stored = output === null ? null : { sha256: files.put(file), bytes: file.length };
  const report = flowQueryReport(input, answered, stored);
  const warnings = run.warnings.map((entry) => `${entry.code}: ${entry.message}`).join('; ');
  return {
    summary: warnings === '' ? report.summary : `${report.summary} [${warnings}]`,
    affected: [],
    isError: false,
    data: { ...report.data, elapsedMs: run.elapsedMs, ...(run.warnings.length > 0 ? { warnings: run.warnings } : {}) },
  };
}
