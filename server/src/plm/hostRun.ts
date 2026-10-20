/**
 * The one way the server and the local CLI run a command (09 PLM TR-PLM-05, TR-PLM-16, FR-PLM-19): the host fills the time / user a command
 * declares but the caller omitted, marks who is calling (`ctx.caller`) and records the audit chain. Commands themselves never read a clock.
 */

import { userInfo } from 'node:os';
import { getCommand } from '@core/commands/registry';
import type { CommandCaller } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { type CommandRun, runCommandOutcome } from '@protocol/commandOutcome';
import { isRecord } from '@lib/isRecord';
import { serverContext } from '../fea/context';
import { type AuditLog, auditDir, createAuditLog, paramsHash } from './auditChain';

export const AGENT: CommandCaller = { kind: 'agent' };
export const HUMAN: CommandCaller = { kind: 'human' };

/** The caller named by a request: only an explicit "human" is human; anything else (absent, unknown) is an agent. */
export const callerOf = (value: unknown): CommandCaller => (value === 'human' ? HUMAN : AGENT);

const FILLED = ['at', 'by', 'decidedBy'] as const;

/** ISO-8601 UTC without milliseconds, e.g. 2026-11-02T09:30:00Z. */
export const isoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

function hostUser(env: NodeJS.ProcessEnv): string {
  const configured = env['LLULL_USER'];
  if (configured !== undefined && configured !== '') return configured;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/** `params` plus the `at` / `by` / `decidedBy` the command declares and the caller left out. */
export function fillHostParams(
  name: string,
  params: unknown,
  caller: CommandCaller,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  const properties = getCommand(name)?.paramsSchema.properties;
  if (properties === undefined || !FILLED.some((key) => key in properties)) return params;
  const given = isRecord(params) ? params : {};
  const user = caller.userId ?? (caller.kind === 'agent' ? 'agent' : hostUser(env));
  const filled: Record<string, unknown> = { ...given };
  if ('at' in properties && filled['at'] === undefined) filled['at'] = isoSeconds(now);
  if ('by' in properties && filled['by'] === undefined) filled['by'] = user;
  if ('decidedBy' in properties && filled['decidedBy'] === undefined) filled['decidedBy'] = user;
  return filled;
}

const logs = new Map<string, AuditLog>();
function auditLogOf(env: NodeJS.ProcessEnv): AuditLog | null {
  const dir = auditDir(env);
  if (dir === null) return null;
  let log = logs.get(dir);
  if (log === undefined) logs.set(dir, (log = createAuditLog(dir)));
  return log;
}

export interface HostRunOptions {
  readonly caller: CommandCaller;
  /** Where the command came from, e.g. `rest`, `cli`. */
  readonly source: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  /** Extra context fields (e.g. the step observer of a local plan). */
  readonly onStep?: Parameters<typeof serverContext>[1];
}

/** Run `name` on `prior` as `options.caller` (returns the params as filled, which live sync must replay); every mutation and every refusal reaches the audit chain (queries that succeed do not). */
export function runHostCommand(
  prior: CadDocument,
  name: string,
  params: unknown,
  options: HostRunOptions,
): CommandRun & { readonly params: unknown } {
  const env = options.env ?? process.env;
  const filled = fillHostParams(name, params, options.caller, (options.now ?? (() => new Date()))(), env);
  const context = serverContext(options.caller, options.onStep);
  const run = runCommandOutcome(prior, name, filled, context);
  const readOnly = getCommand(name)?.annotations?.readOnly === true;
  if (!readOnly || run.outcome.isError) {
    auditLogOf(env)?.append({
      ts: (options.now ?? (() => new Date()))().toISOString(),
      caller: options.caller.kind,
      ...(options.caller.userId !== undefined ? { userId: options.caller.userId } : {}),
      source: options.source,
      command: name,
      paramsSha256: paramsHash(filled),
      summary: run.outcome.summary.slice(0, 500),
      changed: run.outcome.changed,
      rejected: run.outcome.isError,
      affectedCount: run.outcome.affected.length,
      ...(run.outcome.error !== undefined ? { errorCode: run.outcome.error.code } : {}),
    });
  }
  return { ...run, params: filled };
}
