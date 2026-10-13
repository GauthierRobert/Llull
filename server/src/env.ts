/**
 * @layer server
 * Environment parsing shared by every server module: one definition of "a positive number from an
 * env variable", of the exchange directory and of "this process is a test run".
 */

import path from 'path';

/** A whole number >= 1 parsed from `raw` (fractions floored), else `fallback` (unset, empty, zero, negative, garbage). */
export function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

/** `LLULL_EXCHANGE_DIR` resolved to an absolute path; null when unset or empty. */
export function exchangeDirOf(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env['LLULL_EXCHANGE_DIR'];
  return configured !== undefined && configured !== '' ? path.resolve(configured) : null;
}

/** Running under vitest (`VITEST`) or the test harness (`TEST=true`): no autosave, audit or `.env`. */
export function isTestRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['VITEST']) || env['TEST'] === 'true';
}
