// The renderer's door to the desktop app (desktop/src/preload.ts): present only inside Electron. It takes no argument: the desktop owns the dialog and the path.

export interface DesktopExportOutcome {
  readonly ok: boolean;
  readonly message: string;
}

interface DesktopBridge {
  exportThreeMf(): Promise<DesktopExportOutcome>;
}

/** The desktop bridge, or null in a plain browser page (dev server). */
export function desktopBridge(): DesktopBridge | null {
  const bridge: unknown = (window as unknown as { llull?: unknown }).llull;
  if (typeof bridge !== 'object' || bridge === null) return null;
  const candidate = bridge as { exportThreeMf?: unknown };
  return typeof candidate.exportThreeMf === 'function' ? (bridge as DesktopBridge) : null;
}
