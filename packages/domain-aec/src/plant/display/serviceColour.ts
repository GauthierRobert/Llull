/**
 * Service colour schemes (plant 09 VIS §4, §5.1): list the ASME A13.1 / ISO 14726 tables and build a first-match colour profile that tints pipes
 * by service. The service -> category mapping is an engineering decision, so it is always an explicit input (`serviceMap`), never guessed.
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, report, tableRejection } from '@core/commands/noop';
import { storeProfile } from '@core/geometry/colourRules';
import { createDisplayModel, type ColourProfile, type ColourRule } from '@core/model/display';
import { PALETTE_ID, paletteHex } from './palette';
import { SCHEME_IDS, SCHEME_STANDARDS, findRow, legendOf, rowsOf, type SchemeId, type SchemeRow } from './serviceSchemes';

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_SCHEME_UNKNOWN: `use one of ${SCHEME_IDS.join(', ')}; list_service_colour_schemes shows the tables`,
  VIS_SCHEME_CATEGORY_UNKNOWN: 'list_service_colour_schemes shows the categories of the scheme',
  VIS_RULE_INVALID: 'give a non-empty serviceMap of distinct service texts (case-insensitive) and a property name',
};

const reject = tableRejection(REMEDIATION);

const isSchemeId = (value: string): value is SchemeId => (SCHEME_IDS as readonly string[]).includes(value);

/** Neutral grey for a colour name the palette lacks (a test asserts every table row resolves, so this is a guard only). */
const NO_PALETTE_COLOUR = '#808080';

const displayHex = (row: SchemeRow): string => paletteHex(row.names['fieldColour'] ?? row.names['mainColour'] ?? '') ?? NO_PALETTE_COLOUR;

/** @affects nothing — read-only; data.schemes [{ scheme, standard, palette, approximate, rows[] }] */
export const listServiceColourSchemes = defineCommand({
  name: 'list_service_colour_schemes',
  description:
    'List the pipe-content colour schemes llull can apply with apply_service_colour_scheme: asme_a13_1 (ASME A13.1 marker colours: fire_quenching, toxic_corrosive, ' +
    'flammable_oxidizing, combustible, water, compressed_air, user_defined_1..4) and iso_14726 (ISO 14726 main colours by medium: fresh water, sea water, fuel, steam, ...). ' +
    'Each row has its category, named colours (fieldColour + letterColour, or mainColour), source ids, grade (A = two or more extracts agree) and any conflict between sources, ' +
    'plus displayHex from the default palette (approximate: a display choice, never a standard value). Standards are paywalled: transcribed from public extracts, not authoritative. Read-only. Error: VIS_SCHEME_UNKNOWN.',
  annotations: { readOnly: true },
  params: z.object({ scheme: z.string().optional().describe('"asme_a13_1" or "iso_14726". Default: both.') }),
  run: (doc, { scheme }): CommandResult => {
    if (scheme !== undefined && !isSchemeId(scheme))
      return reject(doc, 'list_service_colour_schemes', 'VIS_SCHEME_UNKNOWN', `no scheme '${scheme}'`, [], ['scheme']);
    const wanted = scheme === undefined ? SCHEME_IDS : [scheme as SchemeId];
    const schemes = wanted.map((id) => ({
      scheme: id,
      standard: SCHEME_STANDARDS[id],
      palette: PALETTE_ID,
      approximate: true,
      rows: rowsOf(id).map((row) => ({ ...row, displayHex: displayHex(row) })),
    }));
    return report(
      doc,
      `${schemes.length} scheme(s), ${schemes.reduce((sum, entry) => sum + entry.rows.length, 0)} row(s); palette ${PALETTE_ID} (approximate).`,
      { schemes },
    );
  },
});

/**
 * @affects adds or replaces doc.display.colourProfiles[profileId]; sets activeProfileId when activate (affected: []); metaHistory
 * @invariant one rule per mapped service in map order, matching the `property` case-insensitively; reviewRequired is always true; geometry untouched
 * @failure unknown scheme -> VIS_SCHEME_UNKNOWN; category not in the scheme -> VIS_SCHEME_CATEGORY_UNKNOWN; empty or duplicate map -> VIS_RULE_INVALID
 */
export const applyServiceColourScheme = defineCommand({
  name: 'apply_service_colour_scheme',
  description:
    'Build a colour profile that tints pipes by service from ASME A13.1 (scheme "asme_a13_1") or ISO 14726 ("iso_14726"): serviceMap maps each service text of the model ' +
    '(e.g. "cooling water") to a category of the scheme (e.g. "water"; ISO: the medium, e.g. "sea water"; see list_service_colour_schemes). YOU decide the mapping: llull never guesses a hazard class from text. ' +
    'One rule per mapped service, in map order, first match wins; the pipe is tinted with the row field / main colour from the default palette (approximate display hex). ' +
    'data { profileId, mapped, unmapped[] (services in the model absent from the map: they keep their own colour), reviewRequired: true }. The profile is flagged reviewRequired: ' +
    'a qualified reviewer must approve the mapping before the colours are used on a deliverable. Follow with colour_by_rule_report and check_display. Re-running with the same profileId replaces it. ' +
    'Errors: VIS_SCHEME_UNKNOWN, VIS_SCHEME_CATEGORY_UNKNOWN. Does not change geometry or add a feature step.',
  annotations: { metaHistory: true },
  params: z.object({
    scheme: z.string().describe('"asme_a13_1" or "iso_14726".'),
    profileId: z.string().describe('Id of the colour profile to create or replace, e.g. "services-asme".'),
    serviceMap: z
      .record(z.string(), z.string())
      .describe(
        'Service text -> scheme category, e.g. {"cooling water": "water", "natural gas": "flammable_oxidizing"}. Service texts compare case-insensitively.',
      ),
    property: z.string().optional().describe('Entity property holding the service text. Default "service".'),
    activate: z.boolean().optional().describe('true: also make the profile the active display profile.'),
  }),
  run: (doc, { scheme, profileId, serviceMap, property = 'service', activate }, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: string[] = [], paths: string[] = []): CommandResult =>
      reject(doc, 'apply_service_colour_scheme', code, message, ids, paths);
    if (!isSchemeId(scheme)) return fail('VIS_SCHEME_UNKNOWN', `no scheme '${scheme}'`, [], ['scheme']);
    const entries = Object.entries(serviceMap);
    if (entries.length === 0 || property.length === 0)
      return fail('VIS_RULE_INVALID', 'serviceMap is empty or property is blank', [], ['serviceMap']);
    const lowered = entries.map(([service]) => service.toLowerCase());
    const repeated = lowered.find((service, index) => lowered.indexOf(service) !== index);
    if (repeated !== undefined)
      return fail('VIS_RULE_INVALID', `service '${repeated}' is mapped twice (texts compare case-insensitively)`, [], ['serviceMap']);
    const rows = entries.map(([service, category]) => ({ service, row: findRow(scheme, category) }));
    const unknown = rows.filter((entry) => entry.row === undefined);
    if (unknown.length > 0)
      return fail(
        'VIS_SCHEME_CATEGORY_UNKNOWN',
        `no ${scheme} category for ${unknown.map((entry) => `'${entry.service}' -> '${serviceMap[entry.service]}'`).join(', ')}`,
        [],
        unknown.map((entry) => `serviceMap.${entry.service}`),
      );
    const rules: ColourRule[] = rows.flatMap(({ service, row }) =>
      row === undefined
        ? []
        : [
            {
              id: `${row.id}:${service}`,
              when: { property, equals: service },
              appearance: { colour: displayHex(row) },
              legend: `${service}: ${legendOf(row)}`,
              scheme: { id: scheme, rowId: row.id, category: row.category, names: row.names },
            },
          ],
    );
    const profile: ColourProfile = {
      id: profileId,
      name: `${scheme} service colours`,
      rules,
      defaultColour: 'entity',
      palette: PALETTE_ID,
      reviewRequired: true,
    };
    const stored = storeProfile(doc.display ?? createDisplayModel(), profile, activate === true);
    if ('code' in stored) return fail(stored.code, stored.message, [], [stored.path === 'id' ? 'profileId' : stored.path]);
    const read = ctx?.properties;
    const present = new Set<string>();
    for (const id of doc.order) {
      const value = read?.(doc, id)[property];
      for (const text of value === undefined ? [] : typeof value === 'object' ? value : [value]) present.add(String(text));
    }
    const mapped = new Set(lowered);
    const unmapped = [...present].filter((text) => !mapped.has(text.toLowerCase())).sort();
    const summary =
      `Built colour profile '${profileId}' from ${scheme}: ${rules.length} service(s) mapped, ${unmapped.length} unmapped${unmapped.length > 0 ? ` (${unmapped.join(', ')})` : ''}; ` +
      `review required: a qualified reviewer must approve the mapping${activate === true ? '; activated' : ''}.`;
    return {
      ...changed({ ...doc, display: stored }, summary, []),
      data: { profileId, mapped: rules.length, unmapped, reviewRequired: true },
    };
  },
});
