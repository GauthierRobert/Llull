/**
 * The renderer's one door to the desktop (contextIsolation on, sandbox on): `window.llull.exportThreeMf()` takes no argument (the main process owns
 * the save dialog, the path and the backend call, so the page cannot name a file to write); `restoreRecovery(slotId)` names a recovery copy, never a path.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('llull', {
  exportThreeMf: (): Promise<unknown> => ipcRenderer.invoke('llull:export-3mf'),
  /** Document Recovery > Restore: the main process restores the slot through its document session (path, lock, saved state). */
  restoreRecovery: (slotId: string): Promise<unknown> => ipcRenderer.invoke('llull:restore-recovery', slotId),
});
