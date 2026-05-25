/**
 * @layer ui/viewport/2d
 *
 * Visual snap indicator for the 2D drafting viewport.
 *
 * Tracks the pointer over the 2D canvas via an invisible ground plane
 * (onPointerMove on a large mesh at z=0), computes the snapped position,
 * and renders a small glyph whose shape encodes the snap type:
 *
 *   endpoint    → square (magenta)
 *   midpoint    → triangle (cyan)
 *   center      → circle (yellow)
 *   intersection→ X cross (orange)
 *   grid        → plus (dim white)
 *
 * Presentation only — reads the document via useSnap; NEVER mutates it (R1).
 * Geometries/materials are memoized and disposed on unmount (R9).
 */

import { useRef, useMemo, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { Vec2 } from '@core/model/types';
import { useSnap } from './useSnap';
import type { SnapType } from './snapping';

// ---------------------------------------------------------------------------
// Glyph colours per snap type
// ---------------------------------------------------------------------------

const SNAP_COLORS: Record<SnapType, string> = {
  endpoint: '#e040fb',      // magenta
  midpoint: '#00e5ff',      // cyan
  center: '#ffee58',        // yellow
  intersection: '#ff9800',  // orange
  grid: '#546e7a',          // muted blue-grey
};

const GLYPH_SIZE = 0.22; // world units

// ---------------------------------------------------------------------------
// Helper: build glyph geometry for each snap type
// ---------------------------------------------------------------------------

function buildGlyphGeometry(type: SnapType): THREE.BufferGeometry {
  const s = GLYPH_SIZE;
  switch (type) {
    case 'endpoint': {
      // Square: 4 line segments forming a box.
      const geo = new THREE.BufferGeometry();
      const v = new Float32Array([
        -s, -s, 0,  s, -s, 0,
         s, -s, 0,  s,  s, 0,
         s,  s, 0, -s,  s, 0,
        -s,  s, 0, -s, -s, 0,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
      return geo;
    }
    case 'midpoint': {
      // Equilateral triangle (pointing up).
      const h = s * Math.sqrt(3);
      const geo = new THREE.BufferGeometry();
      const v = new Float32Array([
        0,      h * 2 / 3, 0,  s, -h / 3, 0,
        s,     -h / 3,     0, -s, -h / 3, 0,
       -s,     -h / 3,     0,  0,  h * 2 / 3, 0,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
      return geo;
    }
    case 'center': {
      // Circle: line loop approximated with 16 segments.
      const segments = 16;
      const verts: number[] = [];
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        verts.push(
          s * Math.cos(a0), s * Math.sin(a0), 0,
          s * Math.cos(a1), s * Math.sin(a1), 0,
        );
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      return geo;
    }
    case 'intersection': {
      // X: two diagonal lines.
      const geo = new THREE.BufferGeometry();
      const v = new Float32Array([
        -s, -s, 0,  s,  s, 0,
        -s,  s, 0,  s, -s, 0,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
      return geo;
    }
    case 'grid': {
      // Plus: two orthogonal lines.
      const geo = new THREE.BufferGeometry();
      const v = new Float32Array([
        -s, 0, 0,  s, 0, 0,
         0, -s, 0,  0, s, 0,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
      return geo;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-type glyph (memoized, disposed on unmount)
// ---------------------------------------------------------------------------

interface GlyphProps {
  snapType: SnapType;
  x: number;
  y: number;
}

function SnapGlyph({ snapType, x, y }: GlyphProps): React.ReactElement {
  const geoRef = useRef<THREE.BufferGeometry | null>(null);
  const matRef = useRef<THREE.LineBasicMaterial | null>(null);
  const objRef = useRef<THREE.LineSegments | null>(null);

  const segments = useMemo<THREE.LineSegments>(() => {
    const geo = buildGlyphGeometry(snapType);
    const mat = new THREE.LineBasicMaterial({
      color: SNAP_COLORS[snapType],
      linewidth: 2, // hint — most WebGL impls ignore this
      depthTest: false,
    });
    const segs = new THREE.LineSegments(geo, mat);
    segs.renderOrder = 999; // draw on top
    geoRef.current = geo;
    matRef.current = mat;
    objRef.current = segs;
    return segs;
  }, [snapType]);

  useEffect(() => {
    return () => {
      geoRef.current?.dispose();
      matRef.current?.dispose();
    };
  }, [segments]);

  segments.position.set(x, y, 0.1);

  return <primitive object={segments} />;
}

// ---------------------------------------------------------------------------
// Ground plane: invisible mesh that captures pointer events
// ---------------------------------------------------------------------------

interface GroundPlaneProps {
  onMove: (worldX: number, worldY: number) => void;
  onLeave: () => void;
}

function GroundPlane({ onMove, onLeave }: GroundPlaneProps): React.ReactElement {
  const geo = useMemo(() => new THREE.PlaneGeometry(100000, 100000), []);
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    [],
  );

  useEffect(() => {
    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, [geo, mat]);

  const handleMove = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      onMove(e.point.x, e.point.y);
    },
    [onMove],
  );

  const handleLeave = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      onLeave();
    },
    [onLeave],
  );

  return (
    <mesh
      geometry={geo}
      material={mat}
      position={[0, 0, 0]}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
    />
  );
}

// ---------------------------------------------------------------------------
// SnapIndicator — the exported component
// ---------------------------------------------------------------------------

/**
 * Mount inside the r3f scene (inside <Canvas>) in Viewport2D.
 *
 * Tracks pointer movement, computes the snap result via useSnap, and
 * renders the appropriate glyph. No document writes.
 */
export function SnapIndicator(): React.ReactElement {
  const [cursor, setCursor] = useState<Vec2 | null>(null);

  const handleMove = useCallback((wx: number, wy: number) => {
    setCursor([wx, wy]);
  }, []);

  const handleLeave = useCallback(() => {
    setCursor(null);
  }, []);

  const snapResult = useSnap(cursor, { gridSize: 1, tolerance: 0.5 });

  return (
    <>
      <GroundPlane onMove={handleMove} onLeave={handleLeave} />
      {snapResult?.snapped && snapResult.type !== null && (
        <SnapGlyph
          key={snapResult.type}
          snapType={snapResult.type}
          x={snapResult.x}
          y={snapResult.y}
        />
      )}
    </>
  );
}
