/**
 * @layer ui/viewport/2d
 *
 * Rubber-band previews rendered inside the r3f scene while a draw tool is active.
 *
 * Renders a memoized LineSegments / line-loop preview that follows the snapped
 * cursor. All geometry is memoized and disposed on unmount (R9).
 *
 * Presentation only — no document mutations (R1). Reads draw state from props.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Vec2 } from '@core/model/types';
import type { DrawToolKind } from './useDrawTool';
import { rectParamsFromCorners, circleRadiusFromPoints } from './drawHelpers';

// ---------------------------------------------------------------------------
// Shared preview material (not disposed — singleton)
// ---------------------------------------------------------------------------

const PREVIEW_COLOR = '#60a5fa'; // blue-400
const PREVIEW_DASH_COLOR = '#94a3b8'; // slate-400

// ---------------------------------------------------------------------------
// Preview geometry builders (pure helpers)
// ---------------------------------------------------------------------------

/** Two-point line segment geometry. */
function buildLineGeo(a: Vec2, b: Vec2): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([a[0], a[1], 0, b[0], b[1], 0]),
      3,
    ),
  );
  return geo;
}

/** Polyline through an ordered list of points. */
function buildPolylineGeo(points: Vec2[], cursor: Vec2): THREE.BufferGeometry {
  const all = [...points, cursor];
  const verts: number[] = [];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i]!;
    const b = all[i + 1]!;
    verts.push(a[0], a[1], 0, b[0], b[1], 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  return geo;
}

/** Rectangle outline from two corners. */
function buildRectGeo(a: Vec2, b: Vec2): THREE.BufferGeometry {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  const verts = new Float32Array([
    x0, y0, 0,  x1, y0, 0,
    x1, y0, 0,  x1, y1, 0,
    x1, y1, 0,  x0, y1, 0,
    x0, y1, 0,  x0, y0, 0,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  return geo;
}

/** Circle outline (32-segment approximation). */
function buildCircleGeo(center: Vec2, radius: number): THREE.BufferGeometry {
  const segments = 32;
  const verts: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    verts.push(
      center[0] + radius * Math.cos(a0),
      center[1] + radius * Math.sin(a0),
      0,
      center[0] + radius * Math.cos(a1),
      center[1] + radius * Math.sin(a1),
      0,
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  return geo;
}

// ---------------------------------------------------------------------------
// DrawPreview props
// ---------------------------------------------------------------------------

export interface DrawPreviewProps {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  /** Current snapped cursor position; null when the cursor is off-canvas. */
  cursor: Vec2 | null;
}

// ---------------------------------------------------------------------------
// DrawPreview — rendered inside r3f Canvas
// ---------------------------------------------------------------------------

/**
 * Imperative-style preview using a ref'ed THREE.LineSegments that is updated
 * every render. Geometry is rebuilt when relevant props change, then disposed.
 * Uses renderOrder 998 so it draws over entities but under snap glyphs.
 */
export function DrawPreview({ activeTool, collectedPoints, cursor }: DrawPreviewProps): React.ReactElement | null {
  const objRef = useRef<THREE.LineSegments | null>(null);
  const geoRef = useRef<THREE.BufferGeometry | null>(null);

  const mat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: PREVIEW_COLOR,
        linewidth: 1,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
      }),
    [],
  );

  const dotMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: PREVIEW_DASH_COLOR,
        linewidth: 1,
        depthTest: false,
        transparent: true,
        opacity: 0.5,
      }),
    [],
  );

  // Dispose material on unmount.
  useEffect(() => {
    return () => {
      mat.dispose();
      dotMat.dispose();
    };
  }, [mat, dotMat]);

  // Build preview geometry from current state.
  const segments = useMemo<THREE.LineSegments | null>(() => {
    if (activeTool === 'none' || cursor === null) return null;

    let geo: THREE.BufferGeometry | null = null;
    let useDash = false;

    if (activeTool === 'line') {
      if (collectedPoints.length === 1) {
        geo = buildLineGeo(collectedPoints[0]!, cursor);
      }
    } else if (activeTool === 'polyline') {
      if (collectedPoints.length >= 1) {
        geo = buildPolylineGeo(collectedPoints, cursor);
      } else {
        // Show a small crosshair indicator at cursor position.
        const s = 0.15;
        const verts = new Float32Array([
          cursor[0] - s, cursor[1], 0,
          cursor[0] + s, cursor[1], 0,
          cursor[0], cursor[1] - s, 0,
          cursor[0], cursor[1] + s, 0,
        ]);
        geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        useDash = true;
      }
    } else if (activeTool === 'circle') {
      if (collectedPoints.length === 1) {
        const radius = circleRadiusFromPoints(collectedPoints[0]!, cursor);
        if (radius !== null) {
          geo = buildCircleGeo(collectedPoints[0]!, radius);
        }
      }
    } else if (activeTool === 'rectangle') {
      if (collectedPoints.length === 1) {
        const params = rectParamsFromCorners(collectedPoints[0]!, cursor);
        if (params !== null) {
          geo = buildRectGeo(collectedPoints[0]!, cursor);
        }
      }
    }

    if (!geo) return null;

    const segs = new THREE.LineSegments(geo, useDash ? dotMat : mat);
    segs.renderOrder = 998;
    return segs;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, collectedPoints, cursor, mat, dotMat]);

  // Dispose previous geometry when a new one is built.
  useEffect(() => {
    const prev = geoRef.current;
    geoRef.current = segments?.geometry ?? null;
    return () => {
      prev?.dispose();
    };
  }, [segments]);

  // Update ref.
  useEffect(() => {
    objRef.current = segments;
  }, [segments]);

  if (!segments) return null;
  return <primitive object={segments} />;
}

// ---------------------------------------------------------------------------
// CollectedPointMarkers — dots at already-placed vertices
// ---------------------------------------------------------------------------

interface PointMarkerProps {
  points: Vec2[];
}

/** Small cross marker rendered at each already-collected vertex. */
export function CollectedPointMarkers({ points }: PointMarkerProps): React.ReactElement | null {
  const mat = useMemo(
    () => new THREE.LineBasicMaterial({ color: '#f59e0b', depthTest: false }),
    [],
  );

  useEffect(() => {
    return () => { mat.dispose(); };
  }, [mat]);

  const segsObject = useMemo(() => {
    if (points.length === 0) return null;
    const s = 0.12;
    const verts: number[] = [];
    for (const p of points) {
      // Small square around each point.
      verts.push(
        p[0] - s, p[1] - s, 0,  p[0] + s, p[1] - s, 0,
        p[0] + s, p[1] - s, 0,  p[0] + s, p[1] + s, 0,
        p[0] + s, p[1] + s, 0,  p[0] - s, p[1] + s, 0,
        p[0] - s, p[1] + s, 0,  p[0] - s, p[1] - s, 0,
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    const segs = new THREE.LineSegments(geo, mat);
    segs.renderOrder = 997;
    return segs;
  }, [points, mat]);

  const geoRef = useRef<THREE.BufferGeometry | null>(null);
  useEffect(() => {
    const prev = geoRef.current;
    geoRef.current = segsObject?.geometry ?? null;
    return () => { prev?.dispose(); };
  }, [segsObject]);

  if (!segsObject) return null;
  return <primitive object={segsObject} />;
}
