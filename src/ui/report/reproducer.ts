/**
 * The reproducer of a failed command (SC-A4): a minimal `build_project` plan (its params) that rebuilds the document and then runs the
 * failing command. Source order: the backend's crash report when it replays from an empty document and ends in this command (exact),
 * else the document's own recipe (`featureHistory`, unsuppressed steps) plus the failing command. Params are redacted. Pure.
 */
import type { FeatureStep } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { redactedValue } from './redact';

interface ReproducerCommand {
  readonly command: string;
  readonly params: unknown;
}

interface ReproducerPlan {
  readonly actions: readonly ReproducerCommand[];
  readonly onError: 'abort';
}

export interface FailedCommand {
  readonly name: string;
  readonly params: unknown;
}

export interface ReproducerSource {
  readonly origin: 'crash-report' | 'document-history';
  readonly plan: ReproducerPlan;
}

const asAction = (name: string, params: unknown): ReproducerCommand => ({ command: name, params: redactedValue(params ?? {}) });

function fromCrashReport(report: unknown, failed: FailedCommand): ReproducerPlan | null {
  if (!isRecord(report) || !isRecord(report['commandLog'])) return null;
  const log = report['commandLog'];
  const failing = log['failing'];
  const commands = log['commands'];
  if (log['replayFrom'] !== 'empty' || !Array.isArray(commands) || !isRecord(failing) || failing['name'] !== failed.name) return null;
  const actions = commands
    .filter(isRecord)
    .filter((entry) => typeof entry['name'] === 'string')
    .map((entry) => asAction(String(entry['name']), entry['params']));
  return { actions: [...actions, asAction(failed.name, failing['params'])], onError: 'abort' };
}

/** `report` only when the backend wrote it for a failure at `failedAt` (it is the newest one, so a stale report must not be used). */
export function crashReportFor(report: unknown, failedAt: number): unknown {
  if (!isRecord(report) || typeof report['time'] !== 'string') return undefined;
  return Date.parse(report['time']) >= failedAt - 10_000 ? report : undefined;
}

/**
 * @param history the document's recipe at the time of the failure
 * @param crashReport JSON of `GET /crashes/latest` for this failure, when the backend wrote one
 */
export function buildReproducer(history: readonly FeatureStep[], failed: FailedCommand, crashReport?: unknown): ReproducerSource {
  const exact = fromCrashReport(crashReport, failed);
  if (exact !== null) return { origin: 'crash-report', plan: exact };
  const steps = history.filter((step) => step.suppressed !== true).map((step) => asAction(step.name, step.params));
  return { origin: 'document-history', plan: { actions: [...steps, asAction(failed.name, failed.params)], onError: 'abort' } };
}
