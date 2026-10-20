// The active on-canvas feature drag session (extrude / fillet / shell handle). UI-only state: the value being dragged and the join / cut
// choice. The document only changes when the session commits through `dispatch`.

import { create } from 'zustand';
import type { EntityId } from '@core/model/types';
import type { ModeChoice } from '@ui/viewport/3d/manipulators/manipulatorMath';
import type { FeatureKind, FeatureSession } from '@ui/viewport/3d/manipulators/featurePlan';

interface FeatureSessionState {
  session: FeatureSession | null;
  start(kind: FeatureKind, targetId: EntityId, value: number): void;
  setValue(value: number): void;
  setModeChoice(choice: ModeChoice): void;
  end(): void;
}

export const useFeatureSessionStore = create<FeatureSessionState>()((set) => ({
  session: null,
  start: (kind, targetId, value) => set({ session: { kind, targetId, value, modeChoice: 'auto' } }),
  setValue: (value) => set((state) => (state.session === null ? state : { session: { ...state.session, value } })),
  setModeChoice: (modeChoice) => set((state) => (state.session === null ? state : { session: { ...state.session, modeChoice } })),
  end: () => set({ session: null }),
}));
