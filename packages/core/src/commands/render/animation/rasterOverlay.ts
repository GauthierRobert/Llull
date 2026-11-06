/**
 * Overlay primitives (TR-MOV-07): fills and strokes in logical pixel coordinates, appended to the screen-space `RasterScene` BEFORE the pixel stage so the
 * reference raster and a host's native raster draw the very same overlay. They sit in front of every solid (depth −1e7 and below) and carry the "line" flag, so
 * the outline pass never darkens their edges. Layers are ordered by z: smaller z is nearer.
 */

import type { RasterScene } from '../../../model/raster';
import type { Vec2 } from '../../../model/vectors';

/** Layer depths, far to near: panel, trace line, text, dot ring, dot. Far enough apart to survive the renderer's float32 depth buffer. */
export const OVERLAY_Z = { panel: -1e7, trace: -1e7 - 100, text: -1e7 - 200, ring: -1e7 - 250, dot: -1e7 - 300 } as const;

export type Rgb = readonly [number, number, number];

/** A polygon (several loops fill even-odd) in logical pixels. */
export interface OverlayFill {
  readonly color: Rgb;
  readonly z: number;
  readonly loops: readonly (readonly Vec2[])[];
}

/** A polyline `halfWidth` pixels each side; one point draws a disc. */
export interface OverlayStroke {
  readonly color: Rgb;
  readonly z: number;
  readonly halfWidth: number;
  readonly points: readonly Vec2[];
}

export interface OverlayPrimitives {
  readonly fills: readonly OverlayFill[];
  readonly strokes: readonly OverlayStroke[];
}

const FLAG_LINE = 2;
const FACE_FIELDS = 8;

/** `scene` with the primitives appended (the input scene is not changed). */
export function appendOverlay(scene: RasterScene, overlay: OverlayPrimitives): RasterScene {
  const s = scene.samples;
  const faces: number[] = [...scene.faces];
  const fills: number[] = [...scene.fills];
  const loops: number[] = [...scene.loops];
  const points: number[] = [...scene.points];
  const strokes: number[] = [...scene.strokes];
  const addFace = (color: Rgb): number => {
    faces.push(color[0], color[1], color[2], 0, 0, 1, -1, FLAG_LINE);
    return faces.length / FACE_FIELDS - 1;
  };
  for (const fill of overlay.fills) {
    const kept = fill.loops.filter((loop) => loop.length >= 3);
    if (kept.length === 0) continue;
    fills.push(addFace(fill.color), loops.length / 2, kept.length);
    for (const loop of kept) {
      loops.push(points.length / 3, loop.length);
      for (const point of loop) points.push(point[0] * s, point[1] * s, fill.z);
    }
  }
  for (const stroke of overlay.strokes) {
    if (stroke.points.length === 0) continue;
    const face = addFace(stroke.color);
    const path = stroke.points.length === 1 ? [stroke.points[0], stroke.points[0]] : stroke.points;
    for (let i = 0; i + 1 < path.length; i += 1) {
      const [a, b] = [path[i], path[i + 1]];
      if (a === undefined || b === undefined) continue;
      strokes.push(face, a[0] * s, a[1] * s, stroke.z, b[0] * s, b[1] * s, stroke.z, stroke.halfWidth * s, 0);
    }
  }
  return {
    ...scene,
    faces: Float64Array.from(faces),
    fills: Float64Array.from(fills),
    loops: Float64Array.from(loops),
    points: Float64Array.from(points),
    strokes: Float64Array.from(strokes),
  };
}

/** A scene with nothing in it, `width` × `height` pixels (an overlay-only picture is drawn on it). */
export function emptyScene(width: number, height: number, samples = 2): RasterScene {
  return {
    width,
    height,
    samples,
    projection: 'orthographic',
    depthJump: 1,
    creaseCos: 0,
    faces: new Float64Array(0),
    fills: new Float64Array(0),
    loops: new Float64Array(0),
    points: new Float64Array(0),
    strokes: new Float64Array(0),
  };
}
