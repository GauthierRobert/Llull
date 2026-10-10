/**
 * @layer ui/components
 *
 * Contextual "what can I do now" text for the viewport hint bar. Pure: derived from the view,
 * the armed tool and the selection, so each state has one tested message.
 */

import type { DrawToolKind, GizmoMode, ModifyToolKind, ViewMode } from '@ui/store';

export interface HintContext {
  viewMode: ViewMode;
  drawTool: DrawToolKind;
  modifyTool: ModifyToolKind;
  gizmoMode: GizmoMode;
  selectionCount: number;
  entityCount: number;
}

const DRAW_TOOL_HINTS: Readonly<Record<Exclude<DrawToolKind, 'none' | 'move'>, string>> = {
  line: 'Line: click the start point, then the end point.',
  polyline: 'Polyline: click each point · Enter or double-click to finish.',
  wall: 'Wall: click centerline points · Enter to finish · click the first point to close.',
  circle: 'Circle: click the center, then a point on the rim.',
  rectangle: 'Rectangle: click two opposite corners.',
  point: 'Point: click to place.',
  ellipse: 'Ellipse: click the center, then a corner of its bounding box.',
  spline: 'Spline: click through-points · Enter or double-click to finish.',
};

const GIZMO_HINTS: Readonly<Record<GizmoMode, string>> = {
  translate: 'Drag an arrow to move',
  rotate: 'Drag a ring to rotate',
  scale: 'Drag a handle to resize',
};

/** One-line guidance for the current state; Esc semantics are always included when relevant. */
export function hintText(context: HintContext): string {
  const { viewMode, drawTool, modifyTool, gizmoMode, selectionCount, entityCount } = context;

  if (viewMode === '2d' && modifyTool !== 'none') {
    const label = modifyTool.charAt(0).toUpperCase() + modifyTool.slice(1);
    return `${label}: follow the prompt above · Esc cancels · Esc again returns to Select.`;
  }

  if (viewMode === '2d' && drawTool === 'move') {
    return selectionCount === 0
      ? 'Move: select something first (V, then click it) · Esc to cancel.'
      : `Move ${selectionCount} selected: click a base point, then the destination · Esc to cancel.`;
  }
  if (viewMode === '2d' && drawTool !== 'none' && drawTool !== 'move')
    return `${DRAW_TOOL_HINTS[drawTool]} Esc cancels · Esc again returns to Select.`;
  if (entityCount === 0)
    return 'Empty model: pick a solid (Box, Cylinder…) or a 2D tool (Line, Rectangle…) in the toolbar above.';
  if (selectionCount === 0) {
    return viewMode === '3d'
      ? 'Click an object to select it · drag to orbit, right-drag to pan, scroll to zoom · ? shortcuts.'
      : 'Click a shape to select it · Shift+drag to box-select · drag to pan, scroll to zoom · ? shortcuts.';
  }
  if (viewMode === '2d')
    return `${selectionCount} selected · M to move · arrows nudge · Ctrl D duplicate · Del delete · Esc deselect.`;
  if (selectionCount === 1)
    return `${GIZMO_HINTS[gizmoMode]} · M / R / S: move, rotate, scale · arrows nudge · Del delete.`;
  return `${selectionCount} selected · arrows nudge · Ctrl D duplicate · Del delete · select one to get the gizmo.`;
}
