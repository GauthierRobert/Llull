// The renderer's door to the desktop app (desktop/src/preload.ts): present only inside Electron. It takes no argument: the desktop owns the dialog and the path.

interface DesktopExportOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** The user closed the save dialog: not an error. */
  readonly cancelled: boolean;
}

interface DesktopBridge {
  /** Never rejects: a failed call, a refused sender or an answer of the wrong shape is `{ ok: false }` with a message. */
  exportThreeMf(): Promise<DesktopExportOutcome>;
}

/** The answer of the main process as an outcome; anything else is a failure naming itself. */
function outcomeOf(answer: unknown): DesktopExportOutcome {
  if (typeof answer === 'object' && answer !== null) {
    const { ok, message, cancelled } = answer as { ok?: unknown; message?: unknown; cancelled?: unknown };
    if (typeof ok === 'boolean' && typeof message === 'string') return { ok, message, cancelled: cancelled === true };
  }
  return { ok: false, message: 'The desktop app answered in an unexpected shape', cancelled: false };
}

/** The desktop bridge, or null in a plain browser page (dev server). */
export function desktopBridge(): DesktopBridge | null {
  const bridge: unknown = (window as unknown as { llull?: unknown }).llull;
  if (typeof bridge !== 'object' || bridge === null) return null;
  const candidate = bridge as { exportThreeMf?: unknown };
  if (typeof candidate.exportThreeMf !== 'function') return null;
  const invoke = candidate.exportThreeMf.bind(bridge) as () => Promise<unknown>;
  return {
    exportThreeMf: async () => {
      try {
        return outcomeOf(await invoke());
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error), cancelled: false };
      }
    },
  };
}
