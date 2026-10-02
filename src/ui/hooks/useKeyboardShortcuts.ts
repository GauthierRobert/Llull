/**
 * @layer ui/hooks
 *
 * Global shortcuts: Ctrl/Cmd+Z undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z redo, Ctrl/Cmd+D duplicate,
 * Delete/Backspace delete selection, arrows nudge selection (Shift ×10, repeats while held), Escape
 * clear selection (unless an armed 2D tool consumed it via preventDefault), `?` shortcut sheet, and
 * the single-key tool table in shortcuts.ts. Ignored while typing in form fields or inside dialogs.
 * All document changes go through the store.
 */

import { useEffect } from 'react';
import type { Vec3 } from '@core/model/types';
import { useStore, useToolStore } from '@ui/store';
import { deleteSelection, duplicateSelection, moveSelection } from '@ui/actions/selectionActions';
import { resolveShortcut } from './shortcuts';

/** Nudge distance per arrow press, in document units (Shift multiplies by NUDGE_LARGE_FACTOR). */
const NUDGE_STEP = 1;
const NUDGE_LARGE_FACTOR = 10;

const ARROW_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** True when a key event belongs to a text field or an open dialog, not to the canvas tools. */
export function isEditingKeyEvent(e: KeyboardEvent): boolean {
  const origin = e.composedPath()[0] ?? e.target;
  if (isTypingTarget(origin)) return true;
  return origin instanceof Element && origin.closest('[role="dialog"]') !== null;
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || isEditingKeyEvent(e)) return;
      // Holding an arrow nudges repeatedly; every other shortcut fires once per press.
      if (e.repeat && !(e.key in ARROW_DIRECTIONS)) return;
      const state = useStore.getState();
      const tools = useToolStore.getState();
      const modifier = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (modifier && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) state.redo();
        else state.undo();
      } else if (modifier && key === 'y') {
        e.preventDefault();
        state.redo();
      } else if (modifier && key === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (modifier || e.altKey) {
        return;
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.document.selection.length === 0) return;
        e.preventDefault();
        deleteSelection();
      } else if (e.key === 'Escape') {
        state.clearSelection();
      } else if (e.key === '?') {
        tools.setShortcutsOpen(true);
      } else if (e.key in ARROW_DIRECTIONS) {
        if (state.document.selection.length === 0) return;
        e.preventDefault();
        const [dx, dy] = ARROW_DIRECTIONS[e.key] ?? [0, 0];
        const step = e.shiftKey ? NUDGE_STEP * NUDGE_LARGE_FACTOR : NUDGE_STEP;
        const delta: Vec3 = [dx * step, dy * step, 0];
        moveSelection(delta);
      } else {
        const action = resolveShortcut(tools.viewMode, e.key);
        if (action === null) return;
        if (action.kind === 'draw') tools.setDrawTool(action.tool);
        else if (action.kind === 'gizmo') tools.setGizmoMode(action.mode);
        else tools.setViewMode(action.viewMode);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
