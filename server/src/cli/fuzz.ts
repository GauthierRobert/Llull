/**
 * `llull fuzz` / `llull fuzz-one` (SC-Q3): the CLI host of the robustness fuzz in `@protocol/fuzz`. Runs seeded designs on the local
 * kernel (in-process; `--jobs J` splits the range over J child CLI processes), writes the failing plans and a JSON report. Parsing,
 * files and processes only: generation, checks and minimisation live in the protocol package.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { getGeometryKernel } from '@core/geometry/kernel';
import { fuzzPlan, generateFuzzCase, MAX_FUZZ_FEATURES, type FuzzOptions } from '@protocol/fuzz/generator';
import { generateBooleanPair } from '@protocol/fuzz/identities';
import { minimiseFuzzCase } from '@protocol/fuzz/minimise';
import { kindsForKernel, runFuzzSeed, summariseFuzz, type SeedReport } from '@protocol/fuzz/session';
import { FUZZ_FEATURE_KINDS, type FuzzFailure, type FuzzFeatureKind } from '@protocol/fuzz/types';
import { booleanFlag, stringFlag, type ParsedArgv } from './argv';

/** The slice of the CLI I/O port the fuzz needs (structurally a `CliIo`). */
export interface FuzzIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly prepareKernel: () => Promise<void>;
  readonly now?: () => number;
  /** Run one worker CLI (`llull fuzz …` args); default: this CLI script in a child node process. */
  readonly runWorker?: (args: readonly string[]) => Promise<number>;
}

export class FuzzUsageError extends Error {}

export interface FuzzReportFile {
  readonly kernel: string;
  readonly kinds: readonly FuzzFeatureKind[];
  readonly from: number;
  readonly count: number;
  readonly summary: ReturnType<typeof summariseFuzz>;
  readonly failures: readonly SeedReport[];
  readonly seeds: readonly { readonly seed: number; readonly ok: boolean; readonly steps: number; readonly durationMs: number }[];
}

function integerFlag(args: ParsedArgv, name: string, fallback: number, min: number): number {
  const raw = stringFlag(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new FuzzUsageError(`--${name} needs an integer >= ${min} (got "${raw}").`);
  return value;
}

function kindsOf(args: ParsedArgv): FuzzFeatureKind[] {
  const supported = kindsForKernel(getGeometryKernel());
  const raw = stringFlag(args, 'kinds');
  if (raw === undefined) return supported;
  const wanted = raw.split(',').map((kind) => kind.trim());
  const unknown = wanted.filter((kind) => !(FUZZ_FEATURE_KINDS as readonly string[]).includes(kind));
  if (unknown.length > 0) throw new FuzzUsageError(`unknown --kinds ${unknown.join(', ')}; known: ${FUZZ_FEATURE_KINDS.join(', ')}.`);
  return supported.filter((kind) => wanted.includes(kind));
}

function optionsOf(args: ParsedArgv): FuzzOptions {
  return { kinds: kindsOf(args), maxFeatures: integerFlag(args, 'max-steps', MAX_FUZZ_FEATURES, 1) };
}

const failureText = (failure: FuzzFailure): string =>
  `${failure.step >= 0 ? `step ${failure.step} ` : ''}(${failure.kind}) ${failure.check}: ${failure.message}`;

function seedLine(report: SeedReport): string {
  if (report.ok) return `seed ${report.seed}: ok (${report.design.steps.length} steps, ${report.durationMs} ms)`;
  const failures = [report.design.failure, report.identity.failure].filter((f): f is FuzzFailure => f !== undefined);
  return `seed ${report.seed}: FAIL ${failures.map(failureText).join('; ')}`;
}

/** Write the failing plan(s) of one seed into `dir`: the design plan up to the failing step, and the identity pair. */
function writeFailingPlans(dir: string, report: SeedReport, options: FuzzOptions): void {
  fs.mkdirSync(dir, { recursive: true });
  const failure = report.design.failure;
  if (failure !== undefined) {
    const steps = generateFuzzCase(report.seed, options).steps.slice(0, failure.step + 1);
    fs.writeFileSync(path.join(dir, `seed-${report.seed}.plan.json`), `${JSON.stringify(fuzzPlan(steps), null, 2)}\n`);
  }
  if (report.identity.failure !== undefined)
    fs.writeFileSync(
      path.join(dir, `seed-${report.seed}.identity.plan.json`),
      `${JSON.stringify({ actions: generateBooleanPair(report.seed).actions }, null, 2)}\n`,
    );
}

function reportFile(kernel: string, options: FuzzOptions, from: number, reports: readonly SeedReport[]): FuzzReportFile {
  return {
    kernel,
    kinds: options.kinds ?? [],
    from,
    count: reports.length,
    summary: summariseFuzz(reports),
    failures: reports.filter((r) => !r.ok),
    seeds: reports.map((r) => ({ seed: r.seed, ok: r.ok, steps: r.design.steps.length, durationMs: r.durationMs })),
  };
}

function defaultWorker(args: readonly string[]): Promise<number> {
  const script = process.argv[1];
  if (script === undefined) return Promise.resolve(2);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(2));
  });
}

/** Split [from, from+count) into `jobs` workers, each writing a partial report; merge them. */
async function runJobs(
  args: ParsedArgv,
  io: FuzzIo,
  range: { readonly from: number; readonly count: number; readonly jobs: number },
  kernel: string,
  options: FuzzOptions,
): Promise<FuzzReportFile> {
  const { from, count, jobs } = range;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-fuzz-'));
  try {
    const per = Math.ceil(count / jobs);
    const ranges = Array.from({ length: jobs }, (_, k) => ({ from: from + k * per, count: Math.min(per, count - k * per) })).filter(
      (range) => range.count > 0,
    );
    const passThrough = ['out', 'kinds', 'max-steps', 'kernel'].flatMap((name) => {
      const value = stringFlag(args, name);
      return value === undefined ? [] : [`--${name}`, value];
    });
    const files = ranges.map((_, k) => path.join(scratch, `part-${k}.json`));
    await Promise.all(
      ranges.map((range, k) =>
        (io.runWorker ?? defaultWorker)([
          'fuzz',
          '--from',
          String(range.from),
          '--count',
          String(range.count),
          '--jobs',
          '1',
          '--report',
          files[k] ?? '',
          '--quiet',
          ...passThrough,
        ]),
      ),
    );
    const parts = files.map((file) => {
      if (!fs.existsSync(file)) throw new FuzzUsageError(`a fuzz worker wrote no report (${file}); run with --jobs 1 to see why.`);
      return JSON.parse(fs.readFileSync(file, 'utf8')) as FuzzReportFile;
    });
    const failures = parts.flatMap((part) => part.failures).sort((a, b) => a.seed - b.seed);
    const seeds = parts.flatMap((part) => part.seeds).sort((a, b) => a.seed - b.seed);
    const summary = summariseFuzz(failures);
    return {
      kernel: parts[0]?.kernel ?? kernel,
      kinds: options.kinds ?? [],
      from,
      count,
      summary: { ...summary, seeds: seeds.length, passed: seeds.length - summary.failed },
      failures,
      seeds,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** `llull fuzz --from N --count K --jobs J --out DIR --report FILE [--kinds a,b] [--max-steps M]` — exit 1 when a seed fails. */
export async function fuzzCli(args: ParsedArgv, io: FuzzIo): Promise<number> {
  const from = integerFlag(args, 'from', 1, 0);
  const count = integerFlag(args, 'count', 100, 1);
  const jobs = integerFlag(args, 'jobs', 1, 1);
  await io.prepareKernel();
  const kernel = getGeometryKernel();
  const options = optionsOf(args);
  const quiet = booleanFlag(args, 'quiet');
  const out = stringFlag(args, 'out');
  const kernelName = kernel?.name ?? 'none';
  let file: FuzzReportFile;
  if (jobs > 1 && count > 1) file = await runJobs(args, io, { from, count, jobs: Math.min(jobs, count) }, kernelName, options);
  else {
    const reports: SeedReport[] = [];
    for (let seed = from; seed < from + count; seed++) {
      const report = runFuzzSeed(seed, options, io.now);
      reports.push(report);
      if (!quiet && !booleanFlag(args, 'json')) io.stdout(seedLine(report));
      if (!report.ok && out !== undefined) writeFailingPlans(out, report, options);
    }
    file = reportFile(kernelName, options, from, reports);
  }
  const reportPath = stringFlag(args, 'report');
  if (reportPath !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(file, null, 2)}\n`);
  }
  const { summary } = file;
  if (booleanFlag(args, 'json')) io.stdout(JSON.stringify(file));
  else if (!quiet)
    io.stdout(
      `fuzz: ${summary.passed}/${summary.seeds} seeds passed on the ${file.kernel} kernel (kinds: ${file.kinds.join(', ')}); ` +
        `${summary.designFailures} design and ${summary.identityFailures} boolean-identity failure(s)` +
        `${summary.failed > 0 && out !== undefined ? `; failing plans in ${out}` : ''}. Minimise one: llull fuzz-one <seed> --minimise`,
    );
  return summary.failed > 0 ? 1 : 0;
}

/** `llull fuzz-one <seed> [--minimise] [--out FILE] [--json]` — run one seed; with --minimise, delta-debug its failing design plan. */
export async function fuzzOneCli(args: ParsedArgv, io: FuzzIo): Promise<number> {
  const minimiseFlag = args.flags['minimise'] ?? args.flags['minimize'];
  const raw = args.positionals[1] ?? (typeof minimiseFlag === 'string' ? minimiseFlag : undefined);
  const seed = Number(raw);
  if (raw === undefined || !Number.isInteger(seed) || seed < 0)
    throw new FuzzUsageError('fuzz-one needs a seed: llull fuzz-one 42 [--minimise]');
  await io.prepareKernel();
  const options = optionsOf(args);
  const report = runFuzzSeed(seed, options, io.now);
  const minimise = minimiseFlag !== undefined && minimiseFlag !== 'false';
  const fuzzCase = generateFuzzCase(seed, options);
  const minimised = minimise && !report.design.ok ? minimiseFuzzCase(fuzzCase) : null;
  const failing = report.design.failure;
  const steps = minimised?.steps ?? (failing !== undefined ? fuzzCase.steps.slice(0, failing.step + 1) : fuzzCase.steps);
  const plan = fuzzPlan(steps);
  const out = stringFlag(args, 'out');
  if (out !== undefined) fs.writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
  if (booleanFlag(args, 'json')) {
    io.stdout(JSON.stringify({ report, ...(minimised !== null ? { minimised } : {}), plan }));
    return report.ok ? 0 : 1;
  }
  const lines = [
    seedLine(report),
    ...report.design.steps.map(
      (s) =>
        `  [${s.step}] ${s.kind.padEnd(7)} ${s.ok ? 'ok  ' : 'FAIL'} ${s.label}${s.volume !== undefined ? `  V=${s.volume.toFixed(3)}` : ''}`,
    ),
    `  identity: ${report.identity.ok ? 'ok' : 'FAIL'} ${report.identity.label}`,
  ];
  if (minimised !== null)
    lines.push(
      `minimised to ${minimised.steps.length} of ${fuzzCase.steps.length} steps in ${minimised.tests} runs: ${failureText(minimised.failure)}`,
      ...minimised.steps.map((s) => `  - ${s.kind}: ${s.label}`),
    );
  else if (minimise && report.design.ok) lines.push('nothing to minimise: the design passes.');
  if (out !== undefined) lines.push(`plan written to ${out} (replay: llull run ${out} --doc repro.llull.json)`);
  else if (minimised !== null) lines.push(JSON.stringify(plan, null, 2));
  io.stdout(lines.join('\n'));
  return report.ok ? 0 : 1;
}
