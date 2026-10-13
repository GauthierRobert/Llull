// Capture-phase window keydown: runs before the global shortcut handler, which skips keys a tool preventDefault-ed.
// Pass a memoized handler (re-attached on change) or null.

import { useEffect } from 'react';

export function useCaptureKeydown(onKey: ((event: KeyboardEvent) => void) | null): void {
  useEffect(() => {
    if (onKey === null) return;
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onKey]);
}
