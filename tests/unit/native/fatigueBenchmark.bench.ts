/**
 * PHY-07 §8 / §13 benchmark of the all-node fatigue job (not in the default test run: `*.bench.ts` matches no suite glob; own config).
 * Builds the reference case (51 612 nodes = cells 43 x 50 x 22, 2 load cases, 10 000 steps, signed von Mises, Basquin + Goodman), times the
 * TS job builder, `llull-compute post fatigue` on every node and the TS reference on a node sample, and checks the sample bit for bit.
 *
 *   cargo build --profile compute --manifest-path solver/Cargo.toml -p llull-compute
 *   npx vitest run -c tests/unit/native/fatigueBenchmark.config.ts
 *
 * Environment: LLULL_BENCH_CELLS=43,50,22 · LLULL_BENCH_STEPS=10000 · LLULL_BENCH_SAMPLE=200 (TS nodes) · LLULL_BENCH_MEASURE=max_principal
 * · LLULL_BENCH_SINGLE=1 (also time one thread) · LLULL_BENCH_DIR=<folder> (keep the job folder to re-time the binary alone) · LLULL_COMPUTE=<binary> · RAYON_NUM_THREADS.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { damageOf, isEvaluationFailure } from '@cae/fatigue/evaluate';
import { cyclesOfNode, FIELD_COMPONENTS, FLAG_BITS, fatigueFieldInput } from '@cae/fatigue/feField';
import { feFatigue } from '../cae/fatigue/feFixtures';

const env = process.env;
const cells = (env['LLULL_BENCH_CELLS'] ?? '43,50,22').split(',').map(Number) as [number, number, number];
const steps = Number(env['LLULL_BENCH_STEPS'] ?? 10_000);
const sample = Number(env['LLULL_BENCH_SAMPLE'] ?? 200);
const measure = env['LLULL_BENCH_MEASURE'];
const binary = env['LLULL_COMPUTE'] ?? path.resolve(__dirname, '../../../solver/target/compute/llull-compute');

function seconds(started: number): string {
  return `${((performance.now() - started) / 1000).toFixed(2)} s`;
}

function run(): void {
  if (!existsSync(binary)) throw new Error(`${binary} not built: cargo build --profile compute -p llull-compute in solver/`);
  let started = performance.now();
  const fixture = feFatigue({ cells, steps, seed: 11, ...(measure !== undefined ? { caseParams: { measure } } : {}) });
  const fixtureTime = seconds(started);
  started = performance.now();
  const input = fatigueFieldInput(fixture.doc, fixture.caseId, fixture.store);
  if (isEvaluationFailure(input)) throw new Error(input.message);
  const buildTime = seconds(started);
  const keep = env['LLULL_BENCH_DIR'];
  const folder = keep ?? mkdtempSync(path.join(tmpdir(), 'llull-fatigue-bench-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'job.json'), JSON.stringify(input.job));
  writeFileSync(path.join(folder, 'tensors.f64'), new Uint8Array(input.tensors.buffer, input.tensors.byteOffset, input.tensors.byteLength));
  const timeNative = (threads?: string): string => {
    const begin = performance.now();
    const childEnv = threads === undefined ? env : { ...env, RAYON_NUM_THREADS: threads };
    execFileSync(binary, ['post', 'fatigue', folder], { stdio: ['ignore', 'ignore', 'inherit'], env: childEnv });
    return seconds(begin);
  };
  const nativeTime = timeNative();
  const singleTime = env['LLULL_BENCH_SINGLE'] === '1' ? timeNative('1') : 'not run (LLULL_BENCH_SINGLE=1)';
  const bytes = readFileSync(path.join(folder, 'field.f64'));
  const field = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (keep === undefined) rmSync(folder, { recursive: true, force: true });
  const width = FIELD_COMPONENTS.length;
  const stride = Math.max(1, Math.floor(input.nodeIds.length / Math.max(1, sample)));
  let mismatches = 0;
  let checked = 0;
  started = performance.now();
  for (let index = 0; index < input.nodeIds.length && checked < sample; index += stride, checked += 1) {
    const sum = damageOf(cyclesOfNode(input, index), input.damage);
    let flags = sum.extrapolated ? FLAG_BITS.extrapolated : 0;
    for (const flag of sum.flags) flags |= FLAG_BITS[flag];
    const wanted = [sum.damage, sum.cyclesCounted, sum.maxEquivalentAmplitude, flags];
    const got = (c: number): number => field[index * width + c] ?? Number.NaN;
    if (wanted.some((value, c) => value !== got(c) && !(Number.isNaN(value) && Number.isNaN(got(c))))) mismatches += 1;
  }
  const tsPerNodeMs = (performance.now() - started) / Math.max(1, checked);
  process.stderr.write(
    `${[
      `fatigue benchmark: ${input.nodeIds.length} nodes x ${input.job.loadCases} load cases x ${steps} steps, measure ${input.job.measure.kind}`,
      `  fixture ${fixtureTime} · job input (TS) ${buildTime} · llull-compute ${nativeTime} (${cpus().length} CPUs, load ${loadavg()[0]?.toFixed(1)}) · 1 thread ${singleTime}`,
      `  TS reference ${tsPerNodeMs.toFixed(2)} ms/node on ${checked} nodes (all nodes ≈ ${((tsPerNodeMs * input.nodeIds.length) / 1000).toFixed(0)} s)`,
      `  native vs TS on the sample: ${mismatches === 0 ? 'bit-identical' : `${mismatches} nodes differ`}`,
    ].join('\n')}\n`,
  );
  if (mismatches > 0) throw new Error(`native and TS differ on ${mismatches} sampled nodes`);
}

it('fatigue_field all-node job (PHY-07 §8)', run, 3_600_000);
