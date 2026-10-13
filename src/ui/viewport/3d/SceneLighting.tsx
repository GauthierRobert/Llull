/** Environment, shadows and light rig scaled by the render-quality tier. Presentation only. */

import { useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Environment, Lightformer, ContactShadows, SoftShadows } from '@react-three/drei';
import type * as THREE from 'three';
import { useStore } from '@ui/store';
import { mergedEntityBounds } from './fitBounds';
import { computeContactShadowPlane } from './contactShadowPlane';
import { computeKeyLightRig } from './keyLightRig';
import type { RenderQualitySettings } from './useRenderQuality';

/** drei ContactShadows lie in the Y-up XZ plane; rotate them into the +Z-up XY ground plane. */
export const GROUND_PLANE_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];

/** World AABB of the whole scene (null when empty); recomputed only when the content changes. */
type SceneBounds = ReturnType<typeof mergedEntityBounds>;

function useSceneBounds(): SceneBounds {
  const entities = useStore((s) => s.document.entities);
  const components = useStore((s) => s.document.components);
  const order = useStore((s) => s.document.order);
  return useMemo(
    () => mergedEntityBounds(useStore.getState().document, order),
    // entities/components are the content identity; order alone misses in-place edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entities, components, order],
  );
}

/** Ground contact-shadow patch sized to the scene footprint (see contactShadowPlane.ts). */
function SceneContactShadows({ opacity, bounds }: { opacity: number; bounds: SceneBounds }): React.ReactElement {
  const renderOrigin = useStore((s) => s.renderOrigin);
  const plane = useMemo(() => computeContactShadowPlane(bounds, renderOrigin), [bounds, renderOrigin]);
  // frames={1} bakes once: remount (re-bake) when the footprint changes.
  const bakeKey = `${plane.position.join(',')}|${plane.scale}|${plane.far}`;
  return (
    <ContactShadows
      key={bakeKey}
      position={plane.position}
      rotation={GROUND_PLANE_ROTATION}
      opacity={opacity}
      scale={plane.scale}
      blur={2.5}
      far={plane.far}
      frames={1}
      color="#1a1e2a"
    />
  );
}

/** Shadow-casting key light that follows the scene's extent (see keyLightRig.ts). */
function SceneKeyLight({ shadowMapSize, bounds }: { shadowMapSize: number; bounds: SceneBounds }): React.ReactElement {
  const renderOrigin = useStore((s) => s.renderOrigin);
  const invalidate = useThree((s) => s.invalidate);
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);

  const rig = useMemo(() => computeKeyLightRig(bounds, renderOrigin), [bounds, renderOrigin]);

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

/** Only this subscribes to the document, so edits never re-render the Environment (its cube map would re-bake). */
function SceneShadowRig({
  shadowMapSize,
  contactShadows,
  contactShadowOpacity,
}: {
  shadowMapSize: number;
  contactShadows: boolean;
  contactShadowOpacity: number;
}): React.ReactElement {
  const bounds = useSceneBounds();
  return (
    <>
      <SceneKeyLight shadowMapSize={shadowMapSize} bounds={bounds} />
      {contactShadows && <SceneContactShadows opacity={contactShadowOpacity} bounds={bounds} />}
    </>
  );
}

export function SceneLighting({
  quality,
  contactShadowOpacity,
}: {
  quality: RenderQualitySettings;
  contactShadowOpacity: number;
}): React.ReactElement {
  return (
    <>
      {quality.environmentEnabled && (
        // Procedural IBL: preset="studio" fetches an HDR from a CDN and crashes offline.
        <Environment background={false} resolution={256}>
          <Lightformer form="rect" intensity={2} position={[0, 5, 5]} scale={[10, 6, 1]} />
          <Lightformer form="rect" intensity={1} position={[-6, -2, 2]} scale={[6, 4, 1]} />
          <Lightformer form="rect" intensity={1} position={[6, -2, 2]} scale={[6, 4, 1]} />
          <Lightformer form="ring" intensity={0.6} position={[0, 0, -4]} scale={8} />
        </Environment>
      )}

      {quality.softShadowSamples > 0 && <SoftShadows size={25} samples={quality.softShadowSamples} focus={0.5} />}

      {/* Hemisphere fill avoids pure-black undersides; cool back-left rim. */}
      <hemisphereLight args={['#c8d8f0', '#3a3228', 0.45]} position={[0, 0, 1]} />
      <directionalLight position={[-6, 8, 4]} intensity={0.4} color="#a8c8ff" />

      <SceneShadowRig
        shadowMapSize={quality.shadowMapSize}
        contactShadows={quality.contactShadowsEnabled}
        contactShadowOpacity={contactShadowOpacity}
      />
    </>
  );
}
