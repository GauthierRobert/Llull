/**
 * Vitest worker count sized from free memory, not CPUs (root and server suites). A worker that keeps every plugin + Manifold
 * loaded grows to ~1.2 GB (peak 1.65 GB, measured 2026-10-23), so 21 workers on a 22-thread machine exhausted RAM. 4 GB stay
 * free for the rest of the machine; `LLULL_TEST_WORKERS` overrides.
 */
import { availableParallelism, freemem } from 'node:os';

export function testWorkers(): number {
  const override = Number(process.env['LLULL_TEST_WORKERS']);
  if (Number.isInteger(override) && override > 0) return override;
  const byMemory = Math.floor((freemem() / 2 ** 30 - 4) / 1.5);
  return Math.max(2, Math.min(availableParallelism() - 1, byMemory));
}
