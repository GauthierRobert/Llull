/**
 * define_palette (plant 09 VIS Q5): pins an owner palette (a corporate paint system, a RAL list) so `apply_service_colour_scheme` draws its named colours from it instead of the
 * built-in approximate default. The palette is display data, never a standard value; a profile names its palette id and the reports repeat it.
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { changed, tableRejection } from '@core/commands/noop';
import { createDisplayModel, type DisplayPalette } from '@core/model/display';
import { isReservedKey } from '@lib/reservedKey';
import { PALETTE_ID } from './palette';

const MAX_COLOURS = 64;
const MAX_NAME = 40;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z][a-z0-9_-]{0,39}$/;

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_PALETTE_INVALID: `id: lowercase letters, digits, _ and - (not ${PALETTE_ID}); colours: 1..${MAX_COLOURS} distinct names (case-insensitive) of at most ${MAX_NAME} characters, each #rrggbb`,
  VIS_PALETTE_EXISTS: 'pass replace: true to overwrite it (profiles already built from it keep their colours until re-applied)',
};
const reject = tableRejection(REMEDIATION);

/**
 * @affects adds or replaces doc.display.palettes[id] (affected: []); metaHistory
 * @invariant colour names are stored lowercase; the default palette id is never stored; profiles built earlier are not recoloured
 * @failure bad id / colour / name, empty or oversized map, duplicate names -> VIS_PALETTE_INVALID; id taken without replace -> VIS_PALETTE_EXISTS
 */
export const definePalette = defineCommand({
  name: 'define_palette',
  description:
    'Define an owner display palette: named colours (e.g. "green", "white", "orange" or the ISO 14726 media colours) -> #rrggbb, for example the paint system of the facility. ' +
    'apply_service_colour_scheme with palette: <id> then draws the field / letter colours of the A13.1 or ISO 14726 rows from it (a name the palette lacks is refused: VIS_PALETTE_INCOMPLETE) ' +
    'and the profile names the palette id, which colour_by_rule_report repeats. Colour names compare case-insensitively and are stored lowercase. The palette is a display choice, never a ' +
    'standard value. Replacing a palette does not recolour profiles already built from it: re-apply the scheme. Does not change geometry or add a feature step. ' +
    'Errors: VIS_PALETTE_INVALID, VIS_PALETTE_EXISTS. data { paletteId, colours, replaced, profilesUsing[] }.',
  annotations: { metaHistory: true },
  params: z.object({
    id: z
      .string()
      .describe('Palette id, lowercase letters, digits, "_" and "-", e.g. "acme-paint-2026". Not the built-in llull-ral-approx-v1.'),
    name: z.string().optional().describe('Display name. Default: the id.'),
    colours: z
      .record(z.string(), z.string())
      .describe('Colour name -> #rrggbb, e.g. {"green": "#2e8b57", "white": "#ffffff"}. 1..64 entries.'),
    replace: z.boolean().optional().describe('true: overwrite an existing palette of this id. Default false.'),
  }),
  run: (doc, { id, name, colours, replace }): CommandResult => {
    const fail = (code: string, message: string, paths: string[]): CommandResult => reject(doc, 'define_palette', code, message, [], paths);
    if (!ID.test(id) || id === PALETTE_ID || isReservedKey(id))
      return fail('VIS_PALETTE_INVALID', `'${id}' is not a usable palette id`, ['id']);
    const entries = Object.entries(colours).map(([colour, hex]) => [colour.trim().toLowerCase(), hex] as const);
    if (entries.length === 0 || entries.length > MAX_COLOURS)
      return fail('VIS_PALETTE_INVALID', `a palette has 1..${MAX_COLOURS} colours, got ${entries.length}`, ['colours']);
    const bad = entries.find(([colour, hex]) => colour === '' || colour.length > MAX_NAME || isReservedKey(colour) || !HEX.test(hex));
    if (bad !== undefined)
      return fail('VIS_PALETTE_INVALID', `colour '${bad[0]}' -> '${bad[1]}' is not a usable name and #rrggbb`, [`colours.${bad[0]}`]);
    const repeated = entries.find(([colour], index) => entries.findIndex(([other]) => other === colour) !== index);
    if (repeated !== undefined)
      return fail('VIS_PALETTE_INVALID', `colour '${repeated[0]}' is named twice (names compare case-insensitively)`, ['colours']);
    const display = doc.display ?? createDisplayModel();
    const existing = Object.hasOwn(display.palettes ?? {}, id);
    if (existing && replace !== true) return fail('VIS_PALETTE_EXISTS', `palette '${id}' already exists`, ['id']);
    const palette: DisplayPalette = {
      id,
      name: name ?? id,
      colours: Object.fromEntries(entries.map(([colour, hex]) => [colour, hex.toLowerCase()])),
    };
    const profilesUsing = Object.values(display.colourProfiles)
      .filter((profile) => profile.palette === id)
      .map((profile) => profile.id);
    const summary =
      `Defined palette '${id}' (${entries.length} colour(s))${existing ? ', replaced' : ''}` +
      `${profilesUsing.length > 0 ? `; ${profilesUsing.length} profile(s) built from it keep their colours until the scheme is re-applied (${profilesUsing.join(', ')})` : ''}.`;
    return {
      ...changed({ ...doc, display: { ...display, palettes: { ...display.palettes, [id]: palette } } }, summary, []),
      data: { paletteId: id, colours: entries.length, replaced: existing, profilesUsing },
    };
  },
});
