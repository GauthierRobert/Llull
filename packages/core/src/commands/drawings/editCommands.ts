import { type DrawingSheet, type DrawingView, PROJECTION_ANGLES } from '../../model/sheet';
import type { CommandResult } from '../types';
import { defineCommand, vec2, z } from '../schema';
import { changed, noop } from '../noop';
import { omitKeys, defined, directionField, entityIdsField, entityProblem, paperField, scaleField } from './sheetParams';
import { findView, isRejection, requireSheet, withSheet, withView, withoutSheet } from './sheetOps';

/**
 * @affects patches the given fields of 1 DrawingView; affected = [viewId]
 * @invariant fields not given are kept; the view id, kind and mark never change
 * @failure unknown sheet / view, no field given, field not valid for the view kind, unknown entity -> no-op, affected:[]
 */
export const updateDrawingView = defineCommand({
  name: 'update_drawing_view',
  annotations: { idempotent: true },
  description:
    'Change a view on a drawing sheet: caption (label), direction (projection and section views), entityIds, scale, paper position, ' +
    'section plane offset (section views) or circle center/radius (detail views). Set autoPosition / autoScale to return to automatic ' +
    'layout / the sheet scale. Give at least one field; fields invalid for the view kind are rejected. Returns the view id.',
  params: z.object({
    sheetId: z.string().describe('Id of the sheet.'),
    viewId: z.string().describe('Id of the view to change.'),
    label: z.string().min(1).optional().describe('New caption.'),
    direction: directionField.optional().describe('New view direction (projection / section views; no iso for sections).'),
    entityIds: entityIdsField.optional(),
    scale: scaleField.optional().describe('Own scale denominator N of 1:N for this view.'),
    autoScale: z.boolean().optional().describe("true = drop the view's own scale (use the sheet scale)."),
    paperPosition: vec2('New view centre on the paper in millimetres.').optional(),
    autoPosition: z.boolean().optional().describe('true = drop the fixed position (automatic layout).'),
    offset: z.number().optional().describe('Section views: new cutting-plane coordinate on the viewing axis.'),
    center: vec2("Detail views: new circle centre in the parent view's model coordinates.").optional(),
    radius: z.number().positive().optional().describe('Detail views: new circle radius.'),
  }),
  run: (doc, params): CommandResult => {
    const sheet = requireSheet(doc, 'update_drawing_view', params.sheetId);
    if (isRejection(sheet)) return sheet;
    const view = findView(sheet, params.viewId);
    if (!view) return noop(doc, `update_drawing_view rejected: no view '${params.viewId}' on sheet ${params.sheetId}.`);
    const fail = (why: string): CommandResult => noop(doc, `update_drawing_view rejected: ${why}.`);
    const { direction, offset, center, radius } = params;
    if (direction !== undefined && view.kind === 'detail') return fail('a detail view has no direction');
    if (direction === 'iso' && view.kind === 'section') return fail('a section view cannot be iso');
    if (offset !== undefined && view.kind !== 'section') return fail('offset only applies to section views');
    if ((center !== undefined || radius !== undefined) && view.kind !== 'detail') return fail('center / radius only apply to detail views');
    const problem = params.entityIds === undefined ? null : entityProblem(doc, params.entityIds);
    if (problem !== null) return fail(problem);
    const rest = omitKeys(view, ['position', 'scale']);
    const keepPosition = params.autoPosition === true ? {} : defined({ position: params.paperPosition ?? view.position });
    const keepScale = params.autoScale === true ? {} : defined({ scale: params.scale ?? view.scale });
    const next: DrawingView = {
      ...rest,
      ...keepPosition,
      ...keepScale,
      ...defined({ label: params.label, direction, entityIds: params.entityIds }),
      ...(offset !== undefined && view.section ? { section: { ...view.section, offset } } : {}),
      ...(view.detail && (center !== undefined || radius !== undefined)
        ? { detail: { ...view.detail, center: center ?? view.detail.center, radius: radius ?? view.detail.radius } }
        : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(view))
      return noop(doc, `update_drawing_view: view ${view.id} already has these values; no-op.`);
    return changed(withSheet(doc, withView(sheet, next)), `Updated view ${view.id} on sheet ${sheet.id}.`, [view.id]);
  },
});

/**
 * @affects removes 1 view and every detail view drawn from it; sections drawn from it lose their cutting-plane line; affected = removed ids
 * @invariant other views and the sheet are unchanged
 * @failure unknown sheet / view -> no-op, affected:[]
 */
export const deleteDrawingView = defineCommand({
  name: 'delete_drawing_view',
  annotations: { destructive: true },
  description:
    'Remove a view from a drawing sheet. Detail views of the removed view are removed with it; section views that used it as parent ' +
    'are kept but no longer show a cutting-plane line. Returns the removed view ids in affected.',
  params: z.object({ sheetId: z.string().describe('Id of the sheet.'), viewId: z.string().describe('Id of the view to remove.') }),
  run: (doc, { sheetId, viewId }): CommandResult => {
    const sheet = requireSheet(doc, 'delete_drawing_view', sheetId);
    if (isRejection(sheet)) return sheet;
    if (!findView(sheet, viewId)) return noop(doc, `delete_drawing_view rejected: no view '${viewId}' on sheet ${sheetId}.`);
    const removed = new Set([viewId, ...sheet.views.filter((v) => v.detail?.parentViewId === viewId).map((v) => v.id)]);
    const views = sheet.views
      .filter((v) => !removed.has(v.id))
      .map((v): DrawingView => {
        if (v.section?.parentViewId !== viewId) return v;
        return { ...v, section: { offset: v.section.offset } };
      });
    return changed(withSheet(doc, { ...sheet, views }), `Removed view(s) ${[...removed].join(', ')} from sheet ${sheetId}.`, [...removed]);
  },
});

/**
 * @affects patches the given fields of 1 DrawingSheet; affected = [sheetId]
 * @invariant views are unchanged
 * @failure unknown sheet, no field given -> no-op, affected:[]
 */
export const updateSheet = defineCommand({
  name: 'update_sheet',
  annotations: { idempotent: true },
  description:
    'Change a drawing sheet: name, paper size, scale (or autoScale to auto-fit again), projection angle (first / third; re-lays out ' +
    'the automatic views) and title block fields. Give at least one field. Views are kept. Returns the sheet id.',
  params: z.object({
    sheetId: z.string().describe('Id of the sheet.'),
    name: z.string().min(1).optional().describe('New sheet name.'),
    paper: paperField.optional(),
    scale: scaleField.optional().describe('Sheet scale denominator N of 1:N (0.5 = 2:1).'),
    autoScale: z.boolean().optional().describe('true = drop the fixed scale and auto-fit.'),
    projectionAngle: z.enum(PROJECTION_ANGLES).optional().describe('"first" (ISO) or "third".'),
    title: z.string().optional().describe('Title block title.'),
    drawnBy: z.string().optional().describe('Title block drawn by.'),
    partNumber: z.string().optional().describe('Title block part number.'),
    revision: z.string().optional().describe('Title block revision.'),
    date: z.string().optional().describe('Title block date text, printed as given.'),
  }),
  run: (doc, params): CommandResult => {
    const sheet = requireSheet(doc, 'update_sheet', params.sheetId);
    if (isRejection(sheet)) return sheet;
    const { autoScale, scale } = params;
    const fields = omitKeys(params, ['sheetId', 'autoScale', 'scale']);
    if (Object.values({ ...fields, scale, autoScale }).every((value) => value === undefined))
      return noop(doc, `update_sheet rejected: give at least one field to change on sheet ${sheet.id}.`);
    const kept = omitKeys(sheet, ['scale']);
    const next: DrawingSheet = {
      ...kept,
      ...(autoScale === true ? {} : defined({ scale: scale ?? sheet.scale })),
      ...defined({ name: fields.name, paper: fields.paper, projectionAngle: fields.projectionAngle }),
      titleBlock: {
        ...sheet.titleBlock,
        ...defined({
          title: fields.title,
          drawnBy: fields.drawnBy,
          partNumber: fields.partNumber,
          revision: fields.revision,
          date: fields.date,
        }),
      },
    };
    return changed(withSheet(doc, next), `Updated sheet ${sheet.id} ("${next.name}", ${next.paper}).`, [sheet.id]);
  },
});

/**
 * @affects removes 1 DrawingSheet with its views; affected = [sheetId]
 * @invariant entities and other sheets are unchanged; `document.drawings` stays present (possibly empty)
 * @failure unknown sheet -> no-op, affected:[]
 */
export const deleteSheet = defineCommand({
  name: 'delete_sheet',
  annotations: { destructive: true },
  description: 'Delete a drawing sheet and all its views. The 3D model is not affected. Returns the sheet id in affected.',
  params: z.object({ sheetId: z.string().describe('Id of the sheet to delete.') }),
  run: (doc, { sheetId }): CommandResult => {
    const sheet = requireSheet(doc, 'delete_sheet', sheetId);
    if (isRejection(sheet)) return sheet;
    return changed(withoutSheet(doc, sheetId), `Deleted sheet ${sheetId} ("${sheet.name}") with ${sheet.views.length} view(s).`, [sheetId]);
  },
});
