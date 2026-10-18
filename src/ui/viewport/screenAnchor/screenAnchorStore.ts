// Bridge between in-Canvas anchors (which know the camera) and the DOM overlay beside the Canvas (which renders the
// label). Content lives in the store; per-frame positions bypass React and are written straight to the element.

import type { ReactNode } from 'react';
import { create } from 'zustand';
import { anchorTransform, type ScreenPoint } from './screenPoint';

interface ScreenAnchorSpec {
  id: string;
  content: ReactNode;
  centered: boolean;
  zIndex: number;
  className: string;
}

interface ScreenAnchorState {
  anchors: Readonly<Record<string, ScreenAnchorSpec>>;
  upsert: (spec: ScreenAnchorSpec) => void;
  remove: (id: string) => void;
}

export const useScreenAnchorStore = create<ScreenAnchorState>((set) => ({
  anchors: {},
  upsert: (spec) => set((s) => ({ anchors: { ...s.anchors, [spec.id]: spec } })),
  remove: (id) =>
    set((s) => {
      if (!(id in s.anchors)) return s;
      const rest = { ...s.anchors };
      delete rest[id];
      return { anchors: rest };
    }),
}));

const elements = new Map<string, HTMLElement>();
const lastPoints = new Map<string, { point: ScreenPoint; centered: boolean }>();

function apply(id: string): void {
  const element = elements.get(id);
  const last = lastPoints.get(id);
  if (element === undefined || last === undefined) return;
  element.style.transform = anchorTransform(last.point, last.centered);
  element.style.visibility = last.point.visible ? 'visible' : 'hidden';
}

/** Called each rendered frame by the in-Canvas anchor. */
export function placeAnchor(id: string, point: ScreenPoint, centered: boolean): void {
  lastPoints.set(id, { point, centered });
  apply(id);
}

export function registerAnchorElement(id: string, element: HTMLElement | null): void {
  if (element === null) {
    elements.delete(id);
    return;
  }
  elements.set(id, element);
  apply(id);
}

export function forgetAnchor(id: string): void {
  lastPoints.delete(id);
}
