import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewResponseBody } from '@protocol/preview';
import { createRemotePreview, REMOTE_PREVIEW_DEBOUNCE_MS, REMOTE_PREVIEW_MAX_WAIT_MS } from '@ui/preview/remote/remotePreview';

const body = (summary: string): PreviewResponseBody => ({ ok: true, summary, entities: [], replacedIds: [] });

interface Call {
  name: string;
  params: unknown;
  signal: AbortSignal;
  resolve(value: PreviewResponseBody): void;
  reject(error: Error): void;
}

function harness(): {
  calls: Call[];
  results: string[];
  errors: string[];
  pending: ReturnType<typeof vi.fn>;
  preview: ReturnType<typeof createRemotePreview>;
} {
  const calls: Call[] = [];
  const results: string[] = [];
  const errors: string[] = [];
  const pending = vi.fn();
  const preview = createRemotePreview({
    post: (name, params, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ name, params, signal, resolve, reject });
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    onResult: (answer) => results.push(answer.summary),
    onError: (message) => errors.push(message),
    onPending: pending,
  });
  return { calls, results, errors, pending, preview };
}

describe('remote preview sequencing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a burst of requests into one call with the latest params', async () => {
    const { calls, preview, pending } = harness();
    preview.request('push_pull_face', { distance: 1 });
    await vi.advanceTimersByTimeAsync(20);
    preview.request('push_pull_face', { distance: 2 });
    await vi.advanceTimersByTimeAsync(20);
    preview.request('push_pull_face', { distance: 3 });
    expect(calls).toHaveLength(0);
    expect(pending).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_DEBOUNCE_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({ distance: 3 });
  });

  it('still asks while a drag never pauses (max wait)', async () => {
    const { calls, preview } = harness();
    for (let elapsed = 0; elapsed < REMOTE_PREVIEW_MAX_WAIT_MS + 60; elapsed += 30) {
      preview.request('push_pull_face', { distance: elapsed });
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('aborts the request in flight when a newer one is sent and ignores its late answer', async () => {
    const { calls, results, preview } = harness();
    preview.request('draft_faces', { angle: 1 });
    await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_DEBOUNCE_MS);
    const first = calls[0] as Call;
    preview.request('draft_faces', { angle: 2 });
    expect(first.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_DEBOUNCE_MS);
    const second = calls[1] as Call;
    // the transport answers the stale request anyway (it was already on the wire)
    first.resolve(body('stale'));
    second.resolve(body('fresh'));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual(['fresh']);
  });

  it('drops an answer that arrives after cancel', async () => {
    const { calls, results, errors, preview } = harness();
    preview.request('move_faces', {});
    await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_DEBOUNCE_MS);
    preview.cancel();
    (calls[0] as Call).resolve(body('late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('cancels a request that has not gone out yet', async () => {
    const { calls, preview } = harness();
    preview.request('move_faces', {});
    preview.cancel();
    await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_MAX_WAIT_MS);
    expect(calls).toHaveLength(0);
  });

  it('reports a failure of the latest request, not of an aborted one', async () => {
    const { calls, errors, preview } = harness();
    preview.request('a', {});
    await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_DEBOUNCE_MS);
    preview.request('b', {});
    await vi.advanceTimersByTimeAsync(REMOTE_PREVIEW_DEBOUNCE_MS);
    (calls[1] as Call).reject(new Error('HTTP 500'));
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(['HTTP 500']);
  });
});
