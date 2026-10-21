/**
 * The one way the server and the local CLI run a command (09 PLM TR-PLM-05, FR-PLM-19): the host fills the time / user a plm command declares but the
 * caller omitted, and records the audit chain. Commands themselves never read a clock. There is NO caller label: human-only acts are cleared by a
 * verified signature inside the command, never by who the request says it is from.
 */

import { userInfo } from 'node:os';
import { getCommand } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { type CommandRun, runCommandOutcome } from '@protocol/commandOutcome';
import { fillHostParams } from '@protocol/hostParams';
import { withoutConfirmations } from '@lib/withoutConfirmations';
import { serverContext } from '../fea/context';
import { type AuditLog, appendSafely, auditDir, createAuditLog, paramsHash } from './auditChain';

function hostUser(env: NodeJS.ProcessEnv): string {
  const configured = env['LLULL_USER'];
  if (configured !== undefined && configured !== '') return configured;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/** `fillHostParams` (@protocol/hostParams) with the server clock passed in and the user from `LLULL_USER` or the OS account. */
export function fillServerParams(name: string, params: unknown, now: Date, env: NodeJS.ProcessEnv = process.env): unknown {
  return fillHostParams(name, params, { now, user: () => hostUser(env) });
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
  const filled = fillServerParams(name, params, now(), env);
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
