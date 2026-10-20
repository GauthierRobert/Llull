/**
 * `stackup_monte_carlo` transport (03 GDT M5n, TR-GDT-22, RS1 RS-7): the Monte Carlo of `analyze_stackup` above its 2e6-sample cap, run by
 * `llull-compute stats stackup` (crate `llull-stats`: Philox4x32-10 counter-based streams, fixed-order block reductions, rayon). The closed
 * forms, the contributor resolution (pmiId links, typed limits), the sensitivities and the spec-limit probabilities come from the registry
 * command itself, so this tool answers the same `data` shape plus the native `monteCarlo`; the document is never written.
 * The result is a pure function of (seed, samples, inputs): bit-identical for any thread count. It agrees with the TypeScript Monte Carlo
 * statistically (the §5.7 item 7 acceptance bounds), not bit for bit: another generator.
 */

import type { FeaHost, FeaToolResult } from '@protocol/index';
import { parseStackExpression } from '@lib/stackExpression';
import { probabilityAcceptance } from '@lib/stackup';
import { isRecord } from '@lib/isRecord';
import { feaFailure } from '../fea/feaCommon';
import { readOutput, withJobFolder, type ComputeRunner } from './computeJob';

const TOOL = 'stackup_monte_carlo';
const DEFAULT_SAMPLES = 10_000_000;
/** Mirrors `MAX_SAMPLES` of llull-stats. */
export const MAX_NATIVE_SAMPLES = 10_000_000_000;
const DEFAULT_SEED = 20_261_020;
const DEFAULT_TIMEOUT_S = 600;

export interface StackupDeps {
  readonly runner: ComputeRunner;
  readonly env?: NodeJS.ProcessEnv;
}

interface Resolved {
  readonly name: string;
  readonly nominal: number;
  readonly lower: number;
  readonly upper: number;
  readonly sensitivity: number;
  readonly distribution: 'normal' | 'uniform';
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The resolved contributors of an `analyze_stackup` answer, or null when its data is not the expected shape. */
function resolvedOf(data: unknown): { contributors: Resolved[]; mean: number; k: number } | null {
  if (!isRecord(data) || !Array.isArray(data['contributors']) || !finiteNumber(data['mean'])) return null;
  const sigma = data['sigmaPerHalfTolerance'];
  const k = isRecord(sigma) ? sigma['value'] : undefined;
  if (!finiteNumber(k)) return null;
  const contributors: Resolved[] = [];
  for (const entry of data['contributors']) {
    if (!isRecord(entry)) return null;
    const { name, nominal, lower, upper, sensitivity, distribution } = entry;
    if (
      typeof name !== 'string' ||
      !finiteNumber(nominal) ||
      !finiteNumber(lower) ||
      !finiteNumber(upper) ||
      !finiteNumber(sensitivity) ||
      (distribution !== 'normal' && distribution !== 'uniform')
    )
      return null;
    contributors.push({ name, nominal, lower, upper, sensitivity, distribution });
  }
  return { contributors, mean: data['mean'], k };
}

export interface StackupOptions {
  readonly samples?: number;
  readonly seed?: number;
  readonly timeoutS?: number;
}

/**
 * @failure invalid stack-up -> the GDT_* refusal of analyze_stackup; samples outside 1..1e10 -> GDT_STACKUP_SAMPLES; binary absent -> NATIVE_TOOL_MISSING
 *   (analyze_stackup keeps its 2e6-sample TypeScript Monte Carlo); timeout / job error / protocol or output hash problem -> NATIVE_TIMEOUT / the job code / NATIVE_PROTOCOL
 */
export async function runStackupMonteCarlo(
  stack: Readonly<Record<string, unknown>>,
  options: StackupOptions,
  host: FeaHost,
  deps: StackupDeps,
): Promise<FeaToolResult> {
  const samples = options.samples ?? DEFAULT_SAMPLES;
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_NATIVE_SAMPLES)
    return feaFailure(
      TOOL,
      'GDT_STACKUP_SAMPLES',
      `samples must be an integer from 1 to ${MAX_NATIVE_SAMPLES}, got ${String(options.samples)}`,
    );
  const seed = options.seed ?? DEFAULT_SEED;
  if (!Number.isInteger(seed)) return feaFailure(TOOL, 'GDT_STACKUP_SAMPLES', `seed must be an integer, got ${String(options.seed)}`);
  const analysis = host.applyCommand('analyze_stackup', { ...stack, methods: ['worstCase', 'rss'], samples: undefined, seed: undefined });
  if (analysis.isError) return { ...analysis, summary: `${TOOL}: ${analysis.summary}` };
  const resolved = resolvedOf(analysis.data);
  if (resolved === null) return feaFailure(TOOL, 'GDT_STACKUP_INVALID', 'analyze_stackup answered no contributor table');
  const { contributors, k } = resolved;
  const expression = typeof stack['expression'] === 'string' ? stack['expression'] : undefined;
  let model: Record<string, unknown>;
  if (expression === undefined) model = { kind: 'linear', sensitivities: contributors.map((c) => c.sensitivity) };
  else {
    const parsed = parseStackExpression(
      expression,
      contributors.map((c) => c.name),
    );
    if (!parsed.ok) return feaFailure(TOOL, 'GDT_STACKUP_EXPRESSION', parsed.error);
    model = { kind: 'expression', tree: parsed.tree };
  }
  const lower = finiteNumber(stack['lowerSpecLimit']) ? stack['lowerSpecLimit'] : undefined;
  const upper = finiteNumber(stack['upperSpecLimit']) ? stack['upperSpecLimit'] : undefined;
  const job = {
    seed,
    samples,
    contributors: contributors.map((c) => {
      const half = (c.upper - c.lower) / 2;
      return {
        centre: c.nominal + (c.lower + c.upper) / 2,
        spread: c.distribution === 'normal' ? half / k : half,
        normal: c.distribution === 'normal',
      };
    }),
    model,
    ...(lower === undefined ? {} : { lower }),
    ...(upper === undefined ? {} : { upper }),
  };
  const seconds = Math.max(1, Math.min(86_400, options.timeoutS ?? DEFAULT_TIMEOUT_S));
  const outcome = await withJobFolder(
    { 'job.json': JSON.stringify(job) },
    async (folder) => {
      const run = await deps.runner.run(['stats', 'stackup'], folder, seconds * 1000);
      return { run, result: run.ok ? (JSON.parse((await readOutput(folder, run, 'result.json')).toString('utf8')) as unknown) : null };
    },
    deps.env,
  ).catch((error: unknown) => ({ run: null, result: null, error: error instanceof Error ? error.message : String(error) }));
  if (outcome.run === null) return feaFailure(TOOL, 'NATIVE_PROTOCOL', 'error' in outcome ? outcome.error : 'job folder failure');
  const { run, result } = outcome;
  if (!isRecord(result)) {
    const fallback = run.code === 'NATIVE_TOOL_MISSING' ? ' analyze_stackup still runs up to 2000000 samples in TypeScript.' : '';
    return {
      ...feaFailure(TOOL, run.code ?? 'NATIVE_JOB_FAILED', `${run.message ?? 'llull-compute failed'}.${fallback}`),
      data: { code: run.code, log: run.log.slice(-4000) },
    };
  }
  const { counted, mean, std, min, max, below, above, prng, nonFinite } = result as Record<string, unknown>;
  if (!finiteNumber(counted) || !finiteNumber(mean) || !finiteNumber(std) || !finiteNumber(min) || !finiteNumber(max))
    return feaFailure(TOOL, 'NATIVE_PROTOCOL', 'the job answered an incomplete result');
  const data = isRecord(analysis.data) ? analysis.data : {};
  const sigma = finiteNumber(data['sigma']) ? data['sigma'] : 0;
  const exactBelow = finiteNumber(data['pBelow']) ? data['pBelow'] : null;
  const exactAbove = finiteNumber(data['pAbove']) ? data['pAbove'] : null;
  const pBelow = lower !== undefined && finiteNumber(below) ? below / counted : undefined;
  const pAbove = upper !== undefined && finiteNumber(above) ? above / counted : undefined;
  const monteCarlo = {
    seed,
    samples,
    prng,
    engine: 'native-cpu',
    deterministic: true,
    nonFinite: finiteNumber(nonFinite) ? nonFinite : 0,
    elapsedMs: run.elapsedMs,
    mean,
    std,
    min,
    max,
    ...(pBelow === undefined ? {} : { pBelow }),
    ...(pAbove === undefined ? {} : { pAbove }),
    acceptance: {
      mean: (5 * sigma) / Math.sqrt(counted),
      std: (5 * sigma) / Math.sqrt(2 * counted),
      ...(pBelow !== undefined && exactBelow !== null ? { pBelow: probabilityAcceptance(exactBelow, counted) } : {}),
      ...(pAbove !== undefined && exactAbove !== null ? { pAbove: probabilityAcceptance(exactAbove, counted) } : {}),
    },
  };
  const fmt = (value: number): string => String(Number(value.toPrecision(9)));
  return {
    summary:
      `${TOOL}: ${samples} samples in ${run.elapsedMs} ms (native, seed ${seed}): mean ${fmt(mean)}, std ${fmt(std)}, range [${fmt(min)}, ${fmt(max)}]` +
      `${pBelow === undefined ? '' : `, P(below) ${fmt(pBelow)}`}${pAbove === undefined ? '' : `, P(above) ${fmt(pAbove)}`}. ${analysis.summary}`,
    affected: [],
    isError: false,
    data: { ...data, monteCarlo },
  };
}
