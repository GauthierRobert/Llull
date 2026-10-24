// Pointer capture for drags that must survive the pointer leaving the canvas or the window: the capturing element keeps receiving
// move / up events, and a capture lost to the system (`lostpointercapture`) ends the drag. Safe where capture is missing (tests).

type Capturable = Partial<Pick<Element, 'setPointerCapture' | 'releasePointerCapture' | 'hasPointerCapture'>>;

export function capturePointer(target: EventTarget | null, pointerId: number): void {
  const element = target as Capturable | null;
  try {
    element?.setPointerCapture?.(pointerId);
  } catch {
    // the pointer is already gone (a synthetic or ended event): the window listeners still end the drag
  }
}

export function releasePointer(target: EventTarget | null, pointerId: number): void {
  const element = target as Capturable | null;
  try {
    if (element?.hasPointerCapture?.(pointerId) === true) element.releasePointerCapture?.(pointerId);
  } catch {
    // already released
  }
}
