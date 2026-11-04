// Realism tier of the 3D view (UI-only, never a command): Draft (no shadows), Standard (shadows scaled by scene size), High (richest
// shadows whatever the scene size). A per-user view preference, persisted in localStorage like the 3D mouse settings.

import { create } from 'zustand';
import { readStored, writeStored } from './persistence';

export type RealismTier = 'draft' | 'standard' | 'high';

export const REALISM_STORAGE_KEY = 'llull-realism';
const TIERS: readonly RealismTier[] = ['draft', 'standard', 'high'];

/** A stored value back to a tier; anything unknown is Standard. */
export function sanitizeRealism(value: unknown): RealismTier {
  return TIERS.find((tier) => tier === value) ?? 'standard';
}

interface RealismState {
  realism: RealismTier;
  setRealism(realism: RealismTier): void;
}

export const useRealismStore = create<RealismState>()((set) => ({
  realism: sanitizeRealism(readStored(REALISM_STORAGE_KEY)),
  setRealism: (realism) => {
    writeStored(REALISM_STORAGE_KEY, realism);
    set({ realism });
  },
}));
