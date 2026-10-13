// Keyboard contract of armed 2D tools: Escape drops the operation in progress, then disarms; Enter commits.
// Keys typed into fields or dialogs are never consumed.

import { useCallback } from 'react';
import { useCaptureKeydown } from './useCaptureKeydown';
import { isEditingKeyEvent } from './useKeyboardShortcuts';

interface ToolKeys {
  /** Escape does nothing otherwise. */
  armed: boolean;
  /** Escape cancels it instead of disarming. */
  inProgress: boolean;
  onCancel: () => void;
  onDisarm: () => void;
  /** null when Enter does not apply. */
  onEnter: (() => void) | null;
  /** Tool hotkeys. */
  onOtherKey?: (event: KeyboardEvent) => void;
}

export function useToolKeys({ armed, inProgress, onCancel, onDisarm, onEnter, onOtherKey }: ToolKeys): void {
  const onKey = useCallback(
    (e: KeyboardEvent): void => {
      if (isEditingKeyEvent(e)) return;
      if (e.key === 'Escape') {
        if (!armed) return;
        e.preventDefault();
        if (inProgress) onCancel();
        else onDisarm();
      } else if (e.key === 'Enter') {
        onEnter?.();
      } else {
        onOtherKey?.(e);
      }
    },
    [armed, inProgress, onCancel, onDisarm, onEnter, onOtherKey],
  );
  useCaptureKeydown(onKey);
}
