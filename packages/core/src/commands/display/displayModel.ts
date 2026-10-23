/** Shared helpers of the display commands (plant 09 VIS): the display section, coded refusals (§7), property reads and profile evaluation. */

import { compileProfile, referencedProperties } from '../../geometry/colourRules';
import { coreEntityProperties } from '../../geometry/entityProperties';
import { createDisplayModel, type ColourProfile, type ColourRule, type DisplayModel } from '../../model/display';
import type { PropertyBag } from '../../model/entityProperties';
import type { CadDocument } from '../../model/types';
import { tableRejection } from '../noop';
import type { ExecutionContext } from '../types';

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_PROFILE_NOT_FOUND: 'list the profiles with check_display, or create one with define_colour_profile / apply_service_colour_scheme',
  VIS_PROFILE_EXISTS: 'pass replace: true to overwrite the profile, or choose another id',
  VIS_RULE_INVALID:
    'fix the rule at the reported path: every rule needs a unique id and a predicate with a clause (regex <= 200 chars, range low <= high)',
  VIS_COLOUR_INVALID: 'use #rrggbb (scheme colours are resolved by apply_service_colour_scheme)',
};

export const displayRejection = tableRejection(REMEDIATION);

export function displayOf(doc: CadDocument): DisplayModel {
  return doc.display ?? createDisplayModel();
}

/** The property bag of `entityId` through the context's installed providers; core keys only without a context reader. */
export const readProperties = (doc: CadDocument, entityId: string, ctx: ExecutionContext | undefined): PropertyBag =>
  ctx?.properties !== undefined ? ctx.properties(doc, entityId) : coreEntityProperties(doc, entityId);

export interface EntityDisplay {
  readonly id: string;
  readonly bag: PropertyBag;
  /** True when the entity has at least one property the profile's rules test (otherwise the profile does not concern it). */
  readonly inScope: boolean;
  /** The first matching rule, or null (falls through to the profile default). */
  readonly rule: ColourRule | null;
}

/** Evaluate `profile` for `ids` (document order is the caller's). Unknown ids are skipped. */
export function evaluateProfile(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  profile: ColourProfile,
  ids: readonly string[],
): EntityDisplay[] {
  const compiled = compileProfile(profile);
  const keys = referencedProperties(profile);
  return ids
    .filter((id) => doc.entities[id] !== undefined)
    .map((id) => {
      const bag = readProperties(doc, id, ctx);
      return { id, bag, inScope: [...keys].some((key) => Object.hasOwn(bag, key)), rule: compiled.select(bag) };
    });
}
