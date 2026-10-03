import type { Vec3 } from '../model/types';
import { Bounds } from './sceneTypes';

export interface RenderViewData {
  /** The resolved view name ('top'|'bottom'|'front'|'back'|'left'|'right'|'iso'). */
  view: string;
  /** Width of the rendered image in pixels. */
  width: number;
  /** Height of the rendered image in pixels. */
  height: number;
  /** Number of entities in the document at render time. */
  entityCount: number;
  /** World-space AABB of all entities, or null when the document is empty. */
  bounds: Bounds | null;
  /** Camera position, target, and up vector used for the render. */
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    up: [number, number, number];
  };
  /** Complete, self-contained SVG document string. */
  svg: string;
}

/** Polygon before depth is computed (all tessellation helpers return this). */
export interface PreDepthPolygon {
  verts: Vec3[];
  /** CSS color string for this face. */
  color: string;
  /** Pre-computed world-space face normal (unit). */
  normal: Vec3;
  /** True when this is a 2D stroke path rather than a filled polygon. */
  stroke: boolean;
}

/** A flat polygon of world-space 3D points, with associated color, normal, and camera depth. */
export interface Polygon3D extends PreDepthPolygon {
  /** Camera-space depth of centroid (for painter's sort). */
  depth: number;
}
