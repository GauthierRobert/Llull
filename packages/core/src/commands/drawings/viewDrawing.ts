/** Derives a view's line geometry from the CURRENT model (never stored): technical view, section cut, detail culling. */

import { type CadDocument, type Entity, type Vec2, is3D } from '../../model/types';
import { type DrawingPrimitive, drawingBounds } from '../../model/drawing';
import type { DrawingSheet, DrawingView } from '../../model/sheet';
import { technicalView } from '../../geometry/technicalView';
import { cutDepthOf, directionFrame, viewerOf } from '../../geometry/viewDirections';
import { cross3, dot3 } from '../../lib/vec3';
import { findView } from './sheetOps';

export type Bounds = readonly [number, number, number, number];

/** A view's derived drawing in its own projected model coordinates. */
export interface DerivedView {
  readonly primitives: DrawingPrimitive[];
  /** [minX, minY, maxX, maxY] of everything drawn (a detail: its circle). */
  readonly bounds: Bounds;
  /** Bounds of the thick (visible / cut) edges only: what dimensions measure. */
  readonly outline: Bounds;
}

/** Entities a view shows: its `entityIds` that still exist as 3D solids, else every 3D solid on a visible layer. */
export function viewSolids(doc: CadDocument, view: DrawingView): Entity[] {
  const candidates = view.entityIds ?? doc.order;
  return candidates.flatMap((id): Entity[] => {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    return entity && is3D(entity) && doc.layers[entity.layerId]?.visible !== false ? [entity] : [];
  });
}

const intersects = (a: Bounds, b: Bounds): boolean => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** Derives `view` (a detail through its parent); null when the view cannot be drawn (no parent, parent is a detail). */
export function deriveView(doc: CadDocument, sheet: DrawingSheet, view: DrawingView): DerivedView | null {
  if (view.kind === 'detail') return deriveDetail(doc, sheet, view);
  if (view.direction === undefined) return null;
  const cutDepth = view.kind === 'section' && view.section ? cutDepthOf(view.direction, view.section.offset) : undefined;
  const primitives = technicalView(doc, viewSolids(doc, view), { frame: directionFrame(view.direction), cutDepth }).flatMap(
    (drawing) => drawing.primitives,
  );
  const thick = primitives.filter((primitive) => primitive.style === 'visible' || primitive.style === 'cut');
  return { primitives, bounds: drawingBounds(primitives), outline: drawingBounds(thick.length > 0 ? thick : primitives) };
}

function deriveDetail(doc: CadDocument, sheet: DrawingSheet, view: DrawingView): DerivedView | null {
  const parent = view.detail ? findView(sheet, view.detail.parentViewId) : undefined;
  if (!view.detail || !parent || parent.kind === 'detail') return null;
  const derived = deriveView(doc, sheet, parent);
  if (!derived) return null;
  const { center, radius } = view.detail;
  const window: Bounds = [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius];
  const primitives = derived.primitives.filter((primitive) => intersects(drawingBounds([primitive]), window));
  return { primitives, bounds: window, outline: window };
}

/** A section's cutting plane as seen on its parent view. */
export interface CuttingLine {
  /** Where the plane crosses the origin line of the parent, parent model coordinates. */
  readonly point: Vec2;
  /** Unit direction along the line. */
  readonly along: Vec2;
  /** Unit direction the viewer looks (arrows point this way). */
  readonly sight: Vec2;
}

/** The cutting line of `section` on `parent`; null when the plane is not seen edge-on there (parent parallel to it, or an iso view). */
export function cuttingLine(parent: DrawingView, section: DrawingView): CuttingLine | null {
  if (parent.direction === undefined || section.direction === undefined || section.section === undefined) return null;
  const frame = directionFrame(parent.direction);
  const normal = viewerOf(section.direction);
  if (Math.abs(dot3(normal, frame.toViewer)) > 1e-9 || section.direction === 'iso') return null;
  const depth = cutDepthOf(section.direction, section.section.offset);
  const along3 = cross3(frame.toViewer, normal);
  const [ox, oy] = frame.project([normal[0] * depth, normal[1] * depth, normal[2] * depth]);
  const [ax, ay] = frame.project(along3);
  const [sx, sy] = frame.project([-normal[0], -normal[1], -normal[2]]);
  return { point: [ox, oy], along: [ax, ay], sight: [sx, sy] };
}
