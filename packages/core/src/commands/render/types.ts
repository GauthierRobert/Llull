import type { Vec3 } from '../../model/types';
import type { Bounds } from '../../geometry/bounds';
import type { Camera, ViewName } from './camera';
import type { OverlayKind, OverlayStats } from '../../model/renderOverlay';
import type { RasterScene } from '../../model/raster';

/** The `data` payload of render_view. */
export interface RenderViewData {
  view: ViewName;
  /** Image size in pixels. */
  width: number;
  height: number;
  entityCount: number;
  /** World-space AABB of all entities, or null when the document is empty. */
  bounds: Bounds | null;
  /** Camera position, target, and up vector used for the render. */
  camera: Camera;
  /** Half-extent (world units) of the orthographic frustum the SVG and its overlays project with. */
  orthoHalf: number;
  /** Complete, self-contained SVG document string. */
  svg: string;
  /** Filled polygons actually drawn (cut caps included). */
  polygonCount: number;
  /** Polygon budget in force for this render. */
  polygonBudget: number;
  /** Entities drawn with fewer polygons than they have (decimated to fit the budget). */
  simplifiedEntityIds: string[];
  /** Entities not drawn at all because the budget was smaller than the number of entities. */
  skippedEntityIds: string[];
  /** Entities clipped by `cut` (empty without a cut). */
  cutEntityIds: string[];
  /** What the `overlay` kinds drew (04 DIR FR-DIR-40): entity ids and the counts of segments and dots in the SVG; absent without `overlay`. */
  overlays?: Partial<Record<OverlayKind, OverlayStats>>;
  /** Ids of the entities the picture shows after viewpoint visibility, profile hidden rules, the section box and the view frustum (first 500, document order). */
  visibleEntityIds?: string[];
  /** Number of such entities (the list above is cut at 500). */
  visibleEntityCount?: number;
  /** Entities removed by viewpoint visibility or hidden profile rules (first 500). */
  hiddenEntityIds?: string[];
  /** One entry per rule of the applied colour profile, in rule order, with the number of entities it coloured. */
  legend?: { ruleId: string; legend: string; colour: string; count: number }[];
  /** The colour profile and section box that were applied, and the shading drawn. */
  colourProfileId?: string;
  sectionBoxId?: string;
  shading?: 'flat' | 'review';
  /** Why the view frustum was not applied to visibleEntityIds (degenerate camera); absent when it was applied or not applicable. */
  frustumSkipped?: string;
}

/** One cut plane; the side the normal points to (dot(normal, p) > offset) is the removed side. */
export interface CutPlane {
  normal: Vec3;
  offset: number;
}

/** Cutaway request: which part of which entities is removed. */
export interface CutSpec {
  planes: CutPlane[];
  /** `intersection`: remove only where ALL planes' cut sides overlap; `union`: where ANY does. */
  mode: 'intersection' | 'union';
  /** Entities to cut; every solid when omitted. */
  entityIds?: string[];
}

/** Optional render settings shared by every render_view pass. */
export interface RenderOptions {
  /** Magnification of the framed scene (> 0); 1 fits the scene. */
  zoom?: number;
  /** Vector from the scene center toward the camera (replaces the named view). */
  direction?: Vec3;
  /** World point the camera looks at (default: scene center). */
  target?: Vec3;
  cut?: CutSpec;
  /** CSS color of the background; `null` draws none (sub-passes composed by multi-pass views). */
  background?: string | null;
  /** Polygon budget (default MAX_POLYGONS). */
  maxPolygons?: number;
  /** Bounds to frame instead of the rendered subset's own (keeps multi-pass layers aligned). */
  frame?: Bounds | null;
  /** `raster` (default): z-buffered faces embedded as a PNG; `vector`: painter-sorted SVG polygons. */
  mode?: 'raster' | 'vector';
  /** false: no view caption and axis triad (frames composed by another command, e.g. render_motion). */
  caption?: boolean;
  /** Explicit camera (a viewpoint or a perspective view) replacing the framed named view; `orthoHalf` sizes its frustum / scale. */
  view?: { readonly camera: Camera; readonly orthoHalf: number };
  /** Replaces the reference per-pixel stage of raster mode (a host's native raster, `ctx.raster`). */
  pixels?: PixelStage;
  /** Entity id -> material class surface (metalness, roughness): the entity's faces get the Blinn-Phong highlight in raster mode. */
  shading?: ReadonlyMap<string, SurfaceShading>;
}

/** Surface response of a material class, both in [0, 1]. */
export interface SurfaceShading {
  readonly metalness: number;
  readonly roughness: number;
}

/** Replaces the reference per-pixel stage (a host's native raster); returns the logical RGBA image. */
export type PixelStage = (scene: RasterScene) => Uint8Array;

/** Polygon before depth is computed (all tessellation helpers return this). */
export interface PreDepthPolygon {
  verts: Vec3[];
  /** CSS color string for this face. */
  color: string;
  /** Pre-computed world-space face normal (unit). */
  normal: Vec3;
  /** True when this is a 2D stroke path rather than a filled polygon. */
  stroke: boolean;
  /** Cut cap: every loop of the section outline (`verts` is the first), filled even-odd and hatched. */
  loops?: Vec3[][];
  /** Decimation ratio (original / kept polygons) of the owning entity; gaps are bridged by a stroke. */
  inflate?: number;
  /** A piece of a larger face split for depth sorting: drawn without an outline so the cuts do not show. */
  seamless?: boolean;
  /** Id of the entity the face belongs to (depth splitting only splits faces another entity can overlap). */
  owner?: string;
  /** Surface response of the owner's material class (raster mode adds a Blinn-Phong highlight to the face colour). */
  shading?: SurfaceShading;
}

/** A flat polygon of world-space 3D points, with associated color, normal, and camera depth. */
export interface Polygon3D extends PreDepthPolygon {
  /** Camera-space depth of centroid (for painter's sort). */
  depth: number;
}
