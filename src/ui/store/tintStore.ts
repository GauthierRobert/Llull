// Solids drawn in an override colour (UI-only), e.g. steel members coloured by their utilisation: the real geometry carries the
// verdict, so a diagonal brace reads exactly like the member it is. Two layers: an overlay's own tints (structural utilisation) win over
// the active colour profile's (`profileTints`); `tints` is what the entity renderers read.

import { create } from 'zustand';

interface TintState {
  /** The merged map the renderers read: overlay tints over profile tints. */
  tints: ReadonlyMap<string, string>;
  overlayTints: ReadonlyMap<string, string>;
  profileTints: ReadonlyMap<string, string>;
  setTints(tints: ReadonlyMap<string, string>): void;
  setProfileTints(tints: ReadonlyMap<string, string>): void;
}

const NONE: ReadonlyMap<string, string> = new Map();

function merged(profile: ReadonlyMap<string, string>, overlay: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  if (profile.size === 0) return overlay;
  if (overlay.size === 0) return profile;
  return new Map([...profile, ...overlay]);
}

export const useTintStore = create<TintState>()((set) => ({
  tints: NONE,
  overlayTints: NONE,
  profileTints: NONE,
  setTints: (tints) =>
    set((state) => {
      const overlayTints = tints.size === 0 ? NONE : tints;
      return { overlayTints, tints: merged(state.profileTints, overlayTints) };
    }),
  setProfileTints: (tints) =>
    set((state) => {
      const profileTints = tints.size === 0 ? NONE : tints;
      return { profileTints, tints: merged(profileTints, state.overlayTints) };
    }),
}));
