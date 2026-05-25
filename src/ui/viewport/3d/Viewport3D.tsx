/**
 * @layer ui/viewport/3d
 *
 * The 3D perspective viewport.
 *
 * - A single r3f <Canvas> with a perspective camera initialised from
 *   `document.camera` (spherical: target, azimuth, polar, distance).
 * - OrbitControls (drei) for pan/orbit/zoom — disabled while a TransformGizmo
 *   drag is in progress so the camera does not fight the gizmo.
 * - Ground grid + axes for spatial reference.
 * - Ambient + directional lighting.
 * - An <Entities> group that renders every entity in the document.
 * - <TransformGizmo> appears when exactly one entity is selected and lets the
 *   user translate/rotate/scale by dispatching the matching command on drag end.
 *   <GizmoModeToggle> is an overlay outside the Canvas sharing the same mode.
 *
 * This component is purely presentational: it reads from the store and never
 * mutates the document (PRIME DIRECTIVE). All changes go through dispatch.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import { Entities } from './Entities';
import { TransformGizmo, GizmoModeToggle } from './TransformGizmo';
import type { GizmoMode } from './TransformGizmo';

// ---------------------------------------------------------------------------
// Camera initializer
// ---------------------------------------------------------------------------

/** Convert spherical CameraState → a cartesian THREE.Vector3 eye position. */
function sphericalToCartesian(
  target: [number, number, number],
  azimuth: number,
  polar: number,
  distance: number,
): [number, number, number] {
  const sinPolar = Math.sin(polar);
  return [
    target[0] + distance * sinPolar * Math.sin(azimuth),
    target[1] + distance * Math.cos(polar),
    target[2] + distance * sinPolar * Math.cos(azimuth),
  ];
}

// ---------------------------------------------------------------------------
// Scene contents (inside Canvas)
// ---------------------------------------------------------------------------

interface SceneContentsProps {
  /** When false, OrbitControls is disabled (gizmo drag in progress). */
  orbitEnabled: boolean;
  gizmoMode: GizmoMode;
  onDraggingChanged: (dragging: boolean) => void;
}

function SceneContents({ orbitEnabled, gizmoMode, onDraggingChanged }: SceneContentsProps): React.ReactElement {
  const document = useStore((s) => s.document);
  const { camera: cam } = document;

  const initialPosition = useMemo(
    () => sphericalToCartesian(cam.target as [number, number, number], cam.azimuth, cam.polar, cam.distance),
    // Only used for initial mount — intentionally not reactive to later cam changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const targetVec = useMemo(
    () => new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]),
    // Same: initial mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <>
      {/* ---- Camera + controls ---- */}
      <PerspectiveCamera makeDefault fov={45} near={0.01} far={10000} position={initialPosition} />
      <OrbitControls
        makeDefault
        target={targetVec}
        minDistance={0.1}
        maxDistance={2000}
        enableDamping
        dampingFactor={0.06}
        screenSpacePanning={false}
        enabled={orbitEnabled}
      />

      {/* ---- Lighting ---- */}
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[8, 14, 6]}
        intensity={1.4}
        castShadow={false}
      />
      <directionalLight position={[-6, 4, -8]} intensity={0.3} color="#a8c8ff" />

      {/* ---- Ground grid ---- */}
      <Grid
        args={[40, 40]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#2a3040"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#374055"
        fadeDistance={80}
        fadeStrength={1.5}
        position={[0, 0, 0]}
        infiniteGrid
      />

      {/* ---- Entities ---- */}
      <Entities document={document} />

      {/* ---- Transform gizmo (shown for single-entity selection) ---- */}
      <TransformGizmo mode={gizmoMode} onDraggingChanged={onDraggingChanged} />

      {/* ---- Orientation gizmo (bottom-right corner) ---- */}
      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport
          axisColors={['#e05252', '#52c05a', '#4e8de0']}
          labelColor="#e8eaed"
        />
      </GizmoHelper>
    </>
  );
}

// ---------------------------------------------------------------------------
// Viewport3D — the exported component
// ---------------------------------------------------------------------------

export function Viewport3D(): React.ReactElement {
  const clearSelection = useStore((s) => s.clearSelection);
  const selection = useStore((s) => s.document.selection);

  // Gizmo mode — owned here so the overlay toggle and the in-Canvas gizmo
  // share the same value without lifting state through the Canvas boundary.
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');

  // Disable OrbitControls while the gizmo is being dragged.
  const [orbitEnabled, setOrbitEnabled] = useState(true);

  const handleDraggingChanged = useCallback((dragging: boolean): void => {
    setOrbitEnabled(!dragging);
  }, []);

  const handlePointerMissed = useCallback((): void => {
    clearSelection();
  }, [clearSelection]);

  // Keyboard shortcuts: g=translate, r=rotate, s=scale
  // Managed here (outside Canvas) so they work regardless of canvas focus.
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'g') setGizmoMode('translate');
      else if (e.key === 'r') setGizmoMode('rotate');
      else if (e.key === 's') setGizmoMode('scale');
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const showModeToggle = selection.length === 1;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        gl={{ antialias: true, alpha: false }}
        dpr={[1, 2]}
        style={{ width: '100%', height: '100%', background: '#141720' }}
        onPointerMissed={handlePointerMissed}
      >
        <Suspense fallback={null}>
          <SceneContents
            orbitEnabled={orbitEnabled}
            gizmoMode={gizmoMode}
            onDraggingChanged={handleDraggingChanged}
          />
        </Suspense>
      </Canvas>

      {/* Mode toggle overlay — only visible when a single entity is selected */}
      {showModeToggle && (
        <GizmoModeToggle mode={gizmoMode} onMode={setGizmoMode} />
      )}
    </div>
  );
}
