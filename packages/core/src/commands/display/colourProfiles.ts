/** Colour profiles (plant 09 VIS §4): define, activate, delete. Display only and metaHistory: they never touch geometry or add a feature step. */

import { storeProfile } from '../../geometry/colourRules';
import { findProfile, type ColourProfile, type ColourRule, type DisplayModel, type RulePredicate } from '../../model/display';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { displayOf, displayRejection } from './displayModel';

const propertyValue = z.union([z.string(), z.number(), z.boolean()]);

const leafPredicate = z.object({
  property: z
    .string()
    .optional()
    .describe('Property key the clauses test, e.g. "layerName", "kind", "name", "tag", or a key a domain plugin adds.'),
  equals: propertyValue
    .optional()
    .describe('Match when the property equals this value (strings compare case-insensitively; numbers exact).'),
  in: z.array(propertyValue).optional().describe('Match when the property equals any of these values.'),
  matches: z
    .string()
    .optional()
    .describe('Case-insensitive regular expression tested against the property (max 200 characters, no back-references).'),
  range: z.array(z.number()).length(2).optional().describe('[low, high] inclusive; the property must be a number in the range.'),
});

const predicate = leafPredicate.extend({
  any: z.array(leafPredicate).optional().describe('OR of these predicates, ANDed with the clauses above (one level).'),
});

const ruleParam = z.object({
  id: z.string().describe('Rule id, unique in the profile, e.g. "water".'),
  when: predicate.describe(
    'Predicate on the entity property bag; all present clauses must hold. A missing property never matches. Rules are tried in order, first match wins.',
  ),
  colour: z.string().describe('Display colour #rrggbb.'),
  transparency: z.number().optional().describe('0 (opaque) .. 1 (invisible). Default opaque.'),
  hidden: z.boolean().optional().describe('true: matching entities are hidden in profile display.'),
  legend: z.string().describe('Legend text for the report, e.g. "Cooling water".'),
});

type PredicateParam = z.infer<typeof predicate>;

function cleanPredicate(source: PredicateParam): RulePredicate {
  const { property, equals, in: oneOf, matches, range } = source;
  const alternatives = source.any;
  return {
    ...(property !== undefined ? { property } : {}),
    ...(equals !== undefined ? { equals } : {}),
    ...(oneOf !== undefined ? { in: oneOf } : {}),
    ...(matches !== undefined ? { matches } : {}),
    ...(range !== undefined ? { range: [range[0] ?? 0, range[1] ?? 0] as const } : {}),
    ...(alternatives !== undefined ? { ['any']: alternatives.map(cleanPredicate) } : {}),
  };
}

function toRule(rule: z.infer<typeof ruleParam>): ColourRule {
  return {
    id: rule.id,
    when: cleanPredicate(rule.when),
    appearance: {
      colour: rule.colour.toLowerCase(),
      ...(rule.transparency !== undefined ? { transparency: rule.transparency } : {}),
      ...(rule.hidden !== undefined ? { hidden: rule.hidden } : {}),
    },
    legend: rule.legend,
  };
}

/**
 * @affects adds or replaces doc.display.colourProfiles[id] (affected: []); metaHistory
 * @invariant rule ids unique, regexes compile, colours #rrggbb; geometry untouched
 * @failure bad rule -> VIS_RULE_INVALID; bad colour -> VIS_COLOUR_INVALID; id taken without replace -> VIS_PROFILE_EXISTS
 */
export const defineColourProfile = defineCommand({
  name: 'define_colour_profile',
  description:
    'Define a display colour profile: an ordered list of rules, each a predicate on entity properties and a colour; the FIRST matching rule colours the entity, ' +
    'otherwise defaultColour. Properties come from the entity itself (id, kind, layerId, layerName, name, tag, materialId, componentId) and from installed domain plugins ' +
    '(each plugin documents the keys it adds). Display only: geometry is never changed. Activate it with set_active_colour_profile, ' +
    'inspect it with colour_by_rule_report and check_display. ' +
    'Errors: VIS_RULE_INVALID, VIS_COLOUR_INVALID, VIS_PROFILE_EXISTS (pass replace: true). Does not add a feature step.',
  annotations: { metaHistory: true },
  params: z.object({
    id: z.string().describe('Profile id, e.g. "by-layer".'),
    name: z.string().describe('Profile name for legends.'),
    rules: z.array(ruleParam).min(1).max(256).describe('1..256 rules in priority order (first match wins).'),
    defaultColour: z.string().optional().describe('Colour of entities no rule matches: "entity" (their own colour, default) or #rrggbb.'),
    palette: z.string().optional().describe('Name of the palette the colours were drawn from (default "custom"); reports echo it.'),
    reviewRequired: z.boolean().optional().describe('true flags the profile as awaiting approval by a qualified reviewer. Default false.'),
    replace: z.boolean().optional().describe('true: overwrite an existing profile with this id.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = []): CommandResult =>
      displayRejection(doc, 'define_colour_profile', code, message, [], paths);
    if (params.id.length === 0) return fail('VIS_RULE_INVALID', 'profile id is empty', ['id']);
    const display = displayOf(doc);
    if (findProfile(display, params.id) !== undefined && params.replace !== true)
      return fail('VIS_PROFILE_EXISTS', `profile '${params.id}' already exists`, ['id']);
    const profile: ColourProfile = {
      id: params.id,
      name: params.name,
      rules: params.rules.map(toRule),
      defaultColour: (params.defaultColour ?? 'entity').toLowerCase(),
      palette: params.palette ?? 'custom',
      reviewRequired: params.reviewRequired ?? false,
    };
    const stored = storeProfile(display, profile, false);
    if ('code' in stored) return fail(stored.code, stored.message, [stored.path]);
    const result = changed({ ...doc, display: stored }, `Defined colour profile '${profile.id}' (${profile.rules.length} rule(s)).`, []);
    return { ...result, data: { profileId: profile.id, ruleCount: profile.rules.length } };
  },
});

/**
 * @affects sets or clears doc.display.activeProfileId (affected: []); metaHistory
 * @failure unknown profile -> VIS_PROFILE_NOT_FOUND
 */
export const setActiveColourProfile = defineCommand({
  name: 'set_active_colour_profile',
  description:
    'Make a colour profile the active display profile (colour_by_rule_report and check_display default to it), or pass profileId null to show entity colours again. ' +
    'Geometry is untouched. Error: VIS_PROFILE_NOT_FOUND. Does not add a feature step.',
  annotations: { metaHistory: true },
  params: z.object({ profileId: z.string().nullable().describe('Profile id, or null to deactivate.') }),
  run: (doc, { profileId }): CommandResult => {
    const display = displayOf(doc);
    if (profileId !== null && findProfile(display, profileId) === undefined)
      return displayRejection(doc, 'set_active_colour_profile', 'VIS_PROFILE_NOT_FOUND', `no profile '${profileId}'`, [profileId]);
    const { colourProfiles } = display;
    const next: DisplayModel = profileId === null ? { colourProfiles } : { colourProfiles, activeProfileId: profileId };
    const summary = profileId === null ? 'Deactivated the colour profile.' : `Activated colour profile '${profileId}'.`;
    return { ...changed({ ...doc, display: next }, summary, []), data: { active: profileId } };
  },
});

/**
 * @affects removes doc.display.colourProfiles[profileId]; clears activeProfileId when it was active (affected: []); metaHistory
 * @failure unknown profile -> VIS_PROFILE_NOT_FOUND; a saved viewpoint references it -> VIS_PROFILE_IN_USE
 */
export const deleteColourProfile = defineCommand({
  name: 'delete_colour_profile',
  description:
    'Delete a colour profile (deactivates it when it was active). Refused while a saved viewpoint references it (VIS_PROFILE_IN_USE: update_viewpoint / delete_viewpoint first). ' +
    'Error: VIS_PROFILE_NOT_FOUND. Does not add a feature step.',
  annotations: { metaHistory: true, destructive: true },
  params: z.object({ profileId: z.string().describe('Profile id to delete.') }),
  run: (doc, { profileId }): CommandResult => {
    const display = displayOf(doc);
    if (findProfile(display, profileId) === undefined)
      return displayRejection(doc, 'delete_colour_profile', 'VIS_PROFILE_NOT_FOUND', `no profile '${profileId}'`, [profileId]);
    const users = Object.values(doc.review?.viewpoints ?? {})
      .filter((viewpoint) => viewpoint.colourProfileId === profileId)
      .map((viewpoint) => viewpoint.id);
    if (users.length > 0)
      return displayRejection(
        doc,
        'delete_colour_profile',
        'VIS_PROFILE_IN_USE',
        `profile '${profileId}' is used by ${users.join(', ')}`,
        users,
      );
    const colourProfiles = Object.fromEntries(Object.entries(display.colourProfiles).filter(([id]) => id !== profileId));
    const { activeProfileId } = display;
    const keepActive = activeProfileId !== undefined && activeProfileId !== profileId;
    const next: DisplayModel = keepActive ? { colourProfiles, activeProfileId } : { colourProfiles };
    return changed({ ...doc, display: next }, `Deleted colour profile '${profileId}'.`, []);
  },
});
