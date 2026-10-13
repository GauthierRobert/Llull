/**
 * Shared keyboard contract of the armed 2D tools (draw and modify): two-stage Escape (first press
 * drops the operation in progress, the next disarms the tool) and Enter to commit/finish. Keys typed
 * into fields or dialogs are never consumed.
 */

import { useCallback } from 'react';
import { useCaptureKeydown } from './useCaptureKeydown';
import { isEditingKeyEvent } from './useKeyboardShortcuts';

interface ToolKeys {
  /** A tool is armed; Escape does nothing otherwise. */
  armed: boolean;
  /** An operation is in progress: Escape cancels it instead of disarming the tool. */
  inProgress: boolean;
  onCancel: () => void;
  onDisarm: () => void;
  /** Enter handler, or null when Enter does not apply in the current state. */
  onEnter: (() => void) | null;
  /** Any other key (tool hotkeys). */
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
