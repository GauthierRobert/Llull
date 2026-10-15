import type { DrawingSheet, DrawingView } from '../../model/sheet';
import type { CommandResult } from '../types';
import { defineCommand, vec2, z } from '../schema';
import { nextId } from '../../lib/id';
import { changed, noop } from '../noop';
import { DIRECTION_LABELS, defined, directionField, entityIdsField, entityProblem, hasSolids, scaleField } from './sheetParams';
import { findView, isRejection, nextMark, requireSheet, withSheet, withView } from './sheetOps';

/** The sheet with `view` added, as a command result. */
const addedView = (doc: Parameters<typeof withSheet>[0], sheet: DrawingSheet, view: DrawingView, summary: string): CommandResult =>
  changed(withSheet(doc, withView(sheet, view)), summary, [view.id]);

/**
 * @affects adds 1 projection DrawingView to the sheet; affected = [viewId]
 * @invariant stores the direction and entity ids only; geometry is derived at export
 * @failure unknown sheet, unknown / 2D entity id, no 3D solids -> no-op, affected:[]
 */
export const createDrawingView = defineCommand({
  name: 'create_drawing_view',
  description:
    'Add an orthographic projection view (front, back, left, right, top, bottom or iso) of the 3D model to a drawing sheet. ' +
    'Visible edges are drawn thick, hidden edges dashed, circular features get centre lines. Position is automatic ' +
    '(first/third-angle layout around the front view) unless `paperPosition` is given. Returns the new view id in affected.',
  params: z.object({
    sheetId: z.string().describe('Id of the sheet (from create_sheet).'),
    direction: directionField,
    label: z.string().optional().describe('Caption under the view. Default: the direction name in capitals, e.g. "FRONT".'),
    entityIds: entityIdsField.optional(),
    paperPosition: vec2('Centre of the view on the paper in millimetres from the top-left corner. Omit for automatic layout.').optional(),
    scale: scaleField.optional().describe('Own scale denominator N of 1:N for this view. Omit to use the sheet scale.'),
  }),
  run: (doc, { sheetId, direction, label, entityIds, paperPosition, scale }): CommandResult => {
    const sheet = requireSheet(doc, 'create_drawing_view', sheetId);
    if (isRejection(sheet)) return sheet;
    const problem =
      entityIds === undefined ? (hasSolids(doc) ? null : 'the document has no 3D solids to project') : entityProblem(doc, entityIds);
    if (problem !== null) return noop(doc, `create_drawing_view rejected: ${problem}.`);
    const view: DrawingView = {
      id: nextId('view'),
      label: label ?? DIRECTION_LABELS[direction],
      kind: 'projection',
      direction,
      ...defined({ entityIds, position: paperPosition, scale }),
    };
    return addedView(doc, sheet, view, `Added ${direction} view ${view.id} to sheet ${sheetId}.`);
  },
});

/**
 * @affects adds 1 section DrawingView (hatched cut faces); affected = [viewId]
 * @invariant the parent view, when given, shows the cutting-plane line with sight arrows and the letter
 * @failure unknown sheet / parent view, parent is a detail view, iso direction, unknown entity -> no-op, affected:[]
 */
export const addSectionView = defineCommand({
  name: 'add_section_view',
  description:
    'Add a section view to a drawing sheet: the model is cut by a plane and seen from `direction` with the cut faces hatched ' +
    '(hidden lines omitted). `offset` is the world coordinate of the cutting plane on the axis the view looks along (x for left/right, ' +
    'y for front/back, z for top/bottom); material between the plane and the viewer is removed. Pass `parentViewId` to draw the ' +
    'cutting-plane line with arrows and the letter on that view (the parent must show the plane edge-on, i.e. be perpendicular to ' +
    '`direction`, e.g. parent "front" with direction "right"). Labelled "SECTION A-A" with the next free letter. Returns the view id.',
  params: z.object({
    sheetId: z.string().describe('Id of the sheet.'),
    direction: z
      .enum(['front', 'back', 'left', 'right', 'top', 'bottom'])
      .describe('Side the section is seen from; the cutting plane is perpendicular to this direction. No iso.'),
    offset: z
      .number()
      .describe('World coordinate of the cutting plane on the viewing axis (document units), e.g. 0 for the middle of a centred part.'),
    parentViewId: z.string().optional().describe('View on the same sheet that gets the cutting-plane line. Its entities are reused.'),
    entityIds: entityIdsField.optional(),
    paperPosition: vec2('Centre of the view on the paper in millimetres. Omit for automatic layout.').optional(),
    scale: scaleField.optional().describe('Own scale denominator N of 1:N. Omit to use the sheet scale.'),
  }),
  run: (doc, { sheetId, direction, offset, parentViewId, entityIds, paperPosition, scale }): CommandResult => {
    const sheet = requireSheet(doc, 'add_section_view', sheetId);
    if (isRejection(sheet)) return sheet;
    const parent = parentViewId === undefined ? undefined : findView(sheet, parentViewId);
    if (parentViewId !== undefined && (!parent || parent.kind === 'detail'))
      return noop(doc, `add_section_view rejected: '${parentViewId}' is not a projection or section view on sheet ${sheetId}.`);
    const shown = entityIds ?? parent?.entityIds;
    const problem = shown === undefined ? (hasSolids(doc) ? null : 'the document has no 3D solids to cut') : entityProblem(doc, shown);
    if (problem !== null) return noop(doc, `add_section_view rejected: ${problem}.`);
    const mark = nextMark(sheet);
    const view: DrawingView = {
      id: nextId('view'),
      label: `SECTION ${mark}-${mark}`,
      kind: 'section',
      direction,
      mark,
      section: { offset, ...(parentViewId === undefined ? {} : { parentViewId }) },
      ...defined({ entityIds: shown, position: paperPosition, scale }),
    };
    return addedView(
      doc,
      sheet,
      view,
      `Added section ${mark}-${mark} view ${view.id} (${direction}, plane at ${offset}) to sheet ${sheetId}.`,
    );
  },
});

/**
 * @affects adds 1 detail DrawingView (circle on the parent, magnified, clipped to the circle); affected = [viewId]
 * @invariant default scale is the standard scale at least 2x the sheet scale
 * @failure unknown sheet / parent view, parent is a detail or an iso view -> no-op, affected:[]
 */
export const addDetailView = defineCommand({
  name: 'add_detail_view',
  description:
    'Add a detail view to a drawing sheet: a circle on a parent (projection or section) view is drawn magnified and clipped to the ' +
    'circle, labelled "DETAIL B (2:1)" with the next free letter; the circle and letter are drawn on the parent. `center` and ' +
    "`radius` are in the parent view's projected model coordinates (document units; for a front view x = world X, y = world Z). " +
    'Default scale is the standard scale at least 2x the sheet scale (1:10 sheet -> 1:5, 1:5 -> 1:2). Returns the view id.',
  params: z.object({
    sheetId: z.string().describe('Id of the sheet.'),
    parentViewId: z.string().describe('View (projection or section) the circle is on.'),
    center: vec2("Circle centre in the parent view's projected model coordinates (document units)."),
    radius: z.number().positive().describe('Circle radius in document units.'),
    scale: scaleField
      .optional()
      .describe('Scale denominator N of the detail, e.g. 0.5 = 2:1. Omit for the standard scale at least 2x the sheet scale.'),
    paperPosition: vec2('Centre of the detail on the paper in millimetres. Omit for automatic layout.').optional(),
  }),
  run: (doc, { sheetId, parentViewId, center, radius, scale, paperPosition }): CommandResult => {
    const sheet = requireSheet(doc, 'add_detail_view', sheetId);
    if (isRejection(sheet)) return sheet;
    const parent = findView(sheet, parentViewId);
    if (!parent || parent.kind === 'detail')
      return noop(doc, `add_detail_view rejected: '${parentViewId}' is not a projection or section view on sheet ${sheetId}.`);
    if (parent.direction === 'iso')
      return noop(doc, `add_detail_view rejected: '${parentViewId}' is an iso view; its axes are not model axes.`);
    const mark = nextMark(sheet);
    const view: DrawingView = {
      id: nextId('view'),
      label: `DETAIL ${mark}`,
      kind: 'detail',
      mark,
      detail: { parentViewId, center, radius },
      ...defined({ scale, position: paperPosition }),
    };
    return addedView(
      doc,
      sheet,
      view,
      `Added detail ${mark} view ${view.id} of ${parentViewId} (r=${radius} at [${center.join(', ')}]) to sheet ${sheetId}.`,
    );
  },
});
