import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { exportRefusal, report } from '@core/commands/noop';
import { sha256Hex } from '@lib/sha256';
import { refusePid } from '../dexpi/codes';
import { PID_CONVENTIONS } from '../model';
import { buildPidDrawing } from '../render/pidDrawing';
import { pidSvg } from '../render/pidSvg';
import { getPid } from '../state';

/** Same bound as the DEXPI export. */
const MAX_CHARACTERS = 30_000_000;

/**
 * @affects nothing (read-only query of `doc.plant.pid`; the drawing is in `data.svg`)
 * @invariant deterministic; one <g id="<item id>"> per item of the sheet; every text escaped and clipped to 48 characters; symbols from the built-in library at default size; the paper frame and title block of the shared sheet layout; the view box grows when items lie outside the paper
 * @failure unknown sheet -> PID_SHEET_NOT_FOUND; output over 30 million characters -> PID_EXPORT_TOO_LARGE; export-controlled content without confirmation -> MAT_EXPORT_CONTROLLED; the document is unchanged
 */
export const exportPidSvg = defineCommand({
  name: 'export_pid_svg',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Draw a P&ID sheet (doc.plant.pid) as SVG, read-only and deterministic: paper frame and title block (sheet number, title, revision, status, convention), then one group per item with id = the item id ' +
    '(data-kind, data-tag): equipment and nozzles, line numbers, segments with flow arrows, inline components, instrument bubbles (field = circle, central = one line, local panel = two lines, auxiliary = dashed line; ' +
    'shared display, PLC and software frames), signal lines (measuring thin, electric dashed, pneumatic and software chain), actuators with fail action, off-page connectors. Symbols come from the built-in library (list_pid_symbols) ' +
    'at default size, in sheet millimetres (the sheet is the paper, +y up); the drawing is not to scale and carries the sheet status. Texts are clipped to 48 characters. Returns data = { svg, widthMm, heightMm, sheet: { id, number, paper }, ' +
    'convention, glyphs, itemsOutsidePaper }; save with `llull export_pid_svg sheet=PID-001 --save pid-001.svg` (render_view-style PNG tools can look at it). Refusals (document unchanged): PID_SHEET_NOT_FOUND, PID_EXPORT_TOO_LARGE, MAT_EXPORT_CONTROLLED.',
  params: z.object({
    sheet: z.string().trim().min(1).describe('The sheet: its number (e.g. "PID-001") or id.'),
    scale: z
      .number()
      .min(0.1)
      .max(10)
      .optional()
      .describe('Output millimetres per sheet millimetre (width / height of the SVG). Default 1: the sheet is drawn 1:1 on its paper.'),
    convention: z
      .enum(PID_CONVENTIONS)
      .optional()
      .describe(
        'Symbol convention: ISA-5.1 (equipment as outlines with the class initial) or ISO-10628-2 (with internals). Default: the convention of the P&ID (set_pid_conventions).',
      ),
    confirmExportControlled,
  }),
  run: (doc, params, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_pid_svg', 'sheet', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    const pid = getPid(doc);
    const sheet = pid.sheets[params.sheet] ?? Object.values(pid.sheets).find((s) => s.number === params.sheet);
    if (sheet === undefined) return refusePid(doc, 'export_pid_svg', 'PID_SHEET_NOT_FOUND', `no sheet "${params.sheet}"`, [], ['sheet']);
    const drawing = buildPidDrawing(pid, sheet, params.convention);
    const drawn = pidSvg(drawing, params.scale ?? 1);
    if (drawn.svg.length > MAX_CHARACTERS)
      return refusePid(
        doc,
        'export_pid_svg',
        'PID_EXPORT_TOO_LARGE',
        `the drawing would have ${drawn.svg.length} characters (limit ${MAX_CHARACTERS})`,
        [],
        ['sheet'],
      );
    return report(
      doc,
      `export_pid_svg: ${sheet.number} (${sheet.paper}, ${drawing.convention}) drawn as ${drawing.glyphs.length} item group(s), ${drawn.widthMm} x ${drawn.heightMm} mm, ${drawn.svg.length} characters (sha256 ${sha256Hex(drawn.svg).slice(0, 12)})` +
        (drawn.outside === 0 ? '' : `; ${drawn.outside} item(s) lie outside the paper`),
      {
        svg: drawn.svg,
        widthMm: drawn.widthMm,
        heightMm: drawn.heightMm,
        sheet: { id: sheet.id, number: sheet.number, paper: sheet.paper },
        convention: drawing.convention,
        glyphs: drawing.glyphs.length,
        itemsOutsidePaper: drawn.outside,
      },
    );
  },
});
