// Keyboard handling of face edit mode as a pure table: key + state in, action out.

import type { FaceOp } from './faceEditModel';

export type FaceKeyAction =
  | { readonly kind: 'cancel_drag' }
  | { readonly kind: 'clear_pick' }
  | { readonly kind: 'exit' }
  | { readonly kind: 'op'; readonly op: FaceOp };

const OP_KEYS: Readonly<Record<string, FaceOp>> = { '1': 'push_pull', '2': 'flush', '3': 'draft', '4': 'offset' };

export function faceKeyAction(key: string, state: { dragging: boolean; hasPick: boolean }): FaceKeyAction | null {
  const lower = key.toLowerCase();
  if (lower === 'escape') return state.dragging ? { kind: 'cancel_drag' } : state.hasPick ? { kind: 'clear_pick' } : { kind: 'exit' };
  const op = OP_KEYS[lower];
  return op !== undefined && !state.dragging ? { kind: 'op', op } : null;
}
