/** PHY-15 fixtures: the validation pack's plans run step by step (`$alias` = the first affected id of the step that declared `as`) and its generator-made oracle. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';

const PACK = path.resolve(__dirname, '../../../docs/physics/15-electro-optical-properties/validation');

export const expected = JSON.parse(readFileSync(path.join(PACK, 'expected_results.json'), 'utf8')) as {
  constants: Record<string, number>;
  cases: { id: string; value: unknown }[];
};

export const oracle = (id: string): number => {
  const found = expected.cases.find((item) => item.id === id)?.value;
  if (typeof found !== 'number') throw new Error(`no numeric oracle ${id}`);
  return found;
};

export const run = (doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CadDocument => {
  const result = execute(doc, name, params, ctx);
  if (result.error !== undefined) throw new Error(`${name} refused: ${result.summary}`);
  return result.document;
};

const substitute = (value: unknown, aliases: Record<string, string>): unknown => {
  if (typeof value === 'string') return value.startsWith('$') ? (aliases[value.slice(1)] ?? value) : value;
  if (Array.isArray(value)) return value.map((item) => substitute(item, aliases));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, aliases)]));
  return value;
};

interface PlanStep {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}

export interface PlanRun {
  readonly doc: CadDocument;
  readonly aliases: Record<string, string>;
  readonly last: CommandResult;
}

/** Execute a validation plan file; the document and aliases after the last step. */
export function runPlan(file: string, until?: string): PlanRun {
  const steps = JSON.parse(readFileSync(path.join(PACK, 'plans', file), 'utf8')) as PlanStep[];
  let doc = createEmptyDocument();
  const aliases: Record<string, string> = {};
  let last: CommandResult = { document: doc, summary: '', affected: [] };
  for (const step of steps) {
    if (until !== undefined && step.command === until) break;
    last = execute(doc, step.command, substitute(step.params, aliases) as Record<string, unknown>);
    if (last.error !== undefined) throw new Error(`${step.command} refused: ${last.summary}`);
    doc = last.document;
    if (step.as !== undefined && last.affected[0] !== undefined) aliases[step.as] = last.affected[0];
  }
  return { doc, aliases, last };
}

interface Row {
  pathId: string;
  name: string;
  totalOhm: number | null;
  totalMilliohm: number | null;
  elements: { kind: string; ohm: number | null; share: number | null; provenance: string }[];
  limit?: { unverified: boolean; source: string; ruleId: string };
  status: string;
  code: string | null;
  findings: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  unverified: boolean;
  unverifiedReasons: string[];
  reviewRequired: boolean;
  disposition: string;
  inputsHash: string;
}

export interface BondData {
  status: string;
  rows: Row[];
  counts: Record<string, number>;
  open: string[];
}

export const checkBonding = (doc: CadDocument, params: Record<string, unknown> = {}, ctx?: ExecutionContext): BondData =>
  execute(doc, 'check_bonding', params, ctx).data as BondData;
