/** Runs the action matrix: builds each (sampled, sharded) design on the installed kernel and tries its capped, sampled actions. */

import { execute } from '@core/commands/registry';
import { getGeometryKernel } from '@core/geometry/kernel';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { sampled, stableHash } from './stableHash';
import { type ActionSpec, UNSUPPORTED, runAction } from './runAction';
import { enumerateActions } from './targets';
import type { Design, DesignCost, MatrixOptions, MatrixReport, MatrixRow } from './types';

const DEFAULT_SEED = 20261019;

export const PR_OPTIONS = { seed: DEFAULT_SEED, designSample: 6, actionSample: 1, maxActionsPerDesign: 40 } as const;
export const FULL_OPTIONS = { seed: DEFAULT_SEED, designSample: 1, actionSample: 1, maxActionsPerDesign: 120 } as const;

/** Splits `designs` over `count` shards: greedy longest-cost-first on the measured costs, else by stable hash. */
export function designsOfShard(designs: readonly Design[], options: MatrixOptions): Design[] {
  const { shard, costs } = options;
  if (shard === undefined) return [...designs];
  if (costs === undefined) return designs.filter((design) => stableHash(design.id, options.seed) % shard.count === shard.index);
  const load = new Array<number>(shard.count).fill(0);
  const owner = new Map<string, number>();
  const known = (design: Design): number => costs[design.id] ?? 1;
  for (const design of [...designs].sort((a, b) => known(b) - known(a) || (a.id < b.id ? -1 : 1))) {
    const lightest = load.indexOf(Math.min(...load));
    owner.set(design.id, lightest);
    load[lightest] = (load[lightest] ?? 0) + known(design);
  }
  return designs.filter((design) => owner.get(design.id) === shard.index);
}

/** The deterministic cap: actions ordered by stable hash, the first `max` kept, then back in enumeration order. */
export function capActions(specs: readonly ActionSpec[], designId: string, options: MatrixOptions): ActionSpec[] {
  const keyOf = (spec: ActionSpec): string => `${designId}|${spec.command}|${spec.target}`;
  const picked = specs.filter((spec) => sampled(keyOf(spec), options.actionSample, options.seed));
  if (picked.length <= options.maxActionsPerDesign) return picked;
  const keep = new Set(
    [...picked]
      .sort((a, b) => stableHash(keyOf(a), options.seed) - stableHash(keyOf(b), options.seed) || (keyOf(a) < keyOf(b) ? -1 : 1))
      .slice(0, options.maxActionsPerDesign),
  );
  return picked.filter((spec) => keep.has(spec));
}

function buildRow(design: Design, summary: string, ok: boolean): MatrixRow {
  const key = `${design.id}|build_project|plan`;
  return {
    key,
    design: design.id,
    command: 'build_project',
    target: 'plan',
    outcome: ok ? 'ok' : UNSUPPORTED.test(summary) ? 'unsupported' : 'refused',
    detail: summary.slice(0, 240),
    volumeBits: null,
    volume: null,
    affected: [],
  };
}

export function buildDesign(design: Design): { doc: CadDocument | null; row: MatrixRow } {
  try {
    const result = execute(createEmptyDocument(), 'build_project', { actions: design.actions });
    const steps = (result.data as { steps?: { index: number; command: string; ok: boolean; summary: string }[] } | undefined)?.steps ?? [];
    const failed = steps.filter((step) => !step.ok);
    if (failed.length > 0 || result.affected.length === 0)
      return {
        doc: failed.length > 0 ? null : result.document,
        row: buildRow(design, `#${failed[0]?.index} ${failed[0]?.command}: ${failed[0]?.summary ?? result.summary}`, false),
      };
    return { doc: result.document, row: buildRow(design, result.summary, true) };
  } catch (error) {
    return { doc: null, row: buildRow(design, `threw: ${error instanceof Error ? error.message : String(error)}`, false) };
  }
}

/** Runs the matrix on the currently installed kernel (the caller installs it) and returns every row plus the per-design costs. */
export function runMatrix(designs: readonly Design[], options: MatrixOptions): MatrixReport {
  const kernel = getGeometryKernel();
  const rows: MatrixRow[] = [];
  const costs: DesignCost[] = [];
  const fullDesigns: string[] = [];
  const chosen = designsOfShard(designs, options).filter((design) => sampled(design.id, options.designSample, options.seed));
  for (const design of chosen) {
    const started = performance.now();
    const built = buildDesign(design);
    rows.push(built.row);
    const enumerated = built.doc === null ? [] : enumerateActions(built.doc);
    const specs = capActions(enumerated, design.id, options);
    for (const spec of specs) if (built.doc !== null) rows.push(runAction(built.doc, design.id, spec, kernel));
    if (options.actionSample <= 1 && specs.length === enumerated.length) fullDesigns.push(design.id);
    costs.push({ design: design.id, ms: Math.round(performance.now() - started), actions: specs.length });
  }
  return { kernel: options.kernel, rows, costs, fullDesigns };
}

export const histogram = (rows: readonly MatrixRow[]): Record<string, number> => {
  const counts: Record<string, number> = { ok: 0, refused: 0, unsupported: 0, error: 0 };
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  return counts;
};

/** Differences between two runs of the same options: outcome, affected ids and measured volume bits, bit for bit. */
export function determinismDifferences(first: MatrixReport, second: MatrixReport): string[] {
  const again = new Map(second.rows.map((row) => [row.key, row]));
  const problems: string[] = [];
  for (const row of first.rows) {
    const other = again.get(row.key);
    if (other === undefined) problems.push(`${row.key}: missing from the second run`);
    else if (other.outcome !== row.outcome || other.volumeBits !== row.volumeBits || other.affected.join(',') !== row.affected.join(','))
      problems.push(
        `${row.key}: ${row.outcome}/${row.volumeBits}/[${row.affected}] vs ${other.outcome}/${other.volumeBits}/[${other.affected}]`,
      );
  }
  if (second.rows.length !== first.rows.length) problems.push(`row counts differ: ${first.rows.length} vs ${second.rows.length}`);
  return problems;
}
