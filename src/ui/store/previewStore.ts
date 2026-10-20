// The live feature preview (UI-only, never in the document): the dry-run outcome drawn as a translucent ghost, with the entities it
// would replace faded through the shared ghost store.

import { create } from 'zustand';
import { useGhostStore } from './ghostStore';
import type { PreviewOutcome } from '@ui/preview/runPreview';

/** What the ghost stands for; "cut" draws the tool body in the warning tone. */
export type PreviewTone = 'add' | 'cut';

interface PreviewState {
  outcome: PreviewOutcome | null;
  tone: PreviewTone;
  setOutcome(outcome: PreviewOutcome | null, tone?: PreviewTone): void;
}

const GHOST_SOURCE = 'feature-preview';
const NONE: ReadonlySet<string> = new Set();

export const usePreviewStore = create<PreviewState>()((set) => ({
  outcome: null,
  tone: 'add',
  setOutcome(outcome, tone = 'add'): void {
    useGhostStore.getState().setGhosted(GHOST_SOURCE, outcome?.ok === true ? new Set(outcome.replacedIds) : NONE);
    set({ outcome, tone });
  },
}));
