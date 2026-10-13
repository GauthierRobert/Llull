/**
 * Window `keydown` listener in the capture phase: it runs before the global shortcut handler,
 * which skips keys a tool consumed (preventDefault). Pass a memoized handler, or null to listen
 * to nothing; the listener is re-attached whenever the handler changes.
 */

import { useEffect } from 'react';

export function useCaptureKeydown(onKey: ((event: KeyboardEvent) => void) | null): void {
  useEffect(() => {
    if (onKey === null) return;
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onKey]);
}
