/**
 * @layer ui/viewport/3d
 * Environment, shadows and light rig scaled by the render-quality tier. Presentation only.
 */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Environment, Lightformer, ContactShadows, SoftShadows } from '@react-three/drei';
import type * as THREE from 'three';
import { useStore } from '@ui/store';
import { mergedEntityBounds } from './fitBounds';
import { computeKeyLightRig } from './keyLightRig';
import type { RenderQualitySettings } from './useRenderQuality';

/** drei ContactShadows lie in the Y-up XZ plane; rotate them into the +Z-up XY ground plane. */
export const GROUND_PLANE_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];

/** Shadow-casting key light that follows the scene's extent (see keyLightRig.ts). */
function SceneKeyLight({ shadowMapSize }: { shadowMapSize: number }): React.ReactElement {
  const entities = useStore((s) => s.document.entities);
  const components = useStore((s) => s.document.components);
  const order = useStore((s) => s.document.order);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const invalidate = useThree((s) => s.invalidate);
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);

  const rig = useMemo(() => {
    const bounds = mergedEntityBounds(useStore.getState().document, order);
    return computeKeyLightRig(bounds, renderOrigin);
    // entities/components are the content identity; order alone misses in-place edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities, components, order, renderOrigin]);

  useLayoutEffect(() => {
    const light = lightRef.current;
    const target = targetRef.current;
    if (!light || !target) return;
    const camera = light.shadow.camera as THREE.OrthographicCamera;
    camera.left = -rig.halfExtent;
    camera.right = rig.halfExtent;
    camera.top = rig.halfExtent;
    camera.bottom = -rig.halfExtent;
    camera.near = rig.near;
    camera.far = rig.far;
    // Z-up document: the default Y-up shadow camera left a dark patch on an off-origin scene.
    camera.up.set(0, 0, 1);
    camera.updateProjectionMatrix();
    light.target = target;
    target.updateMatrixWorld();
    invalidate();
  }, [rig, invalidate]);

  return (
    <>
      <object3D ref={targetRef} position={rig.target} />
      <directionalLight
        ref={lightRef}
        position={rig.position}
        intensity={1.8}
        castShadow
        shadow-mapSize={[shadowMapSize, shadowMapSize]}
        shadow-bias={-0.0004}
      />
    </>
  );
}

interface SceneLightingProps {
  quality: RenderQualitySettings;
  contactShadowOpacity: number;
}

export function SceneLighting({
  quality,
  contactShadowOpacity,
}: SceneLightingProps): React.ReactElement {
  return (
    <>
      {/* ---- IBL environment: studio preset for reflections/ambient; no background.
           Kept on across all quality tiers — it is a single texture sample (cheap)
           and significantly improves material quality. ---- */}
      {quality.environmentEnabled && (
        // Procedural studio IBL — no network fetch (preset="studio" pulls an HDR from a CDN
        // and crashes the viewport offline).
        <Environment background={false} resolution={256}>
          <Lightformer form="rect" intensity={2} position={[0, 5, 5]} scale={[10, 6, 1]} />
          <Lightformer form="rect" intensity={1} position={[-6, -2, 2]} scale={[6, 4, 1]} />
          <Lightformer form="rect" intensity={1} position={[6, -2, 2]} scale={[6, 4, 1]} />
          <Lightformer form="ring" intensity={0.6} position={[0, 0, -4]} scale={8} />
        </Environment>
      )}

      {/* ---- Soft shadow patch: PCSS-style softening on the shadow map.
           Disabled in Low tier (softShadowSamples === 0) to save per-fragment cost.
           Medium tier: 8 samples (halved from High's 16). ---- */}
      {quality.softShadowSamples > 0 && (
        <SoftShadows size={25} samples={quality.softShadowSamples} focus={0.5} />
      )}

      {/* ---- Light rig ----
           hemisphere: warm ground / cool sky fill to avoid pure-black undersides.
           directional key: high-angle from front-right, casts shadows.
             shadow-mapSize scales with quality tier (2048 High / 1024 Medium+Low).
           directional rim: cool back-left counter fill.  */}
      <hemisphereLight args={['#c8d8f0', '#3a3228', 0.45]} position={[0, 0, 1]} />
      <SceneKeyLight shadowMapSize={quality.shadowMapSize} />
      <directionalLight position={[-6, 8, 4]} intensity={0.4} color="#a8c8ff" />

      {/* ---- Contact shadows: rendered once (frames=1) — safe under demand frameloop.
           Disabled in Low tier to avoid the extra render pass. ---- */}
      {quality.contactShadowsEnabled && (
        <ContactShadows
          position={[0, 0, -0.001]}
          rotation={GROUND_PLANE_ROTATION}
          opacity={contactShadowOpacity}
          scale={40}
          blur={2.5}
          far={20}
          frames={1}
          color="#1a1e2a"
        />
      )}
    </>
  );
}
