// Draws the FE set-up of the analysis case the Analysis panel has focused (useAnalysisViewStore) on the model, inside the floating-origin
// group: supports, load arrows (head at the face, shaft trailing back), thermal boundary conditions and result probes, each with a value
// pill. A pure function of the document and the focused id; nothing is drawn while no case is focused.

import React, { useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import { useAnalysisViewStore } from '@ui/store/analysisViewStore';
import { analysedSize, feaSetupGlyphs, type FeaGlyph } from '@ui/feaSetupGlyphs';
import { useDisposable } from '../useDisposable';

const UP = new THREE.Vector3(0, 1, 0);
const RENDER_ORDER = 998;

interface SharedGeometry {
  unitCylinder: THREE.CylinderGeometry;
  unitCone: THREE.ConeGeometry;
  unitCube: THREE.BoxGeometry;
  unitOctahedron: THREE.OctahedronGeometry;
  dispose: () => void;
}

/** Unit-sized geometries shared by every glyph (scaled per mesh), disposed together. */
function useSharedGeometry(): SharedGeometry {
  return useDisposable(() => {
    const unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 16);
    const unitCone = new THREE.ConeGeometry(1, 1, 16);
    const unitCube = new THREE.BoxGeometry(1, 1, 1);
    const unitOctahedron = new THREE.OctahedronGeometry(1);
    return {
      unitCylinder,
      unitCone,
      unitCube,
      unitOctahedron,
      dispose: (): void => [unitCylinder, unitCone, unitCube, unitOctahedron].forEach((geometry) => geometry.dispose()),
    };
  }, []);
}

interface GlyphProps {
  glyph: FeaGlyph;
  size: number;
  geometry: SharedGeometry;
}

/** Local frame: +Y is the glyph direction; the tip / contact point sits at the origin. */
function ArrowShape({ glyph, size, geometry, material }: GlyphProps & { material: THREE.Material }): React.ReactElement {
  const length = size * (0.08 + 0.12 * glyph.strength);
  const head = length * 0.35;
  const radius = size * 0.006;
  return (
    <>
      <mesh
        geometry={geometry.unitCylinder}
        material={material}
        position={[0, -head - (length - head) / 2, 0]}
        scale={[radius, length - head, radius]}
        renderOrder={RENDER_ORDER}
      />
      <mesh
        geometry={geometry.unitCone}
        material={material}
        position={[0, -head / 2, 0]}
        scale={[radius * 3.2, head, radius * 3.2]}
        renderOrder={RENDER_ORDER}
      />
    </>
  );
}

function SupportCone({ size, geometry, material }: Omit<GlyphProps, 'glyph'> & { material: THREE.Material }): React.ReactElement {
  const height = size * 0.035;
  const radius = size * 0.022;
  return (
    <>
      <mesh
        geometry={geometry.unitCone}
        material={material}
        position={[0, -height / 2, 0]}
        scale={[radius, height, radius]}
        renderOrder={RENDER_ORDER}
      />
      <mesh
        geometry={geometry.unitCylinder}
        material={material}
        position={[0, -height - size * 0.003, 0]}
        scale={[radius * 1.5, size * 0.006, radius * 1.5]}
        renderOrder={RENDER_ORDER}
      />
    </>
  );
}

function GlyphShape({ glyph, size, geometry }: GlyphProps): React.ReactElement {
  const material = useDisposable(
    () => new THREE.MeshBasicMaterial({ color: glyph.color, transparent: true, opacity: 0.92, depthTest: false }),
    [glyph.color],
  );
  switch (glyph.shape) {
    case 'arrow':
      return <ArrowShape glyph={glyph} size={size} geometry={geometry} material={material} />;
    case 'cone':
      return <SupportCone size={size} geometry={geometry} material={material} />;
    case 'cube': {
      const side = size * 0.03;
      return <mesh geometry={geometry.unitCube} material={material} position={[0, -side / 2, 0]} scale={side} renderOrder={RENDER_ORDER} />;
    }
    case 'disc':
      return (
        <mesh
          geometry={geometry.unitCylinder}
          material={material}
          position={[0, -size * 0.002, 0]}
          scale={[size * 0.028, size * 0.004, size * 0.028]}
          renderOrder={RENDER_ORDER}
        />
      );
    case 'diamond':
      return <mesh geometry={geometry.unitOctahedron} material={material} scale={size * 0.014} renderOrder={RENDER_ORDER} />;
  }
}

function GlyphView({ glyph, size, geometry }: GlyphProps): React.ReactElement {
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(...glyph.direction)), [glyph.direction]);
  return (
    <>
      <group position={glyph.position} quaternion={quaternion}>
        <GlyphShape glyph={glyph} size={size} geometry={geometry} />
      </group>
      <Html position={glyph.position} zIndexRange={[17, 8]} style={{ pointerEvents: 'none' }}>
        <span
          className={`fea-label fea-label--${glyph.kind}`}
          style={{ borderColor: glyph.color, '--stack': glyph.stack } as React.CSSProperties}
          data-testid={`fea-label-${glyph.id}`}
        >
          {glyph.label}
        </span>
      </Html>
    </>
  );
}

export function FeaSetupOverlay(): React.ReactElement | null {
  const document = useStore((s) => s.document);
  const focusedId = useAnalysisViewStore((s) => s.focusedAnalysisId);
  const geometry = useSharedGeometry();
  const analysis = focusedId === null ? undefined : document.analysis?.cases[focusedId];
  const glyphs = useMemo(() => (analysis === undefined ? [] : feaSetupGlyphs(document, analysis)), [document, analysis]);
  const size = useMemo(() => (analysis === undefined ? 1 : analysedSize(document, analysis)), [document, analysis]);

  if (glyphs.length === 0) return null;
  return (
    <group name="fea-setup">
      {glyphs.map((glyph) => (
        <GlyphView key={glyph.id} glyph={glyph} size={size} geometry={geometry} />
      ))}
    </group>
  );
}
