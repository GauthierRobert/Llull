// Wraps an entity's render branch while it has a live transition: grow / travel / pulse via the group matrix, plus an
// accent glow on its materials. Per-frame work only mutates refs (R9); the glow is restored exactly when it ends.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import { type Entity, is2D } from '@core/model/types';
import { useLiveFxStore } from '@ui/store/liveFxStore';
import { glowAt, progressAt, transitionMatrix } from './liveFxMath';
import { GlowTracker } from './materialFx';
import { toneColor, toneStrength } from './liveFxTones';

interface LiveTransitionGroupProps {
  entity: Entity;
  children: React.ReactNode;
}

export function LiveTransitionGroup({ entity, children }: LiveTransitionGroupProps): React.ReactElement {
  const transition = useLiveFxStore((s) => s.transitions.get(entity.id));
  const groupRef = useRef<THREE.Group>(null);
  const glowRef = useRef(new GlowTracker());

  useEffect(() => {
    const glow = glowRef.current;
    return () => glow.restore();
  }, [transition]);

  const step = (): void => {
    const group = groupRef.current;
    if (group === null) return;
    if (transition === undefined) {
      group.matrix.identity();
      return;
    }
    const t = progressAt(performance.now(), transition.startMs, transition.durationMs);
    transitionMatrix(group.matrix, transition, entity, t, is2D(entity));
    group.matrixWorldNeedsUpdate = true;
    if (t >= 1) glowRef.current.restore();
    else glowRef.current.apply(group, toneColor(transition.tone), glowAt(t) * toneStrength(transition.tone));
  };
  // Before the first paint: a new entity must not flash at full size for one frame.
  useLayoutEffect(step);
  useFrame(step);

  return (
    <group ref={groupRef} matrixAutoUpdate={false} name={`live-fx-${entity.id}`}>
      {children}
    </group>
  );
}
