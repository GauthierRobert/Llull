/**
 * Civil drawing-sheet commands: plan sheet and plan-and-profile sheet (printable SVG).
 * @layer domain-aec/civil
 */

import type { CommandDefinition, CommandResult } from '@core/commands/types';
import { defineCommand, z, vec2 } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { safeFileName } from '@lib/safeFileName';
import { fileSlug, getBuilding } from '../model';
import { PAPER_SIZES } from '../sheet';
import { civilObject, getCivil } from './model';
import { buildCivilPlanSheet } from './civilPlanSheet';
import { buildPlanProfileSheet } from './planProfileSheet';

/**
 * @command export_civil_plan_sheet
 * @pure read-only
 * @affects none; data = { text, fileName, paper, scale, counts, layers, clipped }
 * @failure no civil entity / scale <= 0 / no matching layer -> no data
 */
export const exportCivilPlanSheet = defineCommand({
  name: 'export_civil_plan_sheet',
  description:
    'Printable civil plan drawing (SVG in real millimetres, print to PDF at 100 %): every civil ' +
    'entity (contours with labels, survey points, pads and daylight lines, alignment centreline ' +
    'with stations, corridor edges, manholes and pipes with labels) at a true scale 1:N on ISO paper ' +
    'A4-A0 landscape, clipped to the drawing viewport, with the title block from set_project_info, ' +
    'north arrow, scale bar, layer legend and, on a calibrated site (set_site_calibration), grid ' +
    'coordinate ticks. data.text holds the file, data.fileName its name.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    paper: z.enum(PAPER_SIZES).describe('Paper size, landscape: A4, A3, A2, A1 or A0.'),
    scale: z
      .number()
      .optional()
      .describe(
        'Scale denominator N for 1:N, e.g. 500 for 1:500 (> 0). Default: smallest standard scale that fits.',
      ),
    center: vec2('Plan point [x, y] (document units) at the centre of the viewport.').optional(),
    title: z.string().optional().describe('Drawing title. Default "Civil plan".'),
    layers: z
      .array(z.string())
      .optional()
      .describe('Civil layer names to draw, e.g. ["C-TOPO-MAJR", "C-ROAD-CNTR"]. Default: all.'),
  }),
  run: (doc, { paper, scale, center, title, layers }): CommandResult => {
    const sheet = buildCivilPlanSheet(doc, { paper, scale, center, title, layers });
    if (!sheet) {
      return noop(
        doc,
        'export_civil_plan_sheet failed: no civil entity on the requested layers (import survey / build a surface first) or scale <= 0.',
      );
    }
    const fileName = `${fileSlug(getBuilding(doc).project.name, 'site')}_civil_plan_${paper}_1-${sheet.scale}.svg`;
    return {
      document: doc,
      summary:
        `Civil plan sheet ${fileName}: ${sheet.drawn} entities drawn (${sheet.clipped} outside the viewport) ` +
        `at 1:${sheet.scale} on ${paper}, ${sheet.layers.length} layer(s).`,
      affected: [],
      data: {
        text: sheet.text,
        fileName,
        paper,
        scale: sheet.scale,
        center: sheet.center,
        counts: sheet.counts,
        layers: sheet.layers,
        clipped: sheet.clipped,
      },
    };
  },
});

/**
 * @command export_plan_profile_sheet
 * @pure read-only
 * @affects none; data = { text, fileName, paper, scale, fits }
 * @failure unknown alignment / no valid profile / invalid scale -> no data
 */
export const exportPlanProfileSheet = defineCommand({
  name: 'export_plan_profile_sheet',
  description:
    'Printable plan-and-profile sheet of an alignment (SVG, print to PDF at 100 %): a stationed ' +
    'plan strip (road edges, station ticks, horizontal curves with radius) above the long section ' +
    '(ground, design, PVIs, table band), both at the horizontal scale 1:N so stations line up. ' +
    'Needs set_alignment_profile. data.text holds the file, data.fileName its name.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    alignmentId: z.string().describe('Alignment id, e.g. "alignment-1".'),
    paper: z.enum(PAPER_SIZES).optional().describe('Paper size, landscape. Default A3.'),
    scale: z
      .number()
      .optional()
      .describe(
        'Horizontal scale denominator N for 1:N (> 0). Default: smallest standard scale that fits.',
      ),
    verticalExaggeration: z
      .number()
      .optional()
      .describe('Vertical / horizontal scale ratio (> 0). Default 10.'),
  }),
  run: (doc, { alignmentId, paper = 'A3', scale, verticalExaggeration = 10 }): CommandResult => {
    const alignment = civilObject(getCivil(doc), alignmentId, 'alignment');
    if (!alignment)
      return noop(doc, `export_plan_profile_sheet failed: no alignment ${alignmentId}.`);
    const sheet = buildPlanProfileSheet(doc, alignment, { paper, scale, verticalExaggeration });
    if (typeof sheet === 'string') return noop(doc, `export_plan_profile_sheet failed: ${sheet}`);
    const fileName = `${safeFileName(alignment.name, alignment.id)}_plan_profile_${paper}_1-${sheet.scale}.svg`;
    return {
      document: doc,
      summary:
        `Plan-profile sheet ${fileName}: ${alignment.name} at H 1:${sheet.scale}, VE x${verticalExaggeration} on ${paper}.` +
        (sheet.fits
          ? ''
          : ' WARNING: the long section is larger than the paper; use a larger paper, a smaller scale or lower verticalExaggeration.'),
      affected: [],
      data: { text: sheet.text, fileName, paper, scale: sheet.scale, fits: sheet.fits },
    };
  },
});

export const civilSheetCommands = [exportCivilPlanSheet, exportPlanProfileSheet] as ReadonlyArray<
  CommandDefinition<unknown>
>;
