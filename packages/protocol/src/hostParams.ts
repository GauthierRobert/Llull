/**
 * Host-filled params (09 PLM TR-PLM-05): a plm command declares `at` / `by`, the host supplies them (commands never read a clock). Pure: the
 * clock and the user are injected, so the server, the CLI and the offline UI use the same rule. Applies to a command and to every step of a
 * `build_project` plan, nested loops included. The audit chain stays server-only (`server/src/plm/hostRun.ts`).
 */
import { getCommand } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';
import { toolsetOf } from './toolsets';

/** Who and when the host acts: `user` is read only when a command declares `by` and the caller left it out. */
export interface HostIdentity {
  readonly now: Date;
  readonly user: () => string;
}

const FILLED = ['at', 'by'] as const;

/** ISO-8601 UTC without milliseconds, e.g. 2026-11-02T09:30:00Z. */
export const isoSeconds = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

function fillCommand(name: string, params: unknown, host: HostIdentity): unknown {
  // Only the plm toolset: other commands declare their own `at` / `by` params (add_door, edit_nurbs, ...).
  if (toolsetOf(name) !== 'plm') return params;
  const properties = getCommand(name)?.paramsSchema.properties;
  if (properties === undefined || !FILLED.some((key) => key in properties)) return params;
  const filled: Record<string, unknown> = { ...(isRecord(params) ? params : {}) };
  if ('at' in properties) filled['at'] = isoSeconds(host.now); // the host clock always: a caller-supplied time is never trusted on a gated act
  if ('by' in properties && filled['by'] === undefined) filled['by'] = host.user();
  return filled;
}

/** One plan action: `{ command, params }`, a loop step `{ step }` or a nested body `{ actions }`. */
function fillAction(action: unknown, host: HostIdentity): unknown {
  if (!isRecord(action)) return action;
  if (typeof action['command'] === 'string') return { ...action, params: fillCommand(action['command'], action['params'], host) };
  const next: Record<string, unknown> = { ...action };
  if (isRecord(action['step'])) next['step'] = fillAction(action['step'], host);
  if (Array.isArray(action['actions'])) next['actions'] = action['actions'].map((inner) => fillAction(inner, host));
  return next;
}

/** `params` plus the `at` / `by` a plm command (or any plm step of a build_project plan) declares and the caller left out (`by` is a label, never an authority). */
export function fillHostParams(name: string, params: unknown, host: HostIdentity): unknown {
  if (name === 'build_project' && isRecord(params) && Array.isArray(params['actions'])) {
    return { ...params, actions: params['actions'].map((action) => fillAction(action, host)) };
  }
  return fillCommand(name, params, host);
}
