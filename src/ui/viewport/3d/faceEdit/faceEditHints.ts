// The one-line hint of the face edit bar: what the pointer does next, per operation and drag state. Pure text.

import type { FaceOp } from './faceEditModel';

const DRAG_HINT: Readonly<Record<FaceOp, string>> = {
  push_pull: 'Release to push / pull the face; Alt = free, Esc cancels',
  flush: 'Release to move the face onto the plane; it snaps to other faces; Esc cancels',
  draft: 'Release to draft the face about the lowest edge; Esc cancels',
  offset: 'Release to offset the face; Alt = free, Esc cancels',
};

export function faceHint(op: FaceOp, picked: boolean, dragging: boolean): string {
  if (dragging) return DRAG_HINT[op];
  return picked ? 'Drag the arrow (or the face) along its normal; Esc clears the pick' : '1-4 choose the operation; Esc leaves';
}
