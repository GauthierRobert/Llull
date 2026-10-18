/**
 * Global shortcuts: Ctrl/Cmd+K palette (also from fields), +Z undo, +Y / +Shift+Z redo, +D duplicate, Delete/Backspace,
 * arrows nudge (Shift ×10, repeat while held), Escape clears selection (unless an armed 2D tool preventDefault-ed it),
 * `?` sheet, H / Shift+H / Alt+H hide / isolate / reveal (local viewport filter), N inspector, Ctrl+B sidebar, and the single-key table (shortcuts.ts). Ignored in form fields and dialogs.
 */

import { useEffect } from 'react';
import type { Vec3 } from '@core/model/types';
import { useLayoutStore, usePaletteStore, useStore, useToolStore, useViewportStore } from '@ui/store';
import { deleteSelection, duplicateSelection, hideSelection, isolateSelection, moveSelection } from '@ui/actions/selectionActions';
import { resolveShortcut } from './shortcuts';

/** Document units (× NUDGE_LARGE_FACTOR with Shift). */
const NUDGE_STEP = 1;
const NUDGE_LARGE_FACTOR = 10;

const ARROW_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Belongs to a text field or open dialog, not the canvas tools. */
export function isEditingKeyEvent(e: KeyboardEvent): boolean {
  const origin = e.composedPath()[0] ?? e.target;
  if (isTypingTarget(origin)) return true;
  return origin instanceof Element && origin.closest('[role="dialog"]') !== null;
}

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented) return;
      const palette = usePaletteStore.getState();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (e.repeat) return;
        useToolStore.getState().setShortcutsOpen(false);
        palette.setOpen(!palette.open);
        return;
      }
      // Modal palette: canvas shortcuts never act behind it; Escape still closes it.
      if (palette.open) {
        if (e.key === 'Escape') palette.setOpen(false);
        return;
      }
      if (isEditingKeyEvent(e)) return;
      // Only arrows repeat.
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
      } else if (modifier && key === 'b') {
        e.preventDefault();
        useLayoutStore.getState().toggleSidebar();
      } else if (e.altKey && !modifier && (key === 'h' || e.code === 'KeyH')) {
        e.preventDefault();
        useViewportStore.getState().showAllEntities();
      } else if (modifier || e.altKey) {
        return;
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.document.selection.length === 0) return;
        e.preventDefault();
        deleteSelection();
      } else if (e.key === 'Escape') {
        state.clearSelection();
      } else if (key === 'h') {
        if (e.shiftKey) isolateSelection();
        else hideSelection();
      } else if (key === 'n') {
        useLayoutStore.getState().toggleInspector();
      } else if (e.key === '?') {
        tools.setShortcutsOpen(true);
      } else if (e.key in ARROW_DIRECTIONS) {
        if (state.document.selection.length === 0) return;
        e.preventDefault();
        const [dx, dy] = ARROW_DIRECTIONS[e.key] ?? [0, 0];
        const step = e.shiftKey ? NUDGE_STEP * NUDGE_LARGE_FACTOR : NUDGE_STEP;
        const delta: Vec3 = [dx * step, dy * step, 0];
        // Repeats fold into the first press's undo step.
        moveSelection(delta, { joinPrevious: e.repeat });
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
