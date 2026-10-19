/**
 * `fatigue_field` transport (PHY-07 TR-FAT-41, RS1 RS-7): the pure @cae builder writes the job (`fatigueFieldInput`), `llull-compute post
 * fatigue` damages every node, the field is stored as a content-addressed artifact reachable under the case input hash, and the hot spots
 * come back through the read-only `compute_fatigue` command (which re-reads and checks the artifact). The document is never written.
 */

import type { FeaHost, FeaToolResult } from '@protocol/index';
import { isEvaluationFailure } from '@cae/fatigue/evaluate';
import { fatigueFieldArtifact, fatigueFieldInput, fatigueFieldReference, FIELD_COMPONENTS, readFatigueField } from '@cae/fatigue/feField';
import type { FeArtifactCache } from '../fea/artifactStore';
import { feaFailure } from '../fea/feaCommon';
import { f64Bytes, f64Values, readOutput, withJobFolder, type ComputeRunner } from './computeJob';

export const DEFAULT_NATIVE_TIMEOUT_S = 600;
const TOOL = 'fatigue_field';

export interface NativeDeps {
  readonly store: FeArtifactCache;
  readonly runner: ComputeRunner;
  readonly env?: NodeJS.ProcessEnv;
}

export interface FatigueFieldOptions {
  readonly timeoutS?: number;
  /** Also run the TypeScript reference on every node and report the agreement (VC-FAT-43); slower. */
  readonly verify?: boolean;
}

/** Largest relative difference between two fields, per value (0 when identical). */
function largestDifference(native: Float64Array, reference: Float64Array): number {
  let worst = 0;
  native.forEach((value, index) => {
    const wanted = reference[index] ?? Number.NaN;
    if (value === wanted) return;
    worst = Math.max(worst, Math.abs(value - wanted) / Math.max(Math.abs(value), Math.abs(wanted), Number.MIN_VALUE));
  });
  return worst;
}

/**
 * @failure input problems -> the FAT_* code of `fatigueFieldInput` (e.g. FAT_RESULTS_STALE); binary absent -> NATIVE_TOOL_MISSING (compute_fatigue keeps
 *   refusing FE cases with FAT_RESULTS_MISSING); timeout / job error / protocol or output hash problem -> NATIVE_TIMEOUT / the job code / NATIVE_PROTOCOL
 */
export async function runFatigueField(
  caseId: string,
  options: FatigueFieldOptions,
  host: FeaHost,
  deps: NativeDeps,
): Promise<FeaToolResult> {
  const input = fatigueFieldInput(host.getDoc(), caseId, deps.store);
  if (isEvaluationFailure(input)) return feaFailure(TOOL, input.code, input.message, input.ids);
  const seconds = Math.max(1, Math.min(86_400, options.timeoutS ?? DEFAULT_NATIVE_TIMEOUT_S));
  const files = { 'job.json': JSON.stringify(input.job), 'tensors.f64': f64Bytes(input.tensors) };
  const outcome = await withJobFolder(
    files,
    async (folder) => {
      const run = await deps.runner.run(['post', 'fatigue'], folder, seconds * 1000);
      if (!run.ok) return { run, field: null };
      return { run, field: f64Values(await readOutput(folder, run, 'field.f64')) };
    },
    deps.env,
  ).catch((error: unknown) => ({ run: null, field: null, error: error instanceof Error ? error.message : String(error) }));
  if (outcome.run === null) return feaFailure(TOOL, 'NATIVE_PROTOCOL', 'error' in outcome ? outcome.error : 'job folder failure', [caseId]);
  const { run, field } = outcome;
  if (field === null) {
    const fallback =
      run.code === 'NATIVE_TOOL_MISSING'
        ? ' compute_fatigue keeps refusing this FE case (FAT_RESULTS_MISSING) until the field exists.'
        : '';
    return {
      ...feaFailure(TOOL, run.code ?? 'NATIVE_JOB_FAILED', `${run.message ?? 'llull-compute failed'}.${fallback}`, [caseId]),
      data: { code: run.code, log: run.log.slice(-4000) },
    };
  }
  const artifact = fatigueFieldArtifact(input, field, await deps.runner.version());
  if (typeof artifact === 'string') return feaFailure(TOOL, 'NATIVE_PROTOCOL', artifact, [caseId]);
  const fieldHash = deps.store.put(artifact);
  deps.store.alias(input.key, fieldHash);
  const stored = readFatigueField(deps.store, input);
  if (isEvaluationFailure(stored))
    return feaFailure(TOOL, stored.code, `the stored field cannot be read back: ${stored.message}`, [caseId]);
  let verification: Record<string, unknown> | undefined;
  if (options.verify === true) {
    const started = Date.now();
    const reference = fatigueFieldReference(input);
    verification = {
      referenceMs: Date.now() - started,
      largestRelativeDifference: largestDifference(field, reference),
      identical: largestDifference(field, reference) === 0,
    };
  }
  const hotSpots = host.applyCommand('compute_fatigue', { caseId });
  return {
    summary: `fatigue_field ${caseId}: llull-compute damaged all ${input.nodeIds.length} nodes in ${run.elapsedMs} ms (field ${fieldHash.slice(0, 12)}, input ${input.key.slice(0, 12)}). ${hotSpots.summary}`,
    affected: hotSpots.affected,
    isError: hotSpots.isError,
    data: {
      caseId,
      fieldHash,
      fatigueInputHash: input.key,
      nodes: input.nodeIds.length,
      components: FIELD_COMPONENTS,
      skippedNodes: input.skippedNodes,
      elapsedMs: run.elapsedMs,
      engine: 'native-cpu',
      deterministic: true,
      ...(verification !== undefined ? { verification } : {}),
      computeFatigue: hotSpots.data,
    },
  };
}
