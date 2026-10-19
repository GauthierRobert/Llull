/**
 * TypeScript reference of the native stack-up Monte Carlo (VC-GDT-37 at crate level, RS1 §2 rule 4): jobs built by `stackupJob` and the
 * statistics of the TS sampler, written to solver/crates/llull-stats/tests/fixtures/stackup.json, which `cargo test` must reproduce bit
 * for bit (every program here is free of trigonometry). Regenerate with LLULL_WRITE_NATIVE_FIXTURES=1.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { programFunction } from '@lib/expressionProgram';
import { sampleStackup, STACKUP_CHUNK } from '@lib/stackupSampling';
import { isStackupRefusal, resolveStackup, sampledContributors, stackupJob, type StackupParams } from '@core/commands/pmi/stackupModel';
import reference from '../../../docs/aerospace/03-gdt-mbd-pmi/validation/stackup_reference.json';

const FIXTURE = path.resolve(__dirname, '../../../solver/crates/llull-stats/tests/fixtures/stackup.json');
const WRITE = process.env['LLULL_WRITE_NATIVE_FIXTURES'] === '1';
const SAMPLES = 3 * STACKUP_CHUNK + 123;

const linear = (id: string): StackupParams => {
  const stack = reference.stackups.find((s) => s.id === id) as (typeof reference.stackups)[number];
  return {
    contributors: stack.contributors.map((c) => ({
      name: c.name,
      nominal: c.nominal,
      upper: c.upper,
      lower: c.lower,
      sensitivity: c.sensitivity,
      ...('distribution' in c ? { distribution: c.distribution as 'normal' | 'uniform' } : {}),
    })),
    lowerSpecLimit: 0,
    upperSpecLimit: 0.1,
    samples: SAMPLES,
    seed: 20261015,
  };
};

const CASES: Record<string, StackupParams> = {
  'SU-01': linear('SU-01'),
  'SU-02': linear('SU-02'),
  'SU-03': linear('SU-03'),
  'SU-04': linear('SU-04'),
  'functions, mixed distributions, seed above 2^32': {
    contributors: [
      { name: 'a', nominal: 10, upper: 0.2, lower: -0.1 },
      { name: 'b', nominal: 2, upper: 0.05, lower: -0.05, distribution: 'uniform' },
      { name: 'c', nominal: 3, upper: 0.01, lower: -0.03 },
    ],
    expression:
      'pow(a, 1.5) / b - exp(c / 4) + ln(a) * log10(b) + hypot(a, b, c) - sqrt(a * c) + abs(-b) + round(c * 10) / 10 ' +
      '+ min(a, b) - max(b, c) + mod(a, 3) + floor(b) + ceil(c) + trunc(a) + sign(b - 2) - -c',
    lowerSpecLimit: 30,
    samples: SAMPLES,
    seed: 2 ** 40 + 17,
    sigmaPerHalfTolerance: 2,
  },
};

describe('stack-up native reference fixtures (TS = oracle)', () => {
  it('jobs and TS statistics for llull-stats', () => {
    const cases = Object.entries(CASES).map(([name, params]) => {
      const model = resolveStackup(params, 2_000_000);
      if (isStackupRefusal(model)) throw new Error(model.message);
      const stats = sampleStackup({
        contributors: sampledContributors(model),
        evaluate: programFunction(model.program),
        samples: model.samples,
        seed: model.seed,
        ...(params.lowerSpecLimit === undefined ? {} : { lowerSpecLimit: params.lowerSpecLimit }),
        ...(params.upperSpecLimit === undefined ? {} : { upperSpecLimit: params.upperSpecLimit }),
      });
      expect(stats.nonFinite).toBe(0);
      return { name, job: stackupJob(model), stats };
    });
    const text = `${JSON.stringify(cases)}\n`;
    if (WRITE) writeFileSync(FIXTURE, text);
    expect(readFileSync(FIXTURE, 'utf8') === text, 'stackup.json is out of date: run with LLULL_WRITE_NATIVE_FIXTURES=1').toBe(true);
  });
});
