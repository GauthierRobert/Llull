/**
 * @layer ui/hooks
 *
 * Global shortcuts: Ctrl/Cmd+Z undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z redo,
 * Delete/Backspace delete selection (one delete_entities call), Escape clear selection.
 * Ignored while typing in form fields. All mutations go through the store.
 */

import { useEffect } from 'react';
import { useStore } from '@ui/store';

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.repeat || e.defaultPrevented) return;
      const origin = e.composedPath()[0] ?? e.target;
      if (isTypingTarget(origin)) return;
      if (origin instanceof Element && origin.closest('[role="dialog"]')) return;
      const state = useStore.getState();
      const modifier = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (modifier && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) state.redo();
        else state.undo();
      } else if (modifier && key === 'y') {
        e.preventDefault();
        state.redo();
      } else if (!modifier && (e.key === 'Delete' || e.key === 'Backspace')) {
        const selection = state.document.selection;
        if (selection.length === 0) return;
        e.preventDefault();
        state.dispatch('delete_entities', { ids: [...selection] });
      } else if (!modifier && e.key === 'Escape') {
        state.clearSelection();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
