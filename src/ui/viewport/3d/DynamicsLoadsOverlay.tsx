// Draws the rigid-body loads of `dynamicsLoads` over the model (inside the floating-origin group): weight and thrust arrows sized by their
// newtons, motor torque rings, joint axes and gear links, each with its value label. During playback the arrows ride the bodies and the
// values follow the run. Visibility, labels and the emphasised load come from useLoadOverlayStore (Mechanisms › Loads & forces).

import { useAnalysisViewStore } from '@ui/store/analysisViewStore';
import React, { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { boundsExtent, entityBoundsInDoc, mergeBounds, type Bounds } from '@core/geometry/bounds';
import { useStore } from '@ui/store';
import { useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { isLoadDrawn, useLoadOverlayStore } from '@ui/store/loadOverlayStore';
import { LOAD_COLORS, type LoadItem } from '@ui/dynamicsLoads';
import { useDynamicsLoads } from '@ui/hooks/useDynamicsLoads';
import { useDisposable } from '../useDisposable';

const UP = new THREE.Vector3(0, 1, 0);
const RENDER_ORDER = 999;

/** Size of the moving model (document units): glyphs are drawn relative to it so they read at any scale. */
function modelSize(doc: CadDocument): number {
  let bounds: Bounds | null = null;
  for (const body of Object.values(doc.dynamics?.bodies ?? {}))
    for (const id of body.entityIds) {
      const entity = doc.entities[id];
      if (entity === undefined) continue;
      const next = entityBoundsInDoc(doc, entity);
      bounds = bounds === null ? next : mergeBounds(bounds, next);
    }
  const extent = bounds === null ? 0 : boundsExtent(bounds);
  return extent > 0 ? extent : 1;
}

const peak = (values: Readonly<Record<string, number[]>> | undefined): number =>
  Math.max(0, ...Object.values(values ?? {}).flatMap((series) => series.map(Math.abs)));

/** Largest force / torque the glyphs must fit: the design values and, after a run, the run's peaks (so lengths do not jump per frame). */
function scaleReference(design: readonly LoadItem[], result: SimulationData | null): { force: number; torque: number } {
  const largest = (shape: LoadItem['shape']): number =>
    Math.max(0, ...design.filter((item) => item.shape === shape).map((item) => item.magnitude ?? 0));
  return {
    force: Math.max(largest('force'), peak(result?.series?.propellerThrust)) || 1,
    torque: Math.max(largest('torque'), peak(result?.series?.motorTorque)) || 1,
  };
}

interface GlyphProps {
  item: LoadItem;
  size: number;
  reference: { force: number; torque: number };
  opacity: number;
  label: boolean;
}

function orientation(direction: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(...direction));
}

/** Screen-space value pill (DOM): always legible, never hidden by the model, coloured like its glyph. */
function ValueLabel({ item, position, opacity }: { item: LoadItem; position: Vec3; opacity: number }): React.ReactElement {
  return (
    <Html position={position} zIndexRange={[18, 8]} style={{ pointerEvents: 'none', opacity }}>
      <span className="load-label" style={{ borderColor: LOAD_COLORS[item.layer] }} data-testid={`load-label-${item.id}`}>
        {item.value}
      </span>
    </Html>
  );
}

function useOverlayMaterial(color: string, opacity: number): THREE.MeshBasicMaterial {
  return useDisposable(() => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }), [color, opacity]);
}

function ForceArrow({ item, size, reference, opacity, label }: GlyphProps): React.ReactElement {
  const material = useOverlayMaterial(LOAD_COLORS[item.layer], item.magnitude === null || item.magnitude === 0 ? opacity * 0.4 : opacity);
  const length = item.magnitude === null ? size * 0.25 : size * (0.12 + 0.38 * Math.min(1, item.magnitude / reference.force));
  const radius = size * 0.008;
  const head = Math.min(length * 0.35, size * 0.06);
  const quaternion = useMemo(() => orientation(item.direction), [item.direction]);
  const tip: Vec3 = [
    item.origin[0] + item.direction[0] * length,
    item.origin[1] + item.direction[1] * length,
    item.origin[2] + item.direction[2] * length,
  ];
  return (
    <>
      <group position={item.origin} quaternion={quaternion}>
        <mesh material={material} position={[0, (length - head) / 2, 0]} renderOrder={RENDER_ORDER}>
          <cylinderGeometry args={[radius, radius, length - head, 8]} />
        </mesh>
        <mesh material={material} position={[0, length - head / 2, 0]} renderOrder={RENDER_ORDER}>
          <coneGeometry args={[radius * 3, head, 12]} />
        </mesh>
        <mesh material={material} renderOrder={RENDER_ORDER}>
          <sphereGeometry args={[radius * 2.2, 12, 8]} />
        </mesh>
      </group>
      {label && <ValueLabel item={item} position={tip} opacity={opacity} />}
    </>
  );
}

function TorqueRing({ item, size, reference, opacity, label }: GlyphProps): React.ReactElement {
  const material = useOverlayMaterial(LOAD_COLORS[item.layer], opacity);
  const ring = size * (0.1 + 0.1 * Math.min(1, (item.magnitude ?? 0) / reference.torque));
  const tube = size * 0.007;
  const sweep = Math.PI * 1.5;
  const quaternion = useMemo(() => orientation(item.direction), [item.direction]);
  return (
    <>
      <group position={item.origin} quaternion={quaternion}>
        {/* torus lies in its XY plane: tilt it into the XZ plane so the ring turns about the arrow's +Y (the joint axis) */}
        <group rotation={[Math.PI / 2, 0, 0]}>
          <mesh material={material} renderOrder={RENDER_ORDER}>
            <torusGeometry args={[ring, tube, 6, 48, sweep]} />
          </mesh>
          <mesh
            material={material}
            position={[ring * Math.cos(sweep), ring * Math.sin(sweep), 0]}
            rotation={[0, 0, sweep]}
            renderOrder={RENDER_ORDER}
          >
            <coneGeometry args={[tube * 3.5, size * 0.04, 12]} />
          </mesh>
        </group>
      </group>
      {label && (
        <ValueLabel item={item} position={[item.origin[0] + ring, item.origin[1], item.origin[2] + ring * 0.3]} opacity={opacity} />
      )}
    </>
  );
}

/** A joint's value before a run is just its kind, already said by the list: label the axis only with a live speed. */
const NAMES_ONLY_THE_KIND = new Set(['revolute', 'prismatic']);

const midpoint = ([a, b]: [Vec3, Vec3]): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

function AxisLine({ item, size, opacity, label }: GlyphProps): React.ReactElement {
  const half = size * 0.3;
  const [x, y, z] = item.origin;
  const [dx, dy, dz] = item.direction;
  const ends: [Vec3, Vec3] =
    item.shape === 'link' && item.end !== undefined
      ? [item.origin, item.end]
      : [
          [x - dx * half, y - dy * half, z - dz * half],
          [x + dx * half, y + dy * half, z + dz * half],
        ];
  const material = useOverlayMaterial(LOAD_COLORS[item.layer], opacity);
  return (
    <>
      <Line
        points={ends}
        color={LOAD_COLORS[item.layer]}
        lineWidth={2}
        dashed={item.shape === 'link'}
        dashSize={size * 0.02}
        gapSize={size * 0.015}
        transparent
        opacity={opacity}
        depthTest={false}
        renderOrder={RENDER_ORDER}
      />
      {item.shape === 'axis' && (
        <mesh position={item.origin} material={material} renderOrder={RENDER_ORDER}>
          <sphereGeometry args={[size * 0.012, 12, 8]} />
        </mesh>
      )}
      {label && !NAMES_ONLY_THE_KIND.has(item.value) && (
        <ValueLabel item={item} position={item.shape === 'link' ? midpoint(ends) : ends[0]} opacity={opacity} />
      )}
    </>
  );
}

const GLYPHS: Readonly<Record<LoadItem['shape'], (props: GlyphProps) => React.ReactElement>> = {
  force: ForceArrow,
  torque: TorqueRing,
  axis: AxisLine,
  link: AxisLine,
};

export function DynamicsLoadsOverlay(): React.ReactElement | null {
  const document = useStore((s) => s.document);
  const result = useDynamicsPlaybackStore((s) => s.result);
  const overlay = useLoadOverlayStore();
  // An FE case's own glyphs (FeaSetupOverlay) replace the rigid-body loads while the Analysis panel focuses it.
  const analysisFocused = useAnalysisViewStore((s) => s.focusedAnalysisId !== null);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => useLoadOverlayStore.subscribe(() => invalidate()), [invalidate]);
  const { design, current: items } = useDynamicsLoads();
  const size = useMemo(() => (document.dynamics === undefined ? 1 : modelSize(document)), [document]);
  const reference = useMemo(() => scaleReference(design, result), [design, result]);

  if (!overlay.shown || items.length === 0 || analysisFocused) return null;
  return (
    <group name="dynamics-loads">
      {items
        .filter((item) => isLoadDrawn(overlay, item))
        .map((item) => {
          const Glyph = GLYPHS[item.shape];
          const dimmed = overlay.focusedId !== null && overlay.focusedId !== item.id;
          return (
            <Glyph
              key={item.id}
              item={item}
              size={size}
              reference={reference}
              opacity={dimmed ? 0.2 : 0.95}
              label={overlay.labels && !dimmed}
            />
          );
        })}
    </group>
  );
}
