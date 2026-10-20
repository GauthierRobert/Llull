/** One fuzz seed end to end (design case + boolean identity pair) and the summary of a seed range. Host-agnostic: the CLI writes files. */

import type { GeometryKernel } from '@core/geometry/kernel';
import { generateFuzzCase, type FuzzOptions } from './generator';
import { generateBooleanPair, runBooleanIdentity, type IdentityReport } from './identities';
import { runFuzzCase, type FuzzCaseReport } from './runner';
import { FUZZ_FEATURE_KINDS, type FuzzFeatureKind } from './types';

/** Recipe op a feature kind needs beyond booleans; kinds whose op the kernel lacks are not generated. */
const KIND_OPS: Partial<Record<FuzzFeatureKind, 'fillet' | 'chamfer' | 'shell'>> = { fillet: 'fillet', chamfer: 'chamfer', shell: 'shell' };

/** The feature kinds `kernel` can run (a mesh kernel such as Manifold has no fillet / chamfer / shell). */
export function kindsForKernel(kernel: Pick<GeometryKernel, 'supports'> | null): FuzzFeatureKind[] {
  return FUZZ_FEATURE_KINDS.filter((kind) => {
    const op = KIND_OPS[kind];
    return op === undefined || kernel?.supports(op) === true;
  });
}

export interface SeedReport {
  readonly seed: number;
  readonly ok: boolean;
  readonly design: FuzzCaseReport;
  readonly identity: IdentityReport;
  readonly durationMs: number;
}

export function runFuzzSeed(seed: number, options: FuzzOptions, now: () => number = Date.now): SeedReport {
  const started = now();
  const design = runFuzzCase(generateFuzzCase(seed, options));
  const identity = runBooleanIdentity(generateBooleanPair(seed));
  return { seed, ok: design.ok && identity.ok, design, identity, durationMs: now() - started };
}

export interface FuzzSummary {
  readonly seeds: number;
  readonly passed: number;
  readonly failed: number;
  readonly designFailures: number;
  readonly identityFailures: number;
  /** Failure count per `check` (design and identity). */
  readonly byCheck: Readonly<Record<string, number>>;
}

export function summariseFuzz(reports: readonly SeedReport[]): FuzzSummary {
  const byCheck: Record<string, number> = {};
  for (const report of reports)
    for (const failure of [report.design.failure, report.identity.failure])
      if (failure !== undefined) byCheck[failure.check] = (byCheck[failure.check] ?? 0) + 1;
  return {
    seeds: reports.length,
    passed: reports.filter((r) => r.ok).length,
    failed: reports.filter((r) => !r.ok).length,
    designFailures: reports.filter((r) => !r.design.ok).length,
    identityFailures: reports.filter((r) => !r.identity.ok).length,
    byCheck,
  };
}
