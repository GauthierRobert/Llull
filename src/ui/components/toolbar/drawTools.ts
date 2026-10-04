/**
 * @layer ui/components/toolbar
 *
 * The 2D draw tools offered by the toolbar and the command palette: tool kind, label, icon, tip.
 */

import type { DrawToolKind } from '@ui/store';
import type { IconName } from '@ui/components/Icon';

export interface DrawToolSpec {
  tool: DrawToolKind;
  label: string;
  icon: IconName;
  tip: string;
}

export const DRAW_TOOLS: readonly DrawToolSpec[] = [
  { tool: 'line', label: 'Line', icon: 'drawLine', tip: 'click start, then end point' },
  {
    tool: 'polyline',
    label: 'Polyline',
    icon: 'drawPolyline',
    tip: 'click points, Enter or double-click to finish',
  },
  {
    tool: 'rectangle',
    label: 'Rectangle',
    icon: 'drawRectangle',
    tip: 'click two opposite corners',
  },
  { tool: 'circle', label: 'Circle', icon: 'drawCircle', tip: 'click center, then a rim point' },
  {
    tool: 'ellipse',
    label: 'Ellipse',
    icon: 'drawEllipse',
    tip: 'click center, then a bounding-box corner',
  },
  {
    tool: 'spline',
    label: 'Spline',
    icon: 'drawSpline',
    tip: 'click through-points, Enter to finish',
  },
  { tool: 'point', label: 'Point', icon: 'drawPoint', tip: 'click to place a point' },
  {
    tool: 'wall',
    label: 'Wall',
    icon: 'wall',
    tip: 'click wall centerline points, Enter to finish',
  },
];
