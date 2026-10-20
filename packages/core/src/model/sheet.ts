/**
 * Drawing sheets: 2D documentation of the 3D model. A sheet is a RECIPE — views reference entities and a view direction; their line
 * geometry is derived at export time (`export_sheet_svg`), never stored, so a model edit shows on the sheet without touching it.
 */

import type { Vec2 } from './vectors';

export const PAPER_SIZES = ['A4', 'A3', 'A2', 'A1', 'A0'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

/** Landscape ISO 216 sizes, millimetres. */
export const PAPER_MM: Readonly<Record<PaperSize, readonly [number, number]>> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
};

/** Side the viewer stands on: `front` looks along +Y (from −Y), `right` from +X, `top` from +Z; `iso` from (+X, −Y, +Z). */
export const VIEW_DIRECTIONS = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'] as const;
export type ViewDirection = (typeof VIEW_DIRECTIONS)[number];

export const VIEW_KINDS = ['projection', 'section', 'detail'] as const;
type ViewKind = (typeof VIEW_KINDS)[number];

export const PROJECTION_ANGLES = ['first', 'third'] as const;
export type ProjectionAngle = (typeof PROJECTION_ANGLES)[number];

interface TitleBlock {
  readonly title: string;
  readonly drawnBy?: string;
  readonly partNumber?: string;
  readonly revision?: string;
  /** Caller-supplied text; never read from a clock. */
  readonly date?: string;
}

/**
 * One view on a sheet. `scale` is a denominator N of 1:N (N < 1 enlarges: 0.5 = 2:1); absent = the sheet scale. `position` is the view's
 * centre in paper mm; absent = auto layout.
 * @invariant projection: `direction`; section: `direction` + `section.offset`; detail: `detail` (no direction)
 */
export interface DrawingView {
  readonly id: string;
  readonly label: string;
  readonly kind: ViewKind;
  readonly direction?: ViewDirection;
  /** Entities shown; absent = every visible 3D solid of the document. */
  readonly entityIds?: string[];
  readonly position?: Vec2;
  readonly scale?: number;
  /** Section / detail letter ("A", "B", …), unique per sheet. */
  readonly mark?: string;
  /** Section: world coordinate of the cutting plane on the axis the view looks along (x for left/right, y for front/back, z for top/bottom). */
  readonly section?: { readonly offset: number; readonly parentViewId?: string };
  /** Detail: circle on the parent view, in the parent's projected model coordinates (front: X,Z; back: -X,Z; right: Y,Z; left: -Y,Z; top: X,Y; bottom: X,-Y). */
  readonly detail?: { readonly parentViewId: string; readonly center: Vec2; readonly radius: number };
  /** PMI items drawn on this view (explicit; overrides the sheet's automatic selection). */
  readonly pmiIds?: string[];
}

export interface DrawingSheet {
  readonly id: string;
  readonly name: string;
  readonly paper: PaperSize;
  /** Denominator N of 1:N (N < 1 enlarges); absent = auto-fit the largest standard scale. */
  readonly scale?: number;
  readonly titleBlock: TitleBlock;
  readonly projectionAngle: ProjectionAngle;
  readonly views: DrawingView[];
  /** `auto` draws the PMI whose annotation plane faces each projection view; absent = `off`. */
  readonly pmiMode?: 'off' | 'auto';
}

/** Absent on the document until the first sheet command. */
export interface DrawingsModel {
  readonly sheets: Record<string, DrawingSheet>;
  /** Sheet ids in creation order. */
  readonly order: string[];
}
