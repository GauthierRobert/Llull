// In-Canvas ghost of the running feature preview: the dry-run result entities through the view's own render branch, swapped to
// translucent tinted materials (hologram). Add/join previews glow blue, cut previews red. Not pickable, no shadows.

import { useLayoutEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Entity } from '@core/model/types';
import { usePreviewStore } from '@ui/store/previewStore';
import { hologramize, setOpacity } from '../../liveFx/materialFx';

const TONE_COLOR = { add: new THREE.Color('#3b82f6'), cut: new THREE.Color('#ef4444') } as const;
const GHOST_OPACITY = 0.42;

export type RenderPreviewEntity = (entity: Entity) => React.ReactElement | null;

export function PreviewLayer({ renderEntity }: { renderEntity: RenderPreviewEntity }): React.ReactElement | null {
  const outcome = usePreviewStore((s) => s.outcome);
  const tone = usePreviewStore((s) => s.tone);
  const invalidate = useThree((s) => s.invalidate);
  const groupRef = useRef<THREE.Group>(null);

  // Materials are cloned once per outcome; the clones are ours to dispose.
  useLayoutEffect(() => {
    const group = groupRef.current;
    invalidate();
    if (group === null) return undefined;
    const clones = hologramize(group, TONE_COLOR[tone]);
    setOpacity(clones, GHOST_OPACITY);
    return () => {
      for (const material of clones) material.dispose();
    };
  }, [outcome, tone, invalidate]);

  if (outcome === null || !outcome.ok) return null;
  return (
    <group ref={groupRef} name="feature-preview">
      {outcome.entities.map((entity) => renderEntity(entity))}
    </group>
  );
}
