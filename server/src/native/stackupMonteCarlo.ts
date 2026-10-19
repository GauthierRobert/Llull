/**
 * `stackup_monte_carlo` transport (aerospace 03 GDT TR-GDT-22, RS1 RS-7): the analyze_stackup params, validated by the same core model,
 * Monte Carlo above the TypeScript cap in `llull-compute stats` (crate `llull-stats`). It draws the same Philox4x32-10 samples as
 * analyze_stackup and reduces them in the same fixed order, so for the same (seed, samples, inputs) the result equals the TS one bit for
 * bit whenever the expression has no trigonometric function (VC-GDT-37). Closed forms come from the core model; the document is never
 * written (query data only).
 */

import type { FeaHost, FeaToolResult } from '@protocol/index';
import type { ToolDefinition } from '@protocol/tools';
import { getCommand } from '@core/commands/registry';
import { programFunction } from '@lib/expressionProgram';
import { isRecord } from '@lib/isRecord';
import { sampleStackup, type SamplingStats } from '@lib/stackupSampling';
import {
  isStackupRefusal,
  resolveStackup,
  sampledContributors,
  stackupData,
  stackupJob,
  stackupParams,
  STACKUP_TS_SAMPLES_CAP,
  type StackupModel,
} from '@core/commands/pmi/stackupModel';
import { feaFailure } from '../fea/feaCommon';
import { readOutput, withJobFolder, type ComputeRunner } from './computeJob';

const TOOL = 'stackup_monte_carlo';
/** Native cap (`llull_stats::MAX_SAMPLES`, 2^40): chunk counts and the Chan merge products stay exact in f64. */
export const NATIVE_STACKUP_SAMPLES_CAP = 2 ** 40;
/** Default when `samples` is omitted: the first size above the TS cap that the native path exists for. */
export const NATIVE_STACKUP_DEFAULT_SAMPLES = 10_000_000;
const DEFAULT_TIMEOUT_S = 600;

export interface StackupNativeDeps {
  readonly runner: ComputeRunner;
  readonly env?: NodeJS.ProcessEnv;
}

export interface StackupNativeOptions {
  readonly timeoutS?: number;
  /** Also run the TypeScript sampler (samples ≤ 2e6 only) and report whether the statistics are identical. */
  readonly verify?: boolean;
}

function statsOf(value: unknown): (SamplingStats & { readonly threads: number }) | string {
  if (!isRecord(value)) return 'stats.json is not an object';
  const numeric = ['samples', 'mean', 'std', 'min', 'max', 'below', 'above', 'nonFinite', 'threads'] as const;
  for (const key of numeric) if (typeof value[key] !== 'number') return `stats.json has no numeric ${key}`;
  const n = (key: (typeof numeric)[number]): number => value[key] as number;
  return {
    samples: n('samples'),
    mean: n('mean'),
    std: n('std'),
    min: n('min'),
    max: n('max'),
    below: n('below'),
    above: n('above'),
    nonFinite: n('nonFinite'),
    threads: n('threads'),
  };
}

function verification(model: StackupModel, native: SamplingStats): Record<string, unknown> {
  if (model.samples > STACKUP_TS_SAMPLES_CAP) return { skipped: `samples above the TypeScript cap ${STACKUP_TS_SAMPLES_CAP}` };
  const started = Date.now();
  const reference = sampleStackup({
    contributors: sampledContributors(model),
    evaluate: programFunction(model.program),
    samples: model.samples,
    seed: model.seed,
    ...(model.params.lowerSpecLimit === undefined ? {} : { lowerSpecLimit: model.params.lowerSpecLimit }),
    ...(model.params.upperSpecLimit === undefined ? {} : { upperSpecLimit: model.params.upperSpecLimit }),
  });
  const keys = ['mean', 'std', 'min', 'max', 'below', 'above'] as const;
  return {
    referenceMs: Date.now() - started,
    identical: keys.every((key) => Object.is(reference[key], native[key])),
    largestRelativeDifference: Math.max(
      ...keys.map(
        (key) => Math.abs(reference[key] - native[key]) / Math.max(Math.abs(reference[key]), Math.abs(native[key]), Number.MIN_VALUE),
      ),
    ),
  };
}

/** stackup_monte_carlo: the analyze_stackup params (read from the registry, one schema) plus timeoutS and verify. */
export function stackupToolDefinition(): ToolDefinition {
  const schema = getCommand('analyze_stackup')?.paramsSchema ?? { type: 'object' as const, properties: {}, required: [] };
  return {
    name: TOOL,
    description:
      'analyze_stackup (same params, same data) with the Monte Carlo run by the native llull-compute binary (crate llull-stats, rayon): ' +
      `for samples above the 2000000 TypeScript cap, up to 2^40 (default ${NATIVE_STACKUP_DEFAULT_SAMPLES}). It draws the same ` +
      'Philox4x32-10 samples as analyze_stackup and reduces them in the same fixed order, so the numbers do not depend on the thread count ' +
      'and equal the TypeScript ones bit for bit for expressions without trigonometric functions (data.monteCarlo.bitExactWithTs). ' +
      'monteCarlo is always run; data.monteCarlo.engine "native", provenance { tool, version, threads, deterministic }. verify: true also ' +
      'runs the TypeScript sampler (samples <= 2000000) and reports the agreement. Without llull-compute: NATIVE_TOOL_MISSING.',
    inputSchema: {
      ...schema,
      properties: {
        ...schema.properties,
        timeoutS: {
          type: 'number',
          minimum: 1,
          maximum: 86400,
          description: 'Wall-clock limit of the native job in seconds (default 600).',
        },
        verify: { type: 'boolean', description: 'Also run the TypeScript sampler (samples <= 2000000) and compare. Default false.' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  };
}

/** Runs the transport with `timeoutS` / `verify` taken from the params. */
export function runStackupTool(params: unknown, host: FeaHost, deps: StackupNativeDeps): Promise<FeaToolResult> {
  const args = isRecord(params) ? params : {};
  const { timeoutS, verify, ...rest } = args;
  const options: StackupNativeOptions = {
    ...(typeof timeoutS === 'number' && Number.isFinite(timeoutS) ? { timeoutS } : {}),
    verify: verify === true,
  };
  return runStackupMonteCarlo(rest, options, host, deps);
}

/**
 * @failure invalid params -> CMD_INVALID_PARAMS; model refusals -> the GDT_* code of analyze_stackup; binary absent -> NATIVE_TOOL_MISSING
 *   (analyze_stackup still runs up to 2e6 samples); job error / timeout / protocol -> its code; non-finite samples -> GDT_STACKUP_NON_FINITE
 */
export async function runStackupMonteCarlo(
  params: unknown,
  options: StackupNativeOptions,
  host: FeaHost,
  deps: StackupNativeDeps,
): Promise<FeaToolResult> {
  const parsed = stackupParams.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return feaFailure(TOOL, 'CMD_INVALID_PARAMS', `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid params'}`);
  }
  const withDefaults = {
    ...parsed.data,
    methods: [...new Set([...(parsed.data.methods ?? ['worstCase', 'rss']), 'monteCarlo' as const])],
    samples: parsed.data.samples ?? NATIVE_STACKUP_DEFAULT_SAMPLES,
  };
  const model = resolveStackup(withDefaults, NATIVE_STACKUP_SAMPLES_CAP);
  if (isStackupRefusal(model)) return { ...feaFailure(TOOL, model.code, model.message), data: { code: model.code, paths: model.paths } };
  const seconds = Math.max(1, Math.min(86_400, options.timeoutS ?? DEFAULT_TIMEOUT_S));
  const outcome = await withJobFolder(
    { 'job.json': JSON.stringify(stackupJob(model)) },
    async (folder) => {
      const run = await deps.runner.run(['stats'], folder, seconds * 1000);
      if (!run.ok) return { run, stats: null };
      return { run, stats: statsOf(JSON.parse((await readOutput(folder, run, 'stats.json')).toString('utf8'))) };
    },
    deps.env,
  ).catch((error: unknown) => ({ run: null, stats: null, error: error instanceof Error ? error.message : String(error) }));
  if (outcome.run === null) return feaFailure(TOOL, 'NATIVE_PROTOCOL', 'error' in outcome ? outcome.error : 'job folder failure');
  const { run, stats } = outcome;
  if (stats === null) {
    const hint = run.code === 'NATIVE_TOOL_MISSING' ? ' analyze_stackup still samples up to 2000000 in TypeScript.' : '';
    return {
      ...feaFailure(TOOL, run.code ?? 'NATIVE_JOB_FAILED', `${run.message ?? 'llull-compute failed'}.${hint}`),
      data: { code: run.code, log: run.log.slice(-4000) },
    };
  }
  if (typeof stats === 'string') return feaFailure(TOOL, 'NATIVE_PROTOCOL', stats);
  if (stats.nonFinite > 0)
    return feaFailure(
      TOOL,
      'GDT_STACKUP_NON_FINITE',
      `${stats.nonFinite} of ${stats.samples} samples are not finite: check the expression and limits`,
    );
  const provenance = {
    tool: 'llull-compute stats',
    version: await deps.runner.version(),
    threads: stats.threads,
    deterministic: true,
    elapsedMs: run.elapsedMs,
  };
  const data = stackupData(model, host.getDoc().units, { stats, engine: 'native', provenance });
  const mc = data['monteCarlo'] as Record<string, unknown>;
  const checked = options.verify === true ? verification(model, stats) : undefined;
  return {
    summary:
      `stackup_monte_carlo: llull-compute sampled ${stats.samples} stacks on ${stats.threads} threads in ${run.elapsedMs} ms: ` +
      `mean ${Number(stats.mean.toPrecision(6))}, std ${Number(stats.std.toPrecision(6))}` +
      (mc['pBelowLowerLimit'] === undefined ? '' : `, P(y<L) ${String(mc['pBelowLowerLimit'])}`) +
      (mc['pAboveUpperLimit'] === undefined ? '' : `, P(y>U) ${String(mc['pAboveUpperLimit'])}`) +
      (checked === undefined ? '' : `; TypeScript check: ${checked['identical'] === true ? 'identical' : JSON.stringify(checked)}`) +
      '. Not approved: a qualified engineer must review.',
    affected: [],
    isError: false,
    data: { ...data, ...(checked === undefined ? {} : { verification: checked }) },
  };
}
