// The panel item highlighted on the model (UI-only, never a command): clicking a row in any side panel focuses it — its entities are
// selected and its markers (load points, probes, extrema, findings) are drawn as beacons in the 3D and 2D views with a value label.

import { create } from 'zustand';
import type { EntityId, Vec3 } from '@core/model/types';

export interface FocusMarker {
  /** World position, document units. */
  readonly position: Vec3;
  /** Value pill next to the beacon (e.g. "500 N", "T max 132 °C"). */
  readonly label?: string;
}

export interface PanelFocus {
  /** Unique across panels: `<panel>:<kind>:<id>` (e.g. `analysis:load:L1`). */
  readonly key: string;
  /** What the banner says is highlighted. */
  readonly label: string;
  /** Beacon / banner colour; matches the row swatch and the overlay glyph of the item. */
  readonly color: string;
  readonly entityIds: readonly EntityId[];
  readonly markers: readonly FocusMarker[];
}

interface FocusState {
  focus: PanelFocus | null;
  setFocus(focus: PanelFocus | null): void;
}

export const useFocusStore = create<FocusState>()((set) => ({ focus: null, setFocus: (focus) => set({ focus }) }));

/** Whether `key` is the highlighted item (rows draw their focused state from it). */
export function useIsFocused(key: string): boolean {
  return useFocusStore((s) => s.focus?.key === key);
}
