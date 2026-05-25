/**
 * @layer ui/hooks
 *
 * useKeyboardShortcuts — centralised global keyboard shortcut system.
 *
 * Wires the application-level shortcuts in one place:
 *   Ctrl/Cmd-K   → open the command palette
 *   Ctrl-Z       → undo
 *   Ctrl-Shift-Z / Ctrl-Y → redo
 *   Delete / Backspace → dispatch delete_entity on the current selection
 *
 * The existing gizmo shortcuts (g / r / s) live in Viewport3D.tsx and are
 * NOT duplicated here — they guard against input-element focus already.
 *
 * Guard: events whose target is an <input>, <textarea>, or [contenteditable]
 * are ignored so shortcuts don't fire while the user is typing.
 */

import { useEffect } from 'react';
import { useStore } from '@ui/store';

/** Returns true when the keyboard event originates from a text-entry element. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target.isContentEditable) return true;
  return false;
}

export interface UseKeyboardShortcutsOptions {
  /** Called when Ctrl/Cmd-K is pressed. */
  onOpenPalette: () => void;
}

/**
 * Mount once at the app root. Registers window-level keydown listeners;
 * cleans them up on unmount. Uses narrow store selectors (R3).
 */
export function useKeyboardShortcuts({ onOpenPalette }: UseKeyboardShortcutsOptions): void {
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const dispatch = useStore((s) => s.dispatch);
  const selection = useStore((s) => s.document.selection);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const ctrl = e.ctrlKey || e.metaKey;

      // Ctrl/Cmd-K: open palette — intercept before typing guard so it works
      // even when no input is focused, and prevent default browser behaviour.
      if (ctrl && e.key === 'k') {
        e.preventDefault();
        onOpenPalette();
        return;
      }

      // All remaining shortcuts should not fire while the user is typing.
      if (isTypingTarget(e.target)) return;

      // Ctrl-Z: undo
      if (ctrl && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        undo();
        return;
      }

      // Ctrl-Shift-Z or Ctrl-Y: redo
      if (ctrl && ((e.shiftKey && e.key === 'z') || (!e.shiftKey && e.key === 'y'))) {
        e.preventDefault();
        redo();
        return;
      }

      // Delete / Backspace: delete selected entities
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length > 0) {
        e.preventDefault();
        for (const id of selection) {
          dispatch('delete_entity', { id });
        }
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // selection is a stable reference for the current snapshot; re-register when
    // it changes so the closure sees the latest ids. undo/redo/dispatch are stable
    // Zustand selectors.
  }, [onOpenPalette, undo, redo, dispatch, selection]);
}
