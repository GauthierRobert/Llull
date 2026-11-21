// High-tier cascaded shadow maps replacing the single scene-fitted key light (SceneKeyLight): the controller's cascade lights follow the
// camera, receivers are patched as they appear. Presentation only; mounted before RenderRig so its dirty mark is read the same frame.

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { markShadowsDirty } from '../renderRigState';
import type { KeyLightRig } from '../keyLightRig';
import { CascadeController } from './CascadeController';
import { csmConfigFor, csmConfigKey } from './csmConfig';

/** Key light intensity of the single-light path (SceneLighting), kept so a tier switch does not change the exposure. */
const KEY_INTENSITY = 1.8;
/** A sweep walks the scene graph: every this many frames, not every frame. */
const SWEEP_EVERY_FRAMES = 15;

export function CascadedShadows({ rig, shadowRadius }: { rig: KeyLightRig; shadowRadius: number }): null {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const controller = useRef<CascadeController | null>(null);
  const frames = useRef(0);
  const config = csmConfigFor(rig);
  const key = csmConfigKey(config);

  useEffect(() => {
    const built = new CascadeController(scene, camera, csmConfigFor(rig), KEY_INTENSITY, shadowRadius);
    controller.current = built;
    frames.current = 0;
    markShadowsDirty();
    invalidate();
    return () => {
      controller.current = null;
      built.dispose();
      markShadowsDirty();
      invalidate();
    };
    // The rig object changes with every bounds object; `key` is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, camera, key, shadowRadius, invalidate]);

  useFrame(() => {
    const active = controller.current;
    if (active === null) return;
    if (frames.current++ % SWEEP_EVERY_FRAMES === 0 && active.sweep() > 0) markShadowsDirty();
    if (active.update()) markShadowsDirty();
  });
  return null;
}
