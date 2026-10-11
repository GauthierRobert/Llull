/**
 * @layer tests/helpers
 * fetch stubs for store integration tests. USE IN TESTS ONLY.
 */

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
