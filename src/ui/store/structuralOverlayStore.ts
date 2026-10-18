// Utilisation of the structural members coloured on the model (UI-only, not persisted): the marks of the last structural check and the
// on/off switch. Written by Building › Structural check, drawn by StructuralOverlay.

import { create } from 'zustand';
import type { EntityId } from '@core/model/types';

export interface UtilisationMark {
  readonly key: string;
  readonly entityIds: readonly EntityId[];
  readonly utilisation: number;
  /** The check reports the member as failing whatever its ratio. */
  readonly failing: boolean;
  readonly label: string;
}

interface StructuralOverlayState {
  shown: boolean;
  marks: readonly UtilisationMark[];
  setShown(shown: boolean): void;
  setMarks(marks: readonly UtilisationMark[]): void;
}

export const useStructuralOverlayStore = create<StructuralOverlayState>()((set) => ({
  shown: true,
  marks: [],
  setShown: (shown) => set({ shown }),
  setMarks: (marks) => set({ marks }),
}));
