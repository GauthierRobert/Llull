/** Overlay kinds of render_view `overlay`, what an overlay drew, and the port a plugin registers a kind through (model-level port: render/overlayCage.ts, render/types.ts and plugins use it). */

import type { CadDocument, Entity, Vec3 } from './types';
import type { z } from 'zod';
import type { PointCloudPort } from './pointCloud';

/** World point to SVG pixels of an orthographic render (y down). */
type OverlayProjector = (p: Vec3) => [number, number];

/** Overlays core draws itself; a plugin adds its own through `CadPlugin.renderOverlays`. */
export const BUILTIN_OVERLAY_KINDS = ['cage', 'net'] as const;
/** An overlay kind name: a built-in one or one a plugin registered (checked against the installed plugins when the command runs). */
export type OverlayKind = string;

/** What an overlay drew, for `data.overlays` (counts of the elements in the SVG, entity ids in document order). */
export interface OverlayStats {
  readonly entities: string[];
  /** Cage: unique cage edges drawn. Net: control-net segments (rows and columns of surfaces, the polygon of curves). */
  readonly lines: number;
  /** Cage vertices, or net poles, drawn as dots. */
  readonly points: number;
  /** Extra facts of a plugin overlay (for example a colour breakdown); JSON-safe. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** What `RenderOverlay.draw` gets: the orthographic projector of the picture and the entities to cover. */
export interface OverlayView {
  readonly project: OverlayProjector;
  /** The entities the overlay covers: the document's, limited to the isolated ones in an isolated render (the list the built-in kinds get). */
  readonly entities: ReadonlyArray<Entity>;
  /** Entity ids an isolated render is limited to; undefined = no limit. */
  readonly only?: ReadonlyArray<string>;
  /** Image size in pixels (marks outside it are not drawn). */
  readonly size?: { readonly width: number; readonly height: number };
  /** Host ports from the execution context, narrow (a missing or null port = nothing to read: draw nothing and say so in `detail.note`). */
  readonly ports?: { readonly pointClouds?: PointCloudPort | null };
  /** This kind's `overlayOptions` entry, already validated against `RenderOverlay.paramsSchema`; undefined when none was given. */
  readonly options?: unknown;
  /** World-point predicate of the cutaway / section box: false = the point is cut away. Absent = no cut. */
  readonly cutKeep?: (p: Vec3) => boolean;
  /** True under review shading with a selection: content that is not selected is drawn dimmed. */
  readonly dim?: boolean;
}

/** SVG elements (one string each, drawn over the picture) and the stats of an overlay. */
export interface OverlayLayer {
  readonly svg: string[];
  readonly stats: OverlayStats;
}

/**
 * An overlay kind a plugin adds to render_view.
 * @invariant draw is a pure query of the document and the view (never modifies either); orthographic views only (core never calls it for a perspective render)
 */
export interface RenderOverlay {
  /** snake_case overlay name accepted by render_view `overlay`; must not equal a built-in kind or another plugin's kind. */
  readonly kind: string;
  /** Schema of this kind's entry in render_view `overlayOptions` (checked when the command runs; invalid options are CMD_INVALID_PARAMS). Absent = the kind takes no options. */
  readonly paramsSchema?: z.ZodType;
  draw(doc: CadDocument, view: OverlayView): OverlayLayer;
}
