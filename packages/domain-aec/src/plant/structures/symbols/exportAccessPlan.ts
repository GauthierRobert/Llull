import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { sha256Hex } from '@lib/sha256';
import { getBuilding } from '@aec/building/model';
import { refuse } from '../codes';
import { planDxf, planSvg } from './planOutput';
import { planSymbols } from './planSymbols';

const COMMAND = 'export_access_plan';

/**
 * @affects none (query: returns the same document; the drawings are in `data.files[]`)
 * @invariant model space in millimetres 1:1, +y up; the same primitive list is printed as SVG and DXF; deterministic (no clock), bytes depend on the model only
 * @failure unknown levelId -> STA_UNKNOWN_ELEMENT; nothing to draw -> STA_NOTHING_TO_DRAW; export-controlled content without confirmation -> MAT_EXPORT_CONTROLLED
 */
export const exportAccessPlan = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true },
  description:
    'Draw the plan symbols of the access elements of the BUILDING model as SVG and / or DXF R12: platforms and gratings (panel outlines on S-PLAT / S-GRAT with a hatch along the bearing bars and the label "AS1 EL +6000"), ' +
    'fixed ladders (S-LADR: rectangle with dividers, the cage circle, an arrow along the facing direction, the label "LD1 H=6000"), steel stairs (S-STAR: outline, tread lines, landings, the climb arrow and "SS1 UP 17 R"), ' +
    'and railings (S-RAIL: a line along the guarded stretches with a square tick at every post; gate openings on S-GATE). Model space, millimetres 1:1, +y up, whatever the document units; text is 150 mm high. ' +
    'Pass levelId to draw one level. Returns data = { files: [{ name, format, content, sha256 }], counts: { platforms, gratingPanels, ladders, stairs, railings }, primitives, widthMm, heightMm }; save with llull export_access_plan --save <dir>. ' +
    'Read-only; the building floor plan (export_building_dxf) does not draw these elements.',
  params: z.object({
    levelId: z.string().min(1).optional().describe('Draw only the elements of this building level (add_level id). Default: every level.'),
    formats: z
      .array(z.enum(['svg', 'dxf']))
      .min(1)
      .optional()
      .describe('Output formats. Default ["svg"].'),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, COMMAND, 'sheet', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const building = getBuilding(doc);
    if (params.levelId !== undefined && building.levels[params.levelId] === undefined)
      return refuse(doc, COMMAND, 'STA_UNKNOWN_ELEMENT', `no building level ${params.levelId}`, [params.levelId], ['levelId']);
    const symbols = planSymbols(doc, building, params.levelId);
    const { counts } = symbols;
    if (symbols.primitives.length === 0)
      return refuse(doc, COMMAND, 'STA_NOTHING_TO_DRAW', 'the model has no access element to draw', [], ['levelId']);
    const title = `Access plan${params.levelId === undefined ? '' : ` ${building.levels[params.levelId]?.name ?? params.levelId}`}`;
    const drawn = planSvg(symbols.primitives, title);
    const files = [...new Set(params.formats ?? ['svg'])].map((format) => {
      const content = format === 'svg' ? drawn.svg : planDxf(symbols.primitives);
      return { name: `access_plan.${format}`, format, content, sha256: sha256Hex(content) };
    });
    return report(
      doc,
      `${COMMAND}: ${counts.platforms} platform(s), ${counts.gratingPanels} grating panel(s), ${counts.ladders} ladder(s), ${counts.stairs} steel stair(s), ${counts.railings} railing(s) as ` +
        `${symbols.primitives.length} primitive(s), ${drawn.widthMm} x ${drawn.heightMm} mm: ${files.map((file) => file.name).join(', ')}.`,
      { files, counts, primitives: symbols.primitives.length, widthMm: drawn.widthMm, heightMm: drawn.heightMm },
    );
  },
});
