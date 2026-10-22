// Keyboard handling of cage edit mode as a pure table: key event + mode state in, action out. The hook only dispatches the action.

import type { CageElementKind } from './cageSelection';
import type { AxisLock } from './dragMath';

export type CageTool = 'select' | 'loop_cut';

export interface CageKeyContext {
  /** A drag or modal gesture is in flight. */
  readonly gestureActive: boolean;
  readonly tool: CageTool;
  readonly selectionEmpty: boolean;
  readonly hasFaceSelection: boolean;
}

export type CageKeyAction =
  | { readonly kind: 'cancel_gesture' }
  | { readonly kind: 'commit_gesture' }
  | { readonly kind: 'end_tool' }
  | { readonly kind: 'clear_selection' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'mode'; readonly mode: CageElementKind }
  | { readonly kind: 'inset' }
  | { readonly kind: 'loop_cut_tool' }
  | { readonly kind: 'cuts'; readonly delta: 1 | -1 }
  | { readonly kind: 'axis_lock'; readonly axis: AxisLock };

export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

const MODE_KEYS: Readonly<Record<string, CageElementKind>> = { '1': 'vertex', '2': 'edge', '3': 'face' };

/** The action for a key in cage edit mode, or null (the key is left to the global shortcuts). */
export function cageKeyAction(event: KeyLike, context: CageKeyContext): CageKeyAction | null {
  const key = event.key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  if (key === 'escape') {
    if (context.gestureActive) return { kind: 'cancel_gesture' };
    if (context.tool !== 'select') return { kind: 'end_tool' };
    return context.selectionEmpty ? { kind: 'exit' } : { kind: 'clear_selection' };
  }
  if (key === 'enter' && context.gestureActive) return { kind: 'commit_gesture' };
  if (key === 'tab' && !modifier) return { kind: 'exit' };
  if (modifier && key === 'r' && !event.altKey) return { kind: 'loop_cut_tool' };
  if (modifier || event.altKey) return null;
  if (context.tool === 'loop_cut' && (key === 'arrowup' || key === 'arrowdown')) return { kind: 'cuts', delta: key === 'arrowup' ? 1 : -1 };
  if (key === 'i' && context.hasFaceSelection && !context.gestureActive) return { kind: 'inset' };
  if (context.gestureActive && (key === 'x' || key === 'y' || key === 'z')) return { kind: 'axis_lock', axis: key };
  const mode = MODE_KEYS[key];
  return mode !== undefined && !context.gestureActive ? { kind: 'mode', mode } : null;
}
