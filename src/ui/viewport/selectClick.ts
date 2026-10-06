/** @layer ui/viewport Shared click-to-select helpers for the 2D and 3D viewports. */

import type { ThreeEvent } from '@react-three/fiber';

/** Shift / Ctrl / Cmd held ⇒ the click toggles into the selection instead of replacing it. */
export function isAdditiveSelect(
  event: Pick<MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>,
): boolean {
  return event.shiftKey || event.ctrlKey || event.metaKey;
}

/** r3f `onClick` that selects `entityId` (additive with a modifier key) and stops propagation. */
export function selectOnClick(
  entityId: string,
  onSelect: (id: string, additive: boolean) => void,
): (event: ThreeEvent<MouseEvent>) => void {
  return (event) => {
    event.stopPropagation();
    onSelect(entityId, isAdditiveSelect(event.nativeEvent));
  };
}
