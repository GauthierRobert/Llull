/** fetch stubs for store integration tests. USE IN TESTS ONLY. */

import { vi } from 'vitest';
import type { ServerCommandResponse } from '@ui/store/serverCommands';

/** Stub global fetch to resolve ok with `response`; returns the spy. */
export function mockFetch(response: ServerCommandResponse): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(response),
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** A failed HTTP response (`!ok`, `status`, empty JSON body). */
export function httpFail(status: number): {
  ok: false;
  status: number;
  json: () => Promise<object>;
} {
  return { ok: false, status, json: () => Promise.resolve({}) };
}
