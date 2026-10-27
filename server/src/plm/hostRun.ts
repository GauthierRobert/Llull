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
import { resolveDeferred, type Refusal, type ResolveOptions } from '../native/deferredRun';
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

export type HostRun = CommandRun & { readonly params: unknown };

/** Audit-chain entry of a finished run: every mutation and every refusal (queries that succeed do not). An audit failure never fails the command. */
function audit(name: string, loggable: unknown, outcome: CommandRun['outcome'], options: HostRunOptions): void {
  const now = options.now ?? ((): Date => new Date());
  const readOnly = getCommand(name)?.annotations?.readOnly === true;
  const log = !readOnly || outcome.isError ? auditLogOf() : null;
  if (log !== null)
    appendSafely(log, {
      ts: now().toISOString(),
      source: options.source,
      command: name,
      paramsSha256: paramsHash(loggable),
      summary: outcome.summary.slice(0, 500),
      changed: outcome.changed,
      rejected: outcome.isError,
      affectedCount: outcome.affected.length,
      ...(outcome.error !== undefined ? { errorCode: outcome.error.code } : {}),
    });
}

function filledParams(name: string, params: unknown, options: HostRunOptions): unknown {
  return fillServerParams(name, params, (options.now ?? ((): Date => new Date()))(), options.env ?? process.env);
}

/**
 * Run `name` on `prior` (returns the params as filled, signatures replaced by `{ verified: true }`: what live sync may log); every mutation and every
 * refusal reaches the audit chain (queries that succeed do not). An audit failure never fails the command.
 * Synchronous: for the host's own fixed commands. A command that may ask for a native mesh job goes through `runHostCommandResolved`.
 */
export function runHostCommand(prior: CadDocument, name: string, params: unknown, options: HostRunOptions): HostRun {
  const filled = filledParams(name, params, options);
  const run = runCommandOutcome(prior, name, filled, serverContext(options.onStep));
  const loggable = withoutConfirmations(filled);
  audit(name, loggable, run.outcome, options);
  return { ...run, params: loggable };
}

/** The run of a resolve that ended without committing anything (cancelled, job limit, protocol bug): `document` unchanged, an error outcome that names the refusal. */
export function refusedRun(document: CadDocument, refusal: Refusal): CommandRun {
  return {
    document,
    outcome: {
      summary: refusal.message,
      affected: [],
      isError: true,
      changed: false,
      error: { code: refusal.code, ids: [], paths: [], remediation: refusal.remediation },
    },
  };
}

export interface ResolvedRunOptions extends HostRunOptions, Omit<ResolveOptions, 'commit' | 'refuse'> {
  /** Called synchronously with the run that stands, in the same tick as that run (no other command can change the document in between): the caller commits the new document here. */
  readonly commit?: (run: HostRun & { readonly prior: CadDocument }) => void;
}

/**
 * `runHostCommand` for a command that may need native mesh jobs (TECHNICAL_SPEC 13.8): the command runs against `priorOf()` (read afresh on every
 * run, so the run that stands sees the document as it is when the jobs are done), the jobs it asks for are awaited without blocking the event
 * loop (progress to `onProgress`, `signal` cancels), and only the run that asked for nothing is audited, committed (`commit`) and returned.
 */
export async function runHostCommandResolved(
  priorOf: () => CadDocument,
  name: string,
  params: unknown,
  options: ResolvedRunOptions,
): Promise<HostRun & { readonly prior: CadDocument }> {
  const filled = filledParams(name, params, options);
  const loggable = withoutConfirmations(filled);
  let prior = priorOf();
  const settled = (run: CommandRun): HostRun & { readonly prior: CadDocument } => ({ ...run, params: loggable, prior });
  return resolveDeferred(
    () => {
      prior = priorOf();
      return runCommandOutcome(prior, name, filled, serverContext(options.onStep));
    },
    {
      ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.maxJobs !== undefined ? { maxJobs: options.maxJobs } : {}),
      ...(options.onWaitStart !== undefined ? { onWaitStart: options.onWaitStart } : {}),
      ...(options.onWaitEnd !== undefined ? { onWaitEnd: options.onWaitEnd } : {}),
      refuse: (refusal) => {
        prior = priorOf();
        return refusedRun(prior, refusal);
      },
      commit: (run) => {
        audit(name, loggable, run.outcome, options);
        options.commit?.(settled(run));
      },
    },
  ).then(settled);
}
