// In-Canvas overlay of the live-edit effects, inside the floating-origin group: hologram ghosts of removed / reshaped
// entities, ground ripples under new ones, the "who did it" badge, and the driver that keeps the demand frameloop
// painting (and prunes finished effects) while anything is animating.

import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { hasActiveLiveFx, RIPPLE_MS, useLiveFxStore } from '@ui/store/liveFxStore';
import { easeOutCubic, ghostMatrix, ghostOpacity, progressAt } from './liveFxMath';
import { hologramize, setOpacity } from './materialFx';
import { toneColor, toneHex } from './liveFxTones';
import type { LiveBadge, LiveGhost, LiveRipple } from './planLiveFx';

/** Draws the previous version of an entity (the view's own render branch); null = no ghost in this view. */
export type GhostRenderer = (ghost: LiveGhost) => React.ReactElement | null;

function LiveFxDriver(): null {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => useLiveFxStore.subscribe(() => invalidate()), [invalidate]);
  useFrame(() => {
    const state = useLiveFxStore.getState();
    if (!hasActiveLiveFx(state)) return;
    state.prune(performance.now());
    invalidate();
  });
  return null;
}

const GhostView = memo(function GhostView({ ghost, render }: { ghost: LiveGhost; render: GhostRenderer }): React.ReactElement | null {
  const groupRef = useRef<THREE.Group>(null);
  const clonesRef = useRef<THREE.Material[]>([]);
  const content = useMemo(() => render(ghost), [render, ghost]);

  const step = (): void => {
    const group = groupRef.current;
    if (group === null) return;
    const t = progressAt(performance.now(), ghost.startMs, ghost.durationMs);
    ghostMatrix(group.matrix, ghost.mode, ghost.center, ghost.size * 0.5, t);
    group.matrixWorldNeedsUpdate = true;
    setOpacity(clonesRef.current, ghostOpacity(ghost.mode, t));
  };

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (group === null) return undefined;
    clonesRef.current = hologramize(group, toneColor(ghost.tone));
    step();
    return () => {
      for (const material of clonesRef.current) material.dispose();
      clonesRef.current = [];
    };
    // Once per ghost: its render branch never re-renders (stable entity), so the clones stay attached.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost]);
  useFrame(step);

  if (content === null) return null;
  return (
    <group ref={groupRef} matrixAutoUpdate={false} name={`live-ghost-${ghost.entity.id}`}>
      {content}
    </group>
  );
});

const RING_GEOMETRY = new THREE.RingGeometry(0.9, 1, 96);

function RippleRing({ ripple, delayMs }: { ripple: LiveRipple; delayMs: number }): React.ReactElement {
  const meshRef = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: toneColor(ripple.tone),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [ripple.tone],
  );
  useEffect(() => () => material.dispose(), [material]);
  useFrame(() => {
    const mesh = meshRef.current;
    if (mesh === null) return;
    const t = progressAt(performance.now(), ripple.startMs + delayMs, RIPPLE_MS - delayMs);
    const radius = ripple.radius * (0.35 + 1.4 * easeOutCubic(t));
    mesh.scale.set(radius, radius, 1);
    material.opacity = t <= 0 || t >= 1 ? 0 : 0.75 * (1 - t);
  });
  const [x, y, z] = ripple.center;
  return <mesh ref={meshRef} geometry={RING_GEOMETRY} material={material} position={[x, y, z + 1e-3]} raycast={() => undefined} />;
}

function RippleView({ ripple }: { ripple: LiveRipple }): React.ReactElement {
  return (
    <>
      <RippleRing ripple={ripple} delayMs={0} />
      <RippleRing ripple={ripple} delayMs={220} />
    </>
  );
}

function BadgeView({ badge }: { badge: LiveBadge }): React.ReactElement {
  const style = useMemo(() => ({ '--live-fx-accent': toneHex(badge.source) }) as React.CSSProperties, [badge.source]);
  return (
    <Html position={badge.anchor} center zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }}>
      <div className="live-fx-badge" style={style} data-source={badge.source}>
        <span className="live-fx-badge__dot" aria-hidden="true" />
        {badge.label}
      </div>
    </Html>
  );
}

export function LiveFxLayer({ renderGhost }: { renderGhost: GhostRenderer }): React.ReactElement {
  const ghosts = useLiveFxStore((s) => s.ghosts);
  const ripples = useLiveFxStore((s) => s.ripples);
  const badges = useLiveFxStore((s) => s.badges);
  return (
    <group name="live-fx">
      <LiveFxDriver />
      {ghosts.map((ghost) => (
        <GhostView key={ghost.key} ghost={ghost} render={renderGhost} />
      ))}
      {ripples.map((ripple) => (
        <RippleView key={ripple.key} ripple={ripple} />
      ))}
      {badges.map((badge) => (
        <BadgeView key={badge.key} badge={badge} />
      ))}
    </group>
  );
}
