// Which document change came from whom: this client's commandIds (echoed back by /live) vs a remote CLI / MCP / API
// sender. The SSE hook marks the origin right before applying an event; useLiveFx consumes it on the resulting change.

import type { LiveFxOrigin } from '@ui/viewport/liveFx/planLiveFx';

const OWN_ID_LIMIT = 512;
const ownCommandIds = new Set<string>();
let pendingOrigin: LiveFxOrigin | null = null;

export function rememberOwnCommandId(commandId: string): void {
  ownCommandIds.add(commandId);
  if (ownCommandIds.size > OWN_ID_LIMIT) {
    const oldest = ownCommandIds.values().next();
    if (oldest.done !== true) ownCommandIds.delete(oldest.value);
  }
}

export function isOwnCommandId(commandId: string | undefined): boolean {
  return commandId !== undefined && ownCommandIds.has(commandId);
}

/** Set by the /live hook just before it applies an event; applies to the next document change only. */
export function markLiveOrigin(origin: LiveFxOrigin | null): void {
  pendingOrigin = origin;
}

/** The marked origin (cleared), or `local` when the change was not announced by /live. */
export function consumeLiveOrigin(): LiveFxOrigin {
  const origin = pendingOrigin ?? { kind: 'local' };
  pendingOrigin = null;
  return origin;
}
