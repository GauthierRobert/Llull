/**
 * The vitest suite of the action matrix, shared by the in-process Manifold run (tests/action_matrix) and the native OCCT run
 * (server/tests/actionMatrix.test.ts): both register the same tests against their own kernel column of baseline.json.
 */

import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BASELINE_PATH, bless, ratchet, readBaseline, writeBaseline } from './baseline';
import { readConfig } from './config';
import { loadDesigns } from './corpus';
import { determinismDifferences, histogram, runMatrix } from './matrixRunner';
import type { KernelColumn, MatrixReport } from './types';

const TIMEOUT_MS = 20 * 60_000;

function writeReports(report: MatrixReport, costOut: string | null, reportOut: string | null): void {
  if (costOut !== null) writeFileSync(costOut, `${JSON.stringify({ kernel: report.kernel, designs: report.costs }, null, 2)}\n`);
  if (reportOut !== null)
    writeFileSync(
      reportOut,
      `${JSON.stringify({ kernel: report.kernel, histogram: histogram(report.rows), rows: report.rows }, null, 2)}\n`,
    );
}

/** Registers the ratchet test (and the determinism test when requested) for `kernel`; the caller has installed that kernel. */
export function defineMatrixSuite(kernel: KernelColumn): void {
  const config = readConfig(kernel);
  const designs = loadDesigns();

  it(
    `runs the ${config.full ? 'full' : 'sampled'} action matrix and holds the baseline ratchet (${kernel} column)`,
    () => {
      const report = runMatrix(designs, config.options);
      writeReports(report, config.costOut, config.reportOut);
      const counts = histogram(report.rows);
      console.warn(`[action matrix ${kernel}] ${report.costs.length} designs, ${report.rows.length} actions: ${JSON.stringify(counts)}`);
      if (config.bless) {
        writeBaseline(bless(readBaseline(), report), BASELINE_PATH);
        return;
      }
      const result = ratchet(readBaseline(), report);
      if (result.improvements.length > 0)
        console.warn(`[action matrix ${kernel}] ${result.improvements.length} new passes (run with ACTION_MATRIX_BLESS=1 to ratchet them)`);
      if (result.fixedErrors.length > 0)
        console.warn(`[action matrix ${kernel}] quarantined errors now fixed: ${result.fixedErrors.join('; ')}`);
      expect(result.errors.map((row) => `${row.key}: ${row.errorKind} - ${row.detail}`)).toEqual([]);
      expect(result.regressions).toEqual([]);
      expect(result.vanished).toEqual([]);
    },
    TIMEOUT_MS,
  );

  if (config.determinism)
    it(
      `is deterministic: two runs agree on outcomes, affected ids and volume bits (${kernel})`,
      () => {
        const options = { ...config.options, designSample: Math.max(config.options.designSample, 4) };
        const [first, second] = [runMatrix(designs, options), runMatrix(designs, options)];
        expect(first.rows.length).toBeGreaterThan(0);
        expect(determinismDifferences(first, second)).toEqual([]);
      },
      TIMEOUT_MS,
    );
}
