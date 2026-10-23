/** colour_by_rule_report (plant 09 VIS §4): which rule colours which entity, grouped; read-only. */

import { findProfile, type ColourProfile } from '../../model/display';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { displayOf, displayRejection, evaluateProfile, type EntityDisplay } from './displayModel';

interface Group {
  readonly key: string;
  readonly ruleIds: Set<string>;
  readonly first: EntityDisplay;
  readonly ids: string[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type GroupBy = 'entity' | 'rule' | 'property';

function groupKey(groupBy: GroupBy, groupProperty: string, row: EntityDisplay): string {
  if (groupBy === 'entity') return row.id;
  if (groupBy === 'rule') return row.rule?.id ?? '(default)';
  const value = Object.hasOwn(row.bag, groupProperty) ? row.bag[groupProperty] : undefined;
  return value === undefined ? '(none)' : String(value);
}

/** Resolved fields of a group: the rule of its first entity, so every group names its category and colours (null when unmatched). */
function groupFields(group: Group, profile: ColourProfile): Record<string, unknown> {
  const rule = group.first.rule;
  const defaultHex = profile.defaultColour === 'entity' ? null : profile.defaultColour;
  return {
    ...(rule?.scheme?.names ?? {}),
    category: rule?.scheme?.category ?? null,
    ruleId: rule?.id ?? null,
    ruleIds: [...group.ruleIds].sort(compareText),
    displayHex: rule?.appearance.colour ?? defaultHex,
    count: group.ids.length,
    ids: group.ids,
  };
}

/** @affects nothing — read-only; data { palette, approximate, groups, legend, unmatched, warnings } */
export const colourByRuleReport = defineCommand({
  name: 'colour_by_rule_report',
  description:
    'Report which colour rule colours which entity under a colour profile (default: the active one): data.groups keyed by rule (default), by entity id, or by the value of one property (groupBy "property" + groupProperty, e.g. "line"), ' +
    'each with ruleId, category and the named colours of the rule source (when the rule came from a scheme), displayHex, count and ids; data.legend lists every rule with its count; ' +
    'data.unmatched lists entities that carry a property the profile tests but matched no rule (warning VIS_COLOUR_UNMATCHED); entities with none of those properties are out of scope (data.outOfScope). ' +
    'Colours are NAMED categories; displayHex comes from the profile palette (data.palette, approximate: true) and is a display choice, not a standard value. Order: rule order, then key. ' +
    'Error: VIS_PROFILE_NOT_FOUND. Read-only.',
  annotations: { readOnly: true },
  params: z.object({
    profileId: z.string().optional().describe('Colour profile id. Default: the active profile.'),
    entityIds: z.array(z.string()).optional().describe('Entities to report. Default: every entity of the document.'),
    groupBy: z.enum(['entity', 'rule', 'property']).optional().describe('"rule" (default), "entity" or "property" (needs groupProperty).'),
    groupProperty: z
      .string()
      .optional()
      .describe('Property key whose value names the groups when groupBy is "property", e.g. "layerName".'),
    limit: z.number().int().optional().describe('Return at most this many groups (the count of all groups is data.groupCount).'),
  }),
  run: (doc, { profileId, entityIds, groupBy = 'rule', groupProperty, limit }, ctx): CommandResult => {
    const display = displayOf(doc);
    const id = profileId ?? display.activeProfileId;
    const profile = id === undefined ? undefined : findProfile(display, id);
    if (profile === undefined)
      return displayRejection(
        doc,
        'colour_by_rule_report',
        'VIS_PROFILE_NOT_FOUND',
        id === undefined ? 'no profileId given and no active profile' : `no profile '${id}'`,
        id === undefined ? [] : [id],
      );
    if (groupBy === 'property' && (groupProperty === undefined || groupProperty.length === 0))
      return displayRejection(
        doc,
        'colour_by_rule_report',
        'VIS_GROUP_PROPERTY_MISSING',
        'groupBy "property" needs groupProperty',
        [],
        ['groupProperty'],
      );
    const requested = entityIds ?? doc.order;
    const rows = evaluateProfile(doc, ctx, profile, requested);
    const scoped = rows.filter((row) => row.inScope);
    const groups = new Map<string, Group>();
    for (const row of scoped) {
      const key = groupKey(groupBy, groupProperty ?? '', row);
      const group = groups.get(key) ?? { key, ruleIds: new Set<string>(), first: row, ids: [] };
      group.ruleIds.add(row.rule?.id ?? '(default)');
      group.ids.push(row.id);
      groups.set(key, group);
    }
    const ruleIndex = (group: Group): number => {
      const index = profile.rules.findIndex((rule) => rule.id === group.first.rule?.id);
      return index < 0 ? profile.rules.length : index;
    };
    const ordered = [...groups.values()].sort((a, b) => ruleIndex(a) - ruleIndex(b) || compareText(a.key, b.key));
    for (const group of ordered) group.ids.sort(compareText);
    const shown = limit === undefined ? ordered : ordered.slice(0, Math.max(0, limit));
    const unmatched = scoped
      .filter((row) => row.rule === null)
      .map((row) => row.id)
      .sort(compareText);
    const counts = new Map<string, number>();
    for (const row of scoped) if (row.rule !== null) counts.set(row.rule.id, (counts.get(row.rule.id) ?? 0) + 1);
    const legend = profile.rules.map((rule) => ({
      ...(rule.scheme?.names ?? {}),
      ruleId: rule.id,
      legend: rule.legend,
      category: rule.scheme?.category ?? null,
      displayHex: rule.appearance.colour,
      count: counts.get(rule.id) ?? 0,
    }));
    const warnings =
      unmatched.length > 0
        ? [
            {
              code: 'VIS_COLOUR_UNMATCHED',
              ids: unmatched,
              message: `${unmatched.length} entit${unmatched.length === 1 ? 'y' : 'ies'} matched no rule and keep the default colour`,
              remediation: 'extend the profile rules, or accept the default',
            },
          ]
        : [];
    const data = {
      profileId: profile.id,
      palette: profile.palette,
      approximate: true,
      reviewRequired: profile.reviewRequired,
      groupBy,
      groupCount: ordered.length,
      groups: Object.fromEntries(shown.map((group) => [group.key, groupFields(group, profile)])),
      legend,
      unmatched,
      outOfScope: rows.length - scoped.length,
      unknownIds: requested.filter((entity) => doc.entities[entity] === undefined),
      warnings,
    };
    const summary =
      `Profile '${profile.id}' (palette ${profile.palette}, approximate): ${scoped.length} entit${scoped.length === 1 ? 'y' : 'ies'} in ${ordered.length} group(s) by ${groupBy}, ` +
      `${unmatched.length} unmatched, ${rows.length - scoped.length} out of scope${profile.reviewRequired ? '; review required (not approved)' : ''}.`;
    return report(doc, summary, data);
  },
});
