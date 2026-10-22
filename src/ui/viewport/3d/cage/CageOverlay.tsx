// Cage overlays in entity-local space: wireframe, vertices, selected / hovered elements, creases (infinite and semi-sharp) and the
// symmetry planes. Presentation only; geometry comes from the pure builders in cageGeometry.ts.

import { useMemo } from 'react';
import type { SubdivisionEntity } from '@core/model/types';
import { useDisposable } from '../../useDisposable';
import * as THREE from 'three';
import { CAGE_COLORS } from './cagePalette';
import {
  cageSegments,
  creaseSegments,
  loopCutSegments,
  selectedFaceTriangles,
  selectedSegments,
  selectedVertexPositions,
  symmetryPlanes,
  vertexPositions,
} from './cageGeometry';
import { type CageElement, type CageSelection } from './cageSelection';
import { useFloatGeometry } from './useFloatGeometry';

const POINT_PX = 7;

function Lines({ positions, color, opacity = 1 }: { positions: Float32Array; color: string; opacity?: number }): React.ReactElement | null {
  const geometry = useFloatGeometry(positions);
  const material = useDisposable(
    () => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity }),
    [color, opacity],
  );
  return positions.length === 0 ? null : <lineSegments geometry={geometry} material={material} renderOrder={20} frustumCulled={false} />;
}

function Dots({ positions, color, size = POINT_PX }: { positions: Float32Array; color: string; size?: number }): React.ReactElement | null {
  const geometry = useFloatGeometry(positions);
  const material = useDisposable(
    () => new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false, transparent: true }),
    [color, size],
  );
  return positions.length === 0 ? null : <points geometry={geometry} material={material} renderOrder={22} frustumCulled={false} />;
}

function Fill({ positions, color, opacity }: { positions: Float32Array; color: string; opacity: number }): React.ReactElement | null {
  const geometry = useFloatGeometry(positions);
  const material = useDisposable(
    () => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity, side: THREE.DoubleSide }),
    [color, opacity],
  );
  return positions.length === 0 ? null : <mesh geometry={geometry} material={material} renderOrder={18} frustumCulled={false} />;
}

export interface CageOverlayProps {
  readonly cage: SubdivisionEntity;
  readonly selection: CageSelection;
  readonly hover: CageElement | null;
  /** Loop-cut tool: show the loop that a click on the hovered edge would add. */
  readonly loopCuts: number | null;
}

export function CageOverlay({ cage, selection, hover, loopCuts }: CageOverlayProps): React.ReactElement {
  const wire = useMemo(() => cageSegments(cage), [cage]);
  const dots = useMemo(() => vertexPositions(cage), [cage]);
  const creases = useMemo(() => creaseSegments(cage), [cage]);
  const planes = useMemo(() => symmetryPlanes(cage), [cage]);
  const chosen = useMemo(
    () => ({
      segments: selectedSegments(cage, selection),
      faces: selectedFaceTriangles(cage, selection),
      vertices: selectedVertexPositions(cage, selection),
    }),
    [cage, selection],
  );
  const hovered = useMemo(() => {
    const one: CageSelection = {
      vertices: hover?.kind === 'vertex' ? [hover.id] : [],
      edges: hover?.kind === 'edge' ? [hover.id] : [],
      faces: hover?.kind === 'face' ? [hover.id] : [],
    };
    return { segments: selectedSegments(cage, one), faces: selectedFaceTriangles(cage, one), vertices: selectedVertexPositions(cage, one) };
  }, [cage, hover]);
  const loop = useMemo(
    () => (loopCuts !== null && hover?.kind === 'edge' ? loopCutSegments(cage, hover.id, 0.5) : new Float32Array(0)),
    [cage, hover, loopCuts],
  );
  return (
    <group name="cage-overlay">
      {planes.map((plane) => (
        <group key={plane.axis}>
          <Fill positions={plane.triangles} color={CAGE_COLORS.symmetry} opacity={0.08} />
          <Lines positions={plane.outline} color={CAGE_COLORS.symmetry} opacity={0.7} />
        </group>
      ))}
      <Lines positions={wire} color={CAGE_COLORS.wire} opacity={0.55} />
      <Lines positions={creases.sharp} color={CAGE_COLORS.sharp} />
      <Lines positions={creases.semi} color={CAGE_COLORS.semiSharp} />
      <Dots positions={dots} color={CAGE_COLORS.vertex} />
      <Fill positions={hovered.faces} color={CAGE_COLORS.hover} opacity={0.22} />
      <Lines positions={hovered.segments} color={CAGE_COLORS.hover} />
      <Dots positions={hovered.vertices} color={CAGE_COLORS.hover} size={POINT_PX + 4} />
      <Fill positions={chosen.faces} color={CAGE_COLORS.selected} opacity={0.3} />
      <Lines positions={chosen.segments} color={CAGE_COLORS.selected} />
      <Dots positions={chosen.vertices} color={CAGE_COLORS.selected} size={POINT_PX + 3} />
      <Lines positions={loop} color={CAGE_COLORS.loop} />
    </group>
  );
}
