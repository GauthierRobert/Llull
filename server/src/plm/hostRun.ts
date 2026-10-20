/**
 * The one way the server and the local CLI run a command (09 PLM TR-PLM-05, FR-PLM-19): the host fills the time / user a plm command declares but the
 * caller omitted, and records the audit chain. Commands themselves never read a clock. There is NO caller label: human-only acts are cleared by a
 * verified signature inside the command, never by who the request says it is from.
 */

import { userInfo } from 'node:os';
import { getCommand } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { type CommandRun, runCommandOutcome } from '@protocol/commandOutcome';
import { toolsetOf } from '@protocol/toolsets';
import { isRecord } from '@lib/isRecord';
import { withoutConfirmations } from '@lib/withoutConfirmations';
import { serverContext } from '../fea/context';
import { type AuditLog, appendSafely, auditDir, createAuditLog, paramsHash } from './auditChain';

const FILLED = ['at', 'by'] as const;

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

/** `params` plus the `at` / `by` a plm command declares and the caller left out (`by` is a label for the record, never an authority). */
export function fillHostParams(name: string, params: unknown, now: Date, env: NodeJS.ProcessEnv = process.env): unknown {
  // Only the plm toolset: other commands declare their own `at` / `by` params (add_door, edit_nurbs, ...).
  if (toolsetOf(name) !== 'plm') return params;
  const properties = getCommand(name)?.paramsSchema.properties;
  if (properties === undefined || !FILLED.some((key) => key in properties)) return params;
  const filled: Record<string, unknown> = { ...(isRecord(params) ? params : {}) };
  if ('at' in properties) filled['at'] = isoSeconds(now); // the host clock always: a caller-supplied time is never trusted on a gated act
  if ('by' in properties && filled['by'] === undefined) filled['by'] = hostUser(env);
  return filled;
}

const logs = new Map<string, AuditLog>();
export function auditLogOf(): AuditLog | null {
  const dir = auditDir();
  if (dir === null) return null;
  try {
    let log = logs.get(dir);
    if (log === undefined) logs.set(dir, (log = createAuditLog(dir)));
    return log;
  } catch (error) {
    console.warn(`[llull] audit log unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export interface HostRunOptions {
  /** Where the command came from, e.g. `rest`, `cli`. */
  readonly source: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  /** The step observer of a local plan. */
  readonly onStep?: Parameters<typeof serverContext>[0];
}

/**
 * Run `name` on `prior` (returns the params as filled, signatures replaced by `{ verified: true }`: what live sync may log); every mutation and every
 * refusal reaches the audit chain (queries that succeed do not). An audit failure never fails the command.
 */
export function runHostCommand(
  prior: CadDocument,
  name: string,
  params: unknown,
  options: HostRunOptions,
): CommandRun & { readonly params: unknown } {
  const env = options.env ?? process.env;
  const now = options.now ?? ((): Date => new Date());
  const filled = fillHostParams(name, params, now(), env);
  const run = runCommandOutcome(prior, name, filled, serverContext(options.onStep));
  const loggable = withoutConfirmations(filled);
  const readOnly = getCommand(name)?.annotations?.readOnly === true;
  const log = !readOnly || run.outcome.isError ? auditLogOf() : null;
  if (log !== null)
    appendSafely(log, {
      ts: now().toISOString(),
      source: options.source,
      command: name,
      paramsSha256: paramsHash(loggable),
      summary: run.outcome.summary.slice(0, 500),
      changed: run.outcome.changed,
      rejected: run.outcome.isError,
      affectedCount: run.outcome.affected.length,
      ...(run.outcome.error !== undefined ? { errorCode: run.outcome.error.code } : {}),
    });
  return { ...run, params: loggable };
}
