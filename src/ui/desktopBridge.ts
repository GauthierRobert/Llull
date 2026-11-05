// The renderer's door to the desktop app (desktop/src/preload.ts): present only inside Electron. It takes no file path: the desktop owns the dialog and the path.

interface DesktopOutcome {
  readonly ok: boolean;
  readonly message: string;
  /** The user closed the dialog: not an error. */
  readonly cancelled: boolean;
}

interface DesktopBridge {
  /** Never rejects: a failed call, a refused sender or an answer of the wrong shape is `{ ok: false }` with a message. */
  exportThreeMf(): Promise<DesktopOutcome>;
  /** Restore the recovery slot through the desktop's document session (path, lock, unsaved-changes prompt); same outcome shape, never rejects. */
  restoreRecovery: ((slotId: string) => Promise<DesktopOutcome>) | null;
}

/** The answer of the main process as an outcome; anything else is a failure naming itself. */
function outcomeOf(answer: unknown): DesktopOutcome {
  if (typeof answer === 'object' && answer !== null) {
    const { ok, message, cancelled } = answer as { ok?: unknown; message?: unknown; cancelled?: unknown };
    if (typeof ok === 'boolean' && typeof message === 'string') return { ok, message, cancelled: cancelled === true };
  }
  return { ok: false, message: 'The desktop app answered in an unexpected shape', cancelled: false };
}

const settled =
  <Args extends unknown[]>(invoke: (...args: Args) => Promise<unknown>) =>
  async (...args: Args): Promise<DesktopOutcome> => {
    try {
      return outcomeOf(await invoke(...args));
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), cancelled: false };
    }
  };

/** The desktop bridge, or null in a plain browser page (dev server). */
export function desktopBridge(): DesktopBridge | null {
  const bridge: unknown = (window as unknown as { llull?: unknown }).llull;
  if (typeof bridge !== 'object' || bridge === null) return null;
  const candidate = bridge as { exportThreeMf?: unknown; restoreRecovery?: unknown };
  if (typeof candidate.exportThreeMf !== 'function') return null;
  const exporting = candidate.exportThreeMf.bind(bridge) as () => Promise<unknown>;
  const restoring =
    typeof candidate.restoreRecovery === 'function'
      ? (candidate.restoreRecovery.bind(bridge) as (slotId: string) => Promise<unknown>)
      : null;
  return { exportThreeMf: settled(exporting), restoreRecovery: restoring === null ? null : settled(restoring) };
}
