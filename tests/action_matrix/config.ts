/**
 * Run configuration of the action matrix, from the environment (scripts/actionMatrix.mjs sets it from its flags):
 *   ACTION_MATRIX_MODE=full          every design, up to 120 actions each (default: the PR sample)
 *   ACTION_MATRIX_SHARD=i/n          this process owns shard i (0-based) of n
 *   ACTION_MATRIX_COSTS=file         per-design ms from an earlier run, to balance the shards
 *   ACTION_MATRIX_COST_OUT=file      write this run's per-design ms
 *   ACTION_MATRIX_REPORT=file        write the rows, histogram and findings of this run
 *   ACTION_MATRIX_BLESS=1            rewrite baseline.json from this run instead of checking it
 *   ACTION_MATRIX_DETERMINISM=1      also run the sample twice and compare outcomes and volume bits
 *   ACTION_MATRIX_DESIGN_SAMPLE=N    override 1-in-N designs;  ACTION_MATRIX_ACTION_SAMPLE=N  override 1-in-N actions
 */

import { existsSync, readFileSync } from 'node:fs';
import { FULL_OPTIONS, PR_OPTIONS } from './matrixRunner';
import type { KernelColumn, MatrixOptions } from './types';

export interface MatrixConfig {
  readonly options: MatrixOptions;
  readonly full: boolean;
  readonly bless: boolean;
  readonly determinism: boolean;
  readonly costOut: string | null;
  readonly reportOut: string | null;
}

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value >= 1 ? value : fallback;
};

function parseShard(raw: string | undefined): MatrixOptions['shard'] {
  const match = /^(\d+)\/(\d+)$/.exec(raw ?? '');
  if (match === null) return undefined;
  const [index, count] = [Number(match[1]), Number(match[2])];
  if (count < 1 || index >= count) throw new Error(`ACTION_MATRIX_SHARD ${raw}: expected i/n with 0 <= i < n`);
  return { index, count };
}

export function readConfig(kernel: KernelColumn, env: NodeJS.ProcessEnv = process.env): MatrixConfig {
  const full = env['ACTION_MATRIX_MODE'] === 'full';
  const base = full ? FULL_OPTIONS : PR_OPTIONS;
  const costsFile = env['ACTION_MATRIX_COSTS'];
  const shard = parseShard(env['ACTION_MATRIX_SHARD']);
  const costs = costsFile !== undefined && costsFile !== '' && existsSync(costsFile) ? readCosts(costsFile) : undefined;
  return {
    full,
    bless: env['ACTION_MATRIX_BLESS'] === '1',
    determinism: env['ACTION_MATRIX_DETERMINISM'] === '1',
    costOut: env['ACTION_MATRIX_COST_OUT'] || null,
    reportOut: env['ACTION_MATRIX_REPORT'] || null,
    options: {
      kernel,
      ...base,
      designSample: positiveInt(env['ACTION_MATRIX_DESIGN_SAMPLE'], base.designSample),
      actionSample: positiveInt(env['ACTION_MATRIX_ACTION_SAMPLE'], base.actionSample),
      ...(shard === undefined ? {} : { shard }),
      ...(costs === undefined ? {} : { costs }),
    },
  };
}

function readCosts(file: string): Record<string, number> {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { designs?: { design: string; ms: number }[] };
  return Object.fromEntries((parsed.designs ?? []).map((entry) => [entry.design, entry.ms]));
}
