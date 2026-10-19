// Review tab UI state (never serialized, not the document): the last check_prototype result, the document slice it was computed from
// (for the stale ◌ state), list filters/sort/grouping and the finding open in the Explain drawer.

import { create } from 'zustand';
import type { CheckName, CheckStatus, DispositionStatus, PrototypeReview } from './reviewTypes';

interface ReviewSource {
  readonly entities: unknown;
  readonly dynamics: unknown;
}

export type FindingSort = 'severity' | 'value';
export type FindingGroup = 'none' | 'part';

interface ReviewState {
  result: PrototypeReview | null;
  /** Document slice the result was computed from; any later change to it makes the result stale. */
  source: ReviewSource | null;
  busy: boolean;
  /** Last refusal / progress line from running the checks. */
  status: string;
  checkFilter: CheckName | 'all';
  severityFilter: CheckStatus | 'all';
  reviewerFilter: DispositionStatus | 'all';
  sort: FindingSort;
  group: FindingGroup;
  /** findingKey of the item shown in the Explain drawer. */
  explainKey: string | null;
  /** Draw a severity badge at each finding on the model (FindingsOverlay). */
  markersShown: boolean;
  setMarkersShown(shown: boolean): void;
  setResult(result: PrototypeReview | null, source?: ReviewSource): void;
  setBusy(busy: boolean): void;
  setStatus(status: string): void;
  setCheckFilter(filter: CheckName | 'all'): void;
  setSeverityFilter(filter: CheckStatus | 'all'): void;
  setReviewerFilter(filter: DispositionStatus | 'all'): void;
  setSort(sort: FindingSort): void;
  setGroup(group: FindingGroup): void;
  openExplain(findingKey: string | null): void;
}

export const useReviewStore = create<ReviewState>()((set) => ({
  result: null,
  source: null,
  busy: false,
  status: '',
  checkFilter: 'all',
  severityFilter: 'all',
  reviewerFilter: 'all',
  sort: 'severity',
  group: 'none',
  explainKey: null,
  markersShown: true,
  setMarkersShown: (markersShown) => set({ markersShown }),
  setResult: (result, source) => set({ result, source: result === null ? null : (source ?? null), explainKey: null }),
  setBusy: (busy) => set({ busy }),
  setStatus: (status) => set({ status }),
  setCheckFilter: (checkFilter) => set({ checkFilter }),
  setSeverityFilter: (severityFilter) => set({ severityFilter }),
  setReviewerFilter: (reviewerFilter) => set({ reviewerFilter }),
  setSort: (sort) => set({ sort }),
  setGroup: (group) => set({ group }),
  openExplain: (explainKey) => set({ explainKey }),
}));

/** Stale = the entities or dynamics changed after the run (selection and camera changes do not count). */
export function isReviewStale(source: ReviewSource | null, current: ReviewSource): boolean {
  return source !== null && (source.entities !== current.entities || source.dynamics !== current.dynamics);
}
