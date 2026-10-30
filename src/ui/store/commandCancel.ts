// The one cancel path of a command this client sent over POST /command: aborting its request (the server kills the native job nobody else waits for and applies
// nothing). A command sent by the CLI or another client has no entry here, so its progress chip offers no Cancel.

const cancelers = new Map<string, () => void>();
const cancelled = new Set<string>();

/** Remember how to abort the command `commandId`; returns the function that forgets it (call when the request settles). */
export function registerCommandCancel(commandId: string, abort: () => void): () => void {
  cancelers.set(commandId, abort);
  return () => void cancelers.delete(commandId);
}

export function isCancellable(commandId: string | undefined): boolean {
  return commandId !== undefined && cancelers.has(commandId);
}

/** Abort the request of `commandId`; false when it is not one of this client's running commands. */
export function cancelCommand(commandId: string): boolean {
  const abort = cancelers.get(commandId);
  if (abort === undefined) return false;
  cancelled.add(commandId);
  abort();
  return true;
}

/** True once, when the failure of the request of `commandId` is the cancel of the user (not a network error). */
export function takeCancelled(commandId: string): boolean {
  return cancelled.delete(commandId);
}
