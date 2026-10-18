// Glyphs of the Analysis set-up in the 3D view: supports (cyan solids by kind), load arrows / moment rings (magenta), thermal BC markers
// (coloured by kind), probe and result-extreme pins. Sized from the analysed parts, drawn over the model (depthTest off).

import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import type { SetupItem } from '@ui/panels/analysis/analysisItems';
import { useDisposable } from '../../useDisposable';
import { ProjectedLabel } from '../ProjectedLabel';

const RENDER_ORDER = 998;
const UP = new THREE.Vector3(0, 1, 0);

interface GlyphProps {
  item: SetupItem;
  point: Vec3;
  /** Extent of the analysed parts. */
  size: number;
  opacity: number;
}

function useGlyphMaterial(color: string, opacity: number): THREE.MeshBasicMaterial {
  return useDisposable(() => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }), [color, opacity]);
}

function orientation(direction: Vec3 | null): THREE.Quaternion {
  const [x, y, z] = direction ?? [0, 0, 1];
  return new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(x, y, z));
}

/** Force / gravity arrow: the tip lands on the point (gravity: it starts there and points down). */
function Arrow({ item, point, size, opacity }: GlyphProps): React.ReactElement {
  const material = useGlyphMaterial(item.color, opacity);
  const direction = useMemo((): Vec3 => item.direction ?? [0, 0, -1], [item.direction]);
  const length = size * 0.2;
  const head = length * 0.35;
  const radius = size * 0.007;
  const quaternion = useMemo(() => orientation(direction), [direction]);
  const tail: Vec3 =
    item.glyph === 'gravity'
      ? point
      : [point[0] - direction[0] * length, point[1] - direction[1] * length, point[2] - direction[2] * length];
  return (
    <group position={tail} quaternion={quaternion}>
      <mesh material={material} position={[0, (length - head) / 2, 0]} renderOrder={RENDER_ORDER}>
        <cylinderGeometry args={[radius, radius, length - head, 8]} />
      </mesh>
      <mesh material={material} position={[0, length - head / 2, 0]} renderOrder={RENDER_ORDER}>
        <coneGeometry args={[radius * 3, head, 12]} />
      </mesh>
    </group>
  );
}

/** Moment: three-quarter ring about the moment axis with an arrow head. */
function Ring({ item, point, size, opacity }: GlyphProps): React.ReactElement {
  const material = useGlyphMaterial(item.color, opacity);
  const quaternion = useMemo(() => orientation(item.direction), [item.direction]);
  const ring = size * 0.06;
  const tube = size * 0.006;
  const sweep = Math.PI * 1.5;
  return (
    <group position={point} quaternion={quaternion}>
      <group rotation={[Math.PI / 2, 0, 0]}>
        <mesh material={material} renderOrder={RENDER_ORDER}>
          <torusGeometry args={[ring, tube, 6, 40, sweep]} />
        </mesh>
        <mesh
          material={material}
          position={[ring * Math.cos(sweep), ring * Math.sin(sweep), 0]}
          rotation={[0, 0, sweep]}
          renderOrder={RENDER_ORDER}
        >
          <coneGeometry args={[tube * 3.5, size * 0.035, 12]} />
        </mesh>
      </group>
    </group>
  );
}

/** Support solids, one distinct shape per kind. */
function Support({ item, point, size, opacity }: GlyphProps): React.ReactElement {
  const material = useGlyphMaterial(item.color, opacity);
  const s = size * 0.03;
  return (
    <mesh
      position={point}
      material={material}
      rotation={item.glyph === 'pinned' || item.glyph === 'symmetry' ? [Math.PI / 2, 0, 0] : [0, 0, 0]}
      renderOrder={RENDER_ORDER}
    >
      {item.glyph === 'fixed' && <boxGeometry args={[s, s, s]} />}
      {item.glyph === 'pinned' && <coneGeometry args={[s * 0.8, s * 1.4, 4]} />}
      {item.glyph === 'symmetry' && <cylinderGeometry args={[s * 1.1, s * 1.1, s * 0.2, 24]} />}
      {item.glyph === 'displacement' && <octahedronGeometry args={[s * 0.8]} />}
    </mesh>
  );
}

/** Thermal BC / pressure marker: a ball with a faint halo. */
function Ball({ item, point, size, opacity }: GlyphProps): React.ReactElement {
  const material = useGlyphMaterial(item.color, opacity);
  const halo = useGlyphMaterial(item.color, opacity * 0.25);
  const r = size * 0.016;
  return (
    <group position={point}>
      <mesh material={halo} renderOrder={RENDER_ORDER}>
        <sphereGeometry args={[r * 2.2, 16, 12]} />
      </mesh>
      <mesh material={material} renderOrder={RENDER_ORDER + 1}>
        <sphereGeometry args={[r, 16, 12]} />
      </mesh>
    </group>
  );
}

/** Pin: head ball on a needle whose tip sits on the point (probes, result extremes). */
function Pin({ item, point, size, opacity }: GlyphProps): React.ReactElement {
  const material = useGlyphMaterial(item.color, opacity);
  const needle = size * 0.05;
  const r = size * 0.014;
  return (
    <group position={point}>
      <mesh material={material} position={[0, 0, needle / 2]} rotation={[Math.PI / 2, 0, 0]} renderOrder={RENDER_ORDER}>
        <cylinderGeometry args={[r * 0.2, r * 0.2, needle, 6]} />
      </mesh>
      <mesh material={material} position={[0, 0, needle]} renderOrder={RENDER_ORDER}>
        <sphereGeometry args={[r, 16, 12]} />
      </mesh>
    </group>
  );
}

const GLYPHS: Readonly<Record<SetupItem['glyph'], (props: GlyphProps) => React.ReactElement>> = {
  fixed: Support,
  pinned: Support,
  symmetry: Support,
  displacement: Support,
  force: Arrow,
  gravity: Arrow,
  moment: Ring,
  pressure: Ball,
  thermal: Ball,
  probe: Pin,
  'peak-high': Pin,
  'peak-low': Pin,
};

/** Where the pill sits: pins and arrows carry it at their head. */
function labelAnchor(item: SetupItem, point: Vec3, size: number): Vec3 {
  if (item.glyph === 'probe' || item.glyph === 'peak-high' || item.glyph === 'peak-low')
    return [point[0], point[1], point[2] + size * 0.05];
  return point;
}

export function ItemGlyphs({
  item,
  size,
  opacity,
  labelled,
}: {
  item: SetupItem;
  size: number;
  opacity: number;
  labelled: boolean;
}): React.ReactElement {
  const Glyph = GLYPHS[item.glyph];
  return (
    <>
      {item.points.map((point, index) => (
        <React.Fragment key={`${item.key}:${index}`}>
          <Glyph item={item} point={point} size={size} opacity={opacity} />
          {labelled && index === 0 && (
            <ProjectedLabel
              position={labelAnchor(item, point, size)}
              text={item.label}
              className="load-label analysis-label"
              borderColor={item.color}
              opacity={opacity}
              testId={`analysis-label-${item.key}`}
            />
          )}
        </React.Fragment>
      ))}
    </>
  );
}
