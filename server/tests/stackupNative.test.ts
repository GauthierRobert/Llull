/**
 * stackup_monte_carlo transport (03 GDT M5n, VC-GDT-37) with the real `llull-compute stats` when it is built (cargo build --release in
 * solver/, or LLULL_COMPUTE), else skipped with a logged reason; the missing-binary and refusal paths always run.
 * Native vs the analytic reference (stackup_reference.json, SU-01..05) inside the 5-sigma acceptance bounds, native vs the TypeScript Monte Carlo,
 * and bit-identical results on 1 and 4 threads.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { createEmptyDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runNativeTool } from '../src/native/tools';
import { exchangeTool } from '../src/cli/exchange';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('stackupNative: llull-compute not built (cargo build --release in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

const PACK = path.resolve(__dirname, '../../docs/aerospace/03-gdt-mbd-pmi/validation');
interface Reference {
  readonly id: string;
  readonly expression: string;
  readonly contributors: { name: string; nominal: number; lower: number; upper: number; distribution?: string; sensitivity: number }[];
  readonly analytic: { yMean: number; sigma: number; lowerSpecLimit?: number; pBelowLowerLimit?: number };
}
const stackups = (JSON.parse(readFileSync(path.join(PACK, 'stackup_reference.json'), 'utf8')) as { stackups: Reference[] }).stackups;
const reference = (id: string): Reference => stackups.find((entry) => entry.id === id) as Reference;

const doc = createEmptyDocument();
const host: FeaHost = {
  getDoc: () => doc,
  applyCommand: (name, params) => {
    const result = execute(doc, name, params, defaultContext());
    return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
  },
};

const typed = (s: Reference): unknown[] =>
  s.contributors.map(({ name, nominal, lower, upper, distribution }) => ({
    name,
    nominal,
    lower,
    upper,
    ...(distribution === undefined ? {} : { distribution }),
    verified: true,
  }));
const linear = (s: Reference): unknown[] =>
  s.contributors.map(({ name, nominal, lower, upper, distribution, sensitivity }) => ({
    name,
    nominal,
    lower,
    upper,
    sensitivity,
    ...(distribution === undefined ? {} : { distribution }),
    verified: true,
  }));

interface McData {
  monteCarlo: {
    seed: number;
    samples: number;
    engine: string;
    deterministic: boolean;
    mean: number;
    std: number;
    min: number;
    max: number;
    pBelow?: number;
    elapsedMs: number;
    acceptance: { mean: number; std: number; pBelow?: number };
  };
  pBelow: number | null;
  worstCase: { min: number; max: number };
}

async function monteCarlo(
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ isError: boolean; summary: string; data: McData }> {
  const outcome = await runNativeTool('stackup_monte_carlo', params, host, { store: null as never, runner: createComputeRunner(env), env });
  return outcome as unknown as { isError: boolean; summary: string; data: McData };
}

const SAMPLES = 4_000_000;

describe('stackup_monte_carlo: native Monte Carlo above the TypeScript cap', () => {
  native(
    'SU-01 / SU-02 / SU-03 / SU-04 agree with the analytic reference within the acceptance bounds (VC-GDT-37)',
    async () => {
      for (const [id, expression] of [
        ['SU-01', true],
        ['SU-02', true],
        ['SU-03', false],
        ['SU-04', false],
      ] as const) {
        const s = reference(id);
        const lower = s.analytic.lowerSpecLimit;
        const result = await monteCarlo({
          contributors: expression ? typed(s) : linear(s),
          ...(expression ? { expression: s.expression.split('=')[1]?.trim() } : {}),
          ...(lower === undefined ? {} : { lowerSpecLimit: lower }),
          samples: SAMPLES,
          seed: 20261015,
        });
        expect(result.isError, `${id}: ${result.summary}`).toBe(false);
        const mc = result.data.monteCarlo;
        expect(mc).toMatchObject({ samples: SAMPLES, seed: 20261015, engine: 'native-cpu', deterministic: true });
        expect(Math.abs(mc.mean - s.analytic.yMean), `${id} mean`).toBeLessThan(mc.acceptance.mean);
        expect(Math.abs(mc.std - s.analytic.sigma), `${id} std`).toBeLessThan(mc.acceptance.std);
        if (id === 'SU-02') expect(mc.min).toBeGreaterThanOrEqual(result.data.worstCase.min - 1e-9);
        if (id === 'SU-02') expect(mc.max).toBeLessThanOrEqual(result.data.worstCase.max + 1e-9);
        if (lower !== undefined && s.analytic.pBelowLowerLimit !== undefined && result.data.pBelow !== null) {
          expect(Math.abs((mc.pBelow ?? 0) - s.analytic.pBelowLowerLimit), `${id} pBelow`).toBeLessThan(mc.acceptance.pBelow ?? 0);
        }
      }
    },
    300_000,
  );

  native(
    'SU-05 (non-linear, expression tree in Rust) agrees with the TypeScript Monte Carlo of analyze_stackup',
    async () => {
      const s = reference('SU-05');
      const expression = s.expression.split('=')[1]?.trim();
      const typedStack = { contributors: typed(s), expression, seed: 7 };
      const nativeResult = await monteCarlo({ ...typedStack, samples: SAMPLES });
      const ts = execute(doc, 'analyze_stackup', { ...typedStack, methods: ['monteCarlo'], samples: 2_000_000 }).data as McData;
      const [a, b] = [nativeResult.data.monteCarlo, ts.monteCarlo];
      expect(Math.abs(a.mean - b.mean)).toBeLessThan(a.acceptance.mean + b.acceptance.mean);
      expect(Math.abs(a.std - b.std)).toBeLessThan(a.acceptance.std + b.acceptance.std);
    },
    300_000,
  );

  native(
    'the same seed gives identical results on 1 and 4 threads, another seed another stream',
    async () => {
      const s = reference('SU-04');
      const params = { contributors: linear(s), samples: 1_000_003, seed: 99 };
      const strip = (data: McData): unknown => ({ ...data.monteCarlo, elapsedMs: 0 });
      const one = await monteCarlo(params, { ...process.env, RAYON_NUM_THREADS: '1' });
      const four = await monteCarlo(params, { ...process.env, RAYON_NUM_THREADS: '4' });
      expect(strip(four.data)).toEqual(strip(one.data));
      const other = await monteCarlo({ ...params, seed: 100 }, { ...process.env, RAYON_NUM_THREADS: '4' });
      expect(other.data.monteCarlo.mean).not.toBe(one.data.monteCarlo.mean);
    },
    300_000,
  );

  native('refuses a bad stack with the analyze_stackup code and a bad sample count with its own', async () => {
    const s = reference('SU-03');
    const twin = await monteCarlo({ contributors: [...linear(s), ...linear(s)] });
    expect(twin.isError).toBe(true);
    expect(twin.summary).toContain('contributor names must be unique');
    for (const samples of [0, 1.5, 1e11]) {
      const refused = await monteCarlo({ contributors: linear(s), samples });
      expect(refused.isError).toBe(true);
      expect(refused.summary).toContain('GDT_STACKUP_SAMPLES');
    }
  });

  it('without llull-compute it answers NATIVE_TOOL_MISSING and says analyze_stackup still runs in TypeScript', async () => {
    const env = { ...process.env, LLULL_COMPUTE: path.join(__dirname, 'does-not-exist') };
    const outcome = await runNativeTool('stackup_monte_carlo', { contributors: linear(reference('SU-03')), samples: 10 }, host, {
      store: null as never,
      runner: createComputeRunner(env, null),
      env,
    });
    expect(outcome).toMatchObject({ isError: true, changed: false, data: { code: 'NATIVE_TOOL_MISSING' } });
    expect(outcome?.summary).toContain('analyze_stackup still runs up to 2000000 samples');
  });

  it('is a CLI tool carrying the analyze_stackup schema with the native sample range', () => {
    const tool = exchangeTool('stackup_monte_carlo');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true });
    const properties = tool?.inputSchema.properties as Record<string, { maximum?: number }>;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['contributors', 'expression', 'lowerSpecLimit', 'samples', 'seed', 'timeoutS']),
    );
    expect(properties['methods']).toBeUndefined();
    expect(properties['samples']?.maximum).toBe(10_000_000_000);
  });
});
