// Reads the backend's kernel state once (`GET /health`): requested exact kernel but a fallback answering = degraded (FR-INT-07).

import { isRecord } from '@lib/isRecord';
import { SERVER_BASE } from '@ui/serverConfig';
import { useKernelStatusStore } from '@ui/store/kernelStatus';

/** The degraded reason (never empty) of a `/health` body, or null when the requested kernel is the active one or the body says nothing. */
export function degradedReasonOf(health: unknown): string | null {
  const status = isRecord(health) ? health['kernelStatus'] : undefined;
  if (!isRecord(status) || typeof status['requested'] !== 'string' || status['requested'] === status['active']) return null;
  return typeof status['fallbackReason'] === 'string' && status['fallbackReason'] !== ''
    ? status['fallbackReason']
    : 'the exact kernel is unavailable';
}

/** Best effort: an unreachable backend leaves the status as it is (local mode has its own indicator). */
export async function refreshBackendKernelStatus(): Promise<void> {
  try {
    const response = await fetch(`${SERVER_BASE}/health`);
    if (response.ok) useKernelStatusStore.getState().setDegradedReason(degradedReasonOf(await response.json()));
  } catch {
    // backend not reachable yet
  }
}
