// The section box while one of its faces is dragged (UI-only): the clip planes and the outline follow it live; release commits it with
// `set_section_box` and clears the draft.

import { create } from 'zustand';
import type { SectionBox } from '@core/model/review';

interface SectionBoxDraftState {
  draft: SectionBox | null;
  setDraft(draft: SectionBox | null): void;
}

export const useSectionBoxDraftStore = create<SectionBoxDraftState>()((set) => ({ draft: null, setDraft: (draft) => set({ draft }) }));
