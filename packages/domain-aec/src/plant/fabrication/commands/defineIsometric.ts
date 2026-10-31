import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { PAPER_SIZES } from '@core/model/sheet';
import { analyseLine, isAnalysis } from '../analysis';
import { planSheets } from '../iso/isoSheets';
import type { IsoDefinition } from '../model';
import { getFabrication, withFabrication } from '../state';

/**
 * @affects plant.fabrication.isometrics[lineId] (one definition per line, replaced on redefinition) with the stored component-to-sheet assignment
 * @invariant the assignment keeps what is stored (components keep their sheet, new components follow their upstream neighbour, an overflowing sheet spills new components to a new sheet at the end) unless resetSheets; a sheet is cut only at a weld (or, with splitAt flange, a bolted joint) and stays connected
 * @failure unknown line -> ISO_LINE_NOT_FOUND; routed line without run -> ISO_NO_PIPING; the document is unchanged
 */
export const defineIsometric = defineCommand({
  name: 'define_isometric',
  description:
    'Define (or redefine) the isometric of a pipe line: style, paper, north arrow and how a line too large for one sheet is split. With maxPipePiecesPerSheet the line is cut into sheets of at most that many PIPE pieces; ' +
    'a cut lies only at a weld joint (splitAt weld, default) or at a flanged joint (splitAt flange), never inside a component, and each cut joint is printed on both sheets as "CONT. ON SHEET n - W<number>" / "CONT. FROM SHEET n - W<number>" ' +
    'with its coordinates. The sheet of every component is stored, so a later export_isometric after an edit keeps the existing components on their sheet (new components follow their upstream neighbour, an overflowing sheet spills ' +
    'new components to a new sheet appended at the end); run define_isometric again to store the new assignment, or pass resetSheets to cut afresh. Style spool gives one sheet per spool (spool_list) and ignores the budget. ' +
    'export_isometric and piping_bom scope sheet use this definition; without it a line is one sheet. Returns affected = [lineId] and data = { isoId (the line id), definition, sheets: [{ index, pipes, components, spool? }], continuations: ' +
    '[{ fromSheet, toSheet, weld, joint, at }], warnings }. Refusals (document unchanged): ISO_LINE_NOT_FOUND, ISO_NO_PIPING.',
  params: z.object({
    lineId: z.string().min(1).describe('The line: routed line id, imported PCF line number or legacy pipe line number.'),
    style: z
      .enum(['check', 'final', 'spool'])
      .optional()
      .describe(
        'check = drawing only; final (default) = with bom, cut_list, weld_list and spool_list tables; spool = one sheet per spool.',
      ),
    paper: z.enum(PAPER_SIZES).optional().describe('Paper size, landscape ISO A0..A4. Default A3.'),
    maxPipePiecesPerSheet: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Most PIPE pieces on one sheet; the line is split over sheets to respect it. Omit for one sheet. Ignored by style spool.'),
    splitAt: z
      .enum(['weld', 'flange'])
      .optional()
      .describe('Where a sheet may be cut: weld (default; any shop, site or field-fit weld joint) or flange (a bolted flange pair).'),
    northArrow: z
      .enum(['up_right', 'up_left'])
      .optional()
      .describe('Direction the plant north projects: up_right (default, 30 degrees) or up_left (150 degrees).'),
    resetSheets: z
      .boolean()
      .optional()
      .describe(
        'true = discard the stored sheet assignment and cut afresh (sheet numbers may change). Default false: stored assignments are kept.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const analysis = analyseLine(doc, 'define_isometric', params.lineId);
    if (!isAnalysis(analysis)) return analysis;
    const fabrication = getFabrication(doc);
    const previous = fabrication.isometrics?.[analysis.lineId];
    const style = params.style ?? 'final';
    const splitAt = params.splitAt ?? 'weld';
    const plan = planSheets(
      analysis,
      style === 'spool'
        ? { kind: 'spool' }
        : {
            kind: 'budget',
            splitAt,
            stored: params.resetSheets === true ? {} : (previous?.sheetAssignment ?? {}),
            ...(params.maxPipePiecesPerSheet === undefined ? {} : { budget: params.maxPipePiecesPerSheet }),
          },
    );
    const definition: IsoDefinition = {
      lineId: analysis.lineId,
      style,
      paper: params.paper ?? 'A3',
      ...(params.maxPipePiecesPerSheet === undefined ? {} : { maxPipePiecesPerSheet: params.maxPipePiecesPerSheet }),
      splitAt,
      northArrow: params.northArrow ?? 'up_right',
      sheetAssignment: style === 'spool' ? {} : plan.assignment,
    };
    const next = withFabrication(doc, { ...fabrication, isometrics: { ...fabrication.isometrics, [definition.lineId]: definition } });
    return {
      document: next,
      summary:
        `define_isometric: line ${analysis.name}: ${style} ${definition.paper}, ${plan.sheets.length} sheet(s) (${plan.sheets.map((sheet) => `${sheet.index}: ${sheet.pipes} pipe piece(s)`).join(', ')}), ` +
        `${plan.crossings.length} continuation joint(s)${previous === undefined ? '' : ', replaced the earlier definition'}` +
        `${plan.warnings.length === 0 ? '' : `; warnings: ${plan.warnings.map((warning) => warning.code).join(', ')}`}`,
      affected: [definition.lineId],
      data: {
        isoId: definition.lineId,
        definition,
        sheets: plan.sheets.map((sheet) => ({
          index: sheet.index,
          pipes: sheet.pipes,
          components: sheet.componentIds.length,
          ...(sheet.spool === undefined ? {} : { spool: sheet.spool }),
        })),
        continuations: plan.crossings.map((crossing) => ({
          fromSheet: crossing.fromSheet,
          toSheet: crossing.toSheet,
          weld: crossing.weld,
          joint: crossing.joint,
          at: crossing.xyz,
        })),
        warnings: plan.warnings,
      },
    };
  },
});
