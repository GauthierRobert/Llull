// The active colour profile as per-entity tints (the same first-match rules `render_view` uses, core `compileProfile`): pure, no three.js.
// Display only: a tint changes how an entity is drawn, never the document.

import { compileProfile, profileProblems } from '@core/geometry/colourRules';
import { entityPropertyBag } from '@core/geometry/entityProperties';
import { findProfile } from '@core/model/display';
import type { EntityPropertyProvider } from '@core/model/entityProperties';
import type { CadDocument } from '@core/model/types';

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * entity id -> `#rrggbb` for every entity the active profile colours: the first matching rule's colour, else the profile's `defaultColour`
 * (`'entity'` leaves the entity alone). Empty without an active, valid profile.
 * @invariant a profile that fails `profileProblems` colours nothing
 */
export function profileTints(doc: CadDocument, providers: readonly EntityPropertyProvider[]): ReadonlyMap<string, string> {
  const display = doc.display;
  if (display?.activeProfileId === undefined) return NONE;
  const profile = findProfile(display, display.activeProfileId);
  if (profile === undefined || profileProblems(profile).length > 0) return NONE;
  const compiled = compileProfile(profile);
  const tints = new Map<string, string>();
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined) continue;
    const rule = compiled.select(entityPropertyBag(doc, id, providers));
    const colour = rule === null ? profile.defaultColour : rule.appearance.colour;
    if (colour !== 'entity') tints.set(id, colour);
  }
  return tints.size === 0 ? NONE : tints;
}
