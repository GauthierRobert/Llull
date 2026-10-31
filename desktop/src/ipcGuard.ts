/**
 * Who may call the main process over IPC (Electron-free so it is unit-tested): only the main frame of the app's own window, loaded from the
 * backend's origin. A subframe, another window or a page that navigated elsewhere gets nothing.
 */

/** The parts of an `IpcMainInvokeEvent` the check reads. */
export interface IpcSenderEvent {
  readonly sender: unknown;
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null;
}

export function ipcSenderAllowed(event: IpcSenderEvent, mainContents: unknown, appOrigin: string): boolean {
  if (mainContents === null || mainContents === undefined || event.sender !== mainContents) return false;
  const frame = event.senderFrame;
  if (frame === null || frame.parent !== null) return false;
  try {
    return new URL(frame.url).origin === appOrigin;
  } catch {
    return false;
  }
}
