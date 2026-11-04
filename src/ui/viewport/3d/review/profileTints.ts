// The display colours as per-entity tints (the same precedence `render_view` uses, core `applyReviewStyle`): the active colour profile's
// first-match rules (core `compileProfile`), the assigned material class colour, the profile default colour. Pure, no three.js.
// Display only: a tint changes how an entity is drawn, never the document.

import { compileProfile, profileProblems } from '@core/geometry/colourRules';
import { entityPropertyBag } from '@core/geometry/entityProperties';
import { findProfile } from '@core/model/display';
import type { EntityPropertyProvider } from '@core/model/entityProperties';
import type { CadDocument } from '@core/model/types';
import { resolveTintColour } from './materialClassAppearance';

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * entity id -> `#rrggbb` for every entity the display colours: the first matching rule of the active profile, else the colour of its assigned
 * material class, else the profile's `defaultColour` (`'entity'` leaves the entity alone). Empty when nothing colours.
 * @invariant a profile that fails `profileProblems` colours nothing (class colours still apply)
 */
export function profileTints(doc: CadDocument, providers: readonly EntityPropertyProvider[]): ReadonlyMap<string, string> {
  const display = doc.display;
  const active = display?.activeProfileId === undefined ? undefined : findProfile(display, display.activeProfileId);
  const profile = active !== undefined && profileProblems(active).length === 0 ? active : undefined;
  if (profile === undefined && display?.materialClassOf === undefined) return NONE;
  const compiled = profile === undefined ? undefined : compileProfile(profile);
  const tints = new Map<string, string>();
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined) continue;
    const rule = compiled?.select(entityPropertyBag(doc, id, providers)) ?? null;
    const colour = resolveTintColour(display, entity, rule === null ? null : rule.appearance.colour, profile?.defaultColour);
    if (colour !== null && colour !== 'entity') tints.set(id, colour);
  }
  return tints.size === 0 ? NONE : tints;
}
