/**
 * The renderer's one door to the desktop (contextIsolation on, sandbox on): `window.llull.exportThreeMf()`. It takes no argument: the main process
 * owns the save dialog, the path and the backend call, so the page cannot name a file to write.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('llull', { exportThreeMf: (): Promise<unknown> => ipcRenderer.invoke('llull:export-3mf') });
