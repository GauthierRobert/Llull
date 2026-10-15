import type { DrawingSheet, DrawingView } from '../../model/sheet';
import { PROJECTION_ANGLES, VIEW_DIRECTIONS } from '../../model/sheet';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { nextId } from '../../lib/id';
import { changed, noop } from '../noop';
import { DIRECTION_LABELS, defined, entityIdsField, entityProblem, hasSolids, paperField, scaleField } from './sheetParams';
import { sheetList, withSheet } from './sheetOps';

/**
 * @affects adds 1 DrawingSheet (+ the requested projection views); affected = [sheetId, ...viewIds]
 * @invariant stores recipes only (directions, entity ids); view geometry is derived by export_sheet_svg
 * @failure unknown / 2D entity id, `views` requested with no 3D solid in the document -> no-op, affected:[]
 */
export const createSheet = defineCommand({
  name: 'create_sheet',
  description:
    'Create a drawing sheet: ISO paper with a frame and title block that documents the 3D model as orthographic line views. ' +
    'Pass `views` (e.g. ["front","top","right"]) to add standard projection views in one call, laid out automatically per the ' +
    'first-angle (ISO default) or third-angle convention. Views are live: they reference the model, so after the model changes ' +
    'export_sheet_svg shows the new geometry without editing the sheet. Add more with create_drawing_view, add_section_view, ' +
    'add_detail_view. Returns the sheet id then the view ids in affected. Omit `scale` to auto-fit the largest standard scale.',
  params: z.object({
    name: z.string().min(1).optional().describe('Sheet name, e.g. "Bracket". Default "Sheet N".'),
    paper: paperField.optional().describe('Paper size (landscape). Default A3.'),
    scale: scaleField.optional().describe('Sheet scale denominator N of 1:N (0.5 = 2:1). Omit to auto-fit.'),
    title: z.string().optional().describe('Title block title. Default: the sheet name.'),
    drawnBy: z.string().optional().describe('Title block "drawn by".'),
    partNumber: z.string().optional().describe('Title block part / drawing number.'),
    revision: z.string().optional().describe('Title block revision, e.g. "A".'),
    date: z.string().optional().describe('Title block date text, e.g. "2026-03-14". Printed as given.'),
    projectionAngle: z
      .enum(PROJECTION_ANGLES)
      .optional()
      .describe('"first" (ISO / Europe, default: top view below the front view) or "third" (US: top view above the front view).'),
    views: z
      .array(z.enum(VIEW_DIRECTIONS))
      .optional()
      .describe('Standard projection views to create now, e.g. ["front","top","right"] or ["front","top","right","iso"].'),
    entityIds: entityIdsField.optional(),
  }),
  run: (doc, params): CommandResult => {
    const { views: directions = [], entityIds } = params;
    if (entityIds !== undefined) {
      const problem = entityProblem(doc, entityIds);
      if (problem !== null) return noop(doc, `create_sheet rejected: ${problem}.`);
    }
    if (directions.length > 0 && entityIds === undefined && !hasSolids(doc)) {
      return noop(
        doc,
        'create_sheet rejected: the document has no 3D solids to project; add solids first or create the sheet without views.',
      );
    }
    const id = nextId('sheet');
    const name = params.name ?? `Sheet ${sheetList(doc).length + 1}`;
    const views = directions.map(
      (direction): DrawingView => ({
        id: nextId('view'),
        label: DIRECTION_LABELS[direction],
        kind: 'projection',
        direction,
        ...(entityIds === undefined ? {} : { entityIds: [...entityIds] }),
      }),
    );
    const sheet: DrawingSheet = {
      id,
      name,
      paper: params.paper ?? 'A3',
      ...(params.scale === undefined ? {} : { scale: params.scale }),
      titleBlock: {
        title: params.title ?? name,
        ...defined({ drawnBy: params.drawnBy, partNumber: params.partNumber, revision: params.revision, date: params.date }),
      },
      projectionAngle: params.projectionAngle ?? 'first',
      views,
    };
    const shown = views.length > 0 ? ` with ${views.length} view(s): ${views.map((v) => `${v.id} (${v.label})`).join(', ')}` : '';
    return changed(withSheet(doc, sheet), `Created sheet ${id} ("${name}", ${sheet.paper}, ${sheet.projectionAngle}-angle)${shown}.`, [
      id,
      ...views.map((v) => v.id),
    ]);
  },
});
