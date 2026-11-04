// Realism tier of the 3D view (UI-only, never a command): Draft (no shadows), Standard (shadows scaled by scene size), High (richest
// shadows, feature edges whatever the scene size). A per-user view preference, persisted in localStorage like the 3D mouse settings.
// `edges` overrides the tier's feature-edge default ('auto' = follow the tier).

import { create } from 'zustand';
import { readStored, writeStored } from './persistence';

export type RealismTier = 'draft' | 'standard' | 'high';
export type EdgePreference = 'auto' | 'on' | 'off';

export const REALISM_STORAGE_KEY = 'llull-realism';
export const EDGES_STORAGE_KEY = 'llull-realism-edges';
const TIERS: readonly RealismTier[] = ['draft', 'standard', 'high'];
const EDGE_PREFERENCES: readonly EdgePreference[] = ['auto', 'on', 'off'];

/** A stored value back to a tier; anything unknown is Standard. */
export function sanitizeRealism(value: unknown): RealismTier {
  return TIERS.find((tier) => tier === value) ?? 'standard';
}

/** A stored value back to an edge preference; anything unknown follows the tier. */
export function sanitizeEdgePreference(value: unknown): EdgePreference {
  return EDGE_PREFERENCES.find((preference) => preference === value) ?? 'auto';
}

interface RealismState {
  realism: RealismTier;
  edges: EdgePreference;
  setRealism(realism: RealismTier): void;
  setEdges(edges: EdgePreference): void;
}

export const useRealismStore = create<RealismState>()((set) => ({
  realism: sanitizeRealism(readStored(REALISM_STORAGE_KEY)),
  edges: sanitizeEdgePreference(readStored(EDGES_STORAGE_KEY)),
  setEdges: (edges) => {
    writeStored(EDGES_STORAGE_KEY, edges);
    set({ edges });
  },
  setRealism: (realism) => {
    writeStored(REALISM_STORAGE_KEY, realism);
    set({ realism });
  },
}));
