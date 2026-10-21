/**
 * stackup_monte_carlo (GDT TR-GDT-22, VC-GDT-37) with the real `llull-compute` when it is built (cargo build --release -p llull-compute in
 * solver/), else skipped with a logged reason; the missing-binary and refusal paths always run. Native vs TypeScript: bit-identical on the
 * linear SU-01..04 stacks, within the §5.7 acceptance bounds on the trigonometric SU-05, independent of the thread count.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaHost } from '@protocol/index';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { runStackupMonteCarlo } from '../src/native/stackupMonteCarlo';
import { isNativeTool, runNativeTool } from '../src/native/tools';
import { buildNativeToolDefinitions } from '@protocol/nativeTools';
import reference from '../../docs/aerospace/03-gdt-mbd-pmi/validation/stackup_reference.json';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('stackupNative: llull-compute not built (cargo build --release -p llull-compute in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;

const doc = createEmptyDocument();
const host: FeaHost = {
  getDoc: (): CadDocument => doc,
  applyCommand: (name, params) => {
    const result = execute(doc, name, params);
    return { summary: result.summary, affected: result.affected, isError: result.rejected === true, data: result.data };
  },
};

type Case = (typeof reference.stackups)[number];
const su = (id: string): Case => reference.stackups.find((s) => s.id === id) as Case;

function paramsOf(stack: Case, samples: number): Record<string, unknown> {
  const contributors = stack.contributors.map((c) => ({
    name: c.name,
    nominal: c.nominal,
    upper: c.upper,
    lower: c.lower,
    ...(stack.id === 'SU-05' ? {} : { sensitivity: c.sensitivity }),
    ...('distribution' in c ? { distribution: c.distribution } : {}),
  }));
  return {
    contributors,
    ...(stack.id === 'SU-05' ? { expression: stack.expression } : {}),
    ...('lowerSpecLimit' in stack.analytic ? { lowerSpecLimit: stack.analytic.lowerSpecLimit } : {}),
    methods: ['worstCase', 'rss', 'monteCarlo'],
    samples,
    seed: stack.monteCarlo.seed,
  };
}

interface MonteCarlo {
  engine: string;
  samples: number;
  mean: number;
  std: number;
  min: number;
  max: number;
  pBelowLowerLimit?: number;
  bitExactWithTs: boolean;
  acceptance: { meanTolerance: number; stdTolerance: number; pTolerance: number | null };
  provenance?: { tool: string; threads: number; deterministic: boolean };
}
const monteCarloOf = (data: unknown): MonteCarlo => (data as { monteCarlo: MonteCarlo }).monteCarlo;

describe('stackup_monte_carlo transport', () => {
  it('is a native tool whose schema is analyze_stackup plus timeoutS / verify', () => {
    expect(isNativeTool('stackup_monte_carlo')).toBe(true);
    const tool = buildNativeToolDefinitions().find((definition) => definition.name === 'stackup_monte_carlo');
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['contributors', 'expression', 'samples', 'timeoutS', 'verify']),
    );
  });

  it('without the binary answers NATIVE_TOOL_MISSING (analyze_stackup still works up to 2e6)', async () => {
    const result = await runStackupMonteCarlo(paramsOf(su('SU-01'), 3_000_000), {}, host, { runner: createComputeRunner({}, null) });
    expect(result).toMatchObject({ isError: true, data: { code: 'NATIVE_TOOL_MISSING' } });
    expect(result.summary).toContain('analyze_stackup still samples up to 2000000');
  });

  it('refuses invalid params and model errors before running anything', async () => {
    const runner = createComputeRunner({}, null);
    const invalid = await runStackupMonteCarlo({ contributors: 'x' }, {}, host, { runner });
    expect(invalid).toMatchObject({ isError: true, data: { code: 'CMD_INVALID_PARAMS' } });
    const tooMany = await runStackupMonteCarlo(paramsOf(su('SU-01'), 2 ** 41), {}, host, { runner });
    expect(tooMany).toMatchObject({ isError: true, data: { code: 'GDT_STACKUP_SAMPLES_CAP', paths: ['samples'] } });
    const ghost = await runStackupMonteCarlo({ contributors: [{ name: 'x', pmiId: 'ghost', sensitivity: 1 }] }, {}, host, { runner });
    expect(ghost).toMatchObject({ isError: true, data: { code: 'GDT_PMI_UNKNOWN' } });
    const outcome = await runNativeTool('stackup_monte_carlo', { contributors: [] }, host, { runner, store: undefined as never });
    expect(outcome).toMatchObject({ isError: true, changed: false });
  });

  native.each(['SU-01', 'SU-02', 'SU-03', 'SU-04'])(
    '%s: native statistics are bit-identical to analyze_stackup at 200000 samples (VC-GDT-37)',
    async (id) => {
      const params = paramsOf(su(id), 200_000);
      const result = await runStackupMonteCarlo(params, { verify: true }, host, { runner: createComputeRunner({}, BINARY) });
      expect(result.isError, result.summary).toBe(false);
      const nativeRun = monteCarloOf(result.data);
      const ts = monteCarloOf(execute(doc, 'analyze_stackup', params).data);
      expect(nativeRun).toMatchObject({
        engine: 'native',
        bitExactWithTs: true,
        provenance: { tool: 'llull-compute stats', deterministic: true },
      });
      for (const key of ['mean', 'std', 'min', 'max', 'pBelowLowerLimit'] as const)
        expect(Object.is(nativeRun[key], ts[key]), key).toBe(true);
      expect((result.data as { verification: { identical: boolean } }).verification.identical).toBe(true);
    },
    120_000,
  );

  native(
    'SU-05 (sin): native agrees with TypeScript within the §5.7 acceptance bounds',
    async () => {
      const stack = su('SU-05');
      const params = paramsOf(stack, 200_000);
      const result = await runStackupMonteCarlo(params, {}, host, { runner: createComputeRunner({}, BINARY) });
      expect(result.isError, result.summary).toBe(false);
      const nativeRun = monteCarloOf(result.data);
      const ts = monteCarloOf(execute(doc, 'analyze_stackup', params).data);
      expect(nativeRun.bitExactWithTs).toBe(false);
      expect(Math.abs(nativeRun.mean - ts.mean)).toBeLessThanOrEqual(stack.monteCarlo.acceptance.meanTolerance);
      expect(Math.abs(nativeRun.std - ts.std)).toBeLessThanOrEqual(stack.monteCarlo.acceptance.stdTolerance);
    },
    120_000,
  );

  native(
    'above the TS cap: 5e6 samples within the acceptance bounds of the closed forms, same bits on 1 and 4 threads',
    async () => {
      const stack = su('SU-01');
      const params = paramsOf(stack, 5_000_000);
      const on = async (threads: string): Promise<MonteCarlo> => {
        const env = { ...process.env, RAYON_NUM_THREADS: threads };
        const result = await runStackupMonteCarlo(params, { verify: true }, host, { runner: createComputeRunner(env, BINARY), env });
        expect(result.isError, result.summary).toBe(false);
        expect((result.data as { verification: { skipped: string } }).verification.skipped).toContain('above the TypeScript cap');
        return monteCarloOf(result.data);
      };
      const one = await on('1');
      const four = await on('4');
      expect(one.provenance?.threads).toBe(1);
      expect(four.provenance?.threads).toBe(4);
      for (const key of ['mean', 'std', 'min', 'max', 'pBelowLowerLimit'] as const) expect(Object.is(one[key], four[key]), key).toBe(true);
      expect(Math.abs(one.mean - stack.analytic.yMean)).toBeLessThanOrEqual(one.acceptance.meanTolerance);
      expect(Math.abs(one.std - stack.analytic.sigma)).toBeLessThanOrEqual(one.acceptance.stdTolerance);
      expect(Math.abs((one.pBelowLowerLimit as number) - (stack.analytic.pBelowLowerLimit as number))).toBeLessThanOrEqual(
        one.acceptance.pTolerance as number,
      );
    },
    300_000,
  );

  native(
    'through runNativeTool (the CLI / POST /exchange path), never changing the document',
    async () => {
      const outcome = await runNativeTool('stackup_monte_carlo', { ...paramsOf(su('SU-03'), 50_000), timeoutS: 60 }, host, {
        runner: createComputeRunner({}, BINARY),
        store: undefined as never,
      });
      expect(outcome).toMatchObject({ isError: false, changed: false });
      expect(outcome?.summary).toContain('llull-compute sampled 50000 stacks');
    },
    120_000,
  );
});
