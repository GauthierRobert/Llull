/** Environment, shadows and light rig scaled by the render-quality tier. Presentation only. */

import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useThree } from '@react-three/fiber';
import { Environment, Lightformer, ContactShadows } from '@react-three/drei';
import type * as THREE from 'three';
import { sunAt, type SunState } from '@core/model/siteContext';
import type { Vec3 } from '@core/model/types';
import { useStore } from '@ui/store';
import { mergedEntityBounds } from './fitBounds';
import { computeContactShadowPlane } from './contactShadowPlane';
import { computeKeyLightRig } from './keyLightRig';
import type { RenderQualitySettings } from './useRenderQuality';
import { CascadedShadows } from './effects/CascadedShadows';
import { useHdrEnvironment } from './appearance/HdrEnvironment';
import { keyLightRule } from './lights/lightModel';
import { useAuthoredLights } from './lights/useAuthoredLights';
import { getContactBakeTick, markShadowsDirty, subscribeContactBake } from './renderRigState';

/** drei ContactShadows lie in the Y-up XZ plane; rotate them into the +Z-up XY ground plane. */
export const GROUND_PLANE_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];

/** World AABB of the whole scene (null when empty); recomputed only when the content changes. */
type SceneBounds = ReturnType<typeof mergedEntityBounds>;

export function useSceneBounds(): SceneBounds {
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
  const groundElevation = useStore((s) => s.document.siteContext?.groundElevation);
  const plane = useMemo(() => computeContactShadowPlane(bounds, renderOrigin, groundElevation), [bounds, renderOrigin, groundElevation]);
  const invalidate = useThree((s) => s.invalidate);
  // RenderRig requests a re-bake (moving parts, edits): re-rendering ContactShadows with frames={1} bakes once on the next frame.
  const bakeTick = useSyncExternalStore(subscribeContactBake, getContactBakeTick);
  useLayoutEffect(() => {
    invalidate();
  }, [bakeTick, invalidate]);
  // frames={1} bakes once per render: remount (re-allocate) only when the footprint changes.
  const bakeKey = `${plane.position.join(',')}|${plane.scale}|${plane.far}`;
  return (
    <ContactShadows
      key={bakeKey}
      position={plane.position}
      rotation={GROUND_PLANE_ROTATION}
      userData={{ noEdges: true }}
      opacity={opacity}
      scale={plane.scale}
      blur={2.5}
      far={plane.far}
      frames={1}
      color="#1a1e2a"
    />
  );
}

/** No picking: the catcher is scenery, never a hit. */
const NO_RAYCAST = (): void => undefined;

/**
 * Shadow catcher: an invisible ground patch that only shows the key light's shadow, so parts sit on the ground instead of floating
 * over the grid. Sized to the key light's shadow frustum (outside it nothing is shadowed anyway).
 */
function GroundShadowCatcher({ opacity, bounds }: { opacity: number; bounds: SceneBounds }): React.ReactElement | null {
  const renderOrigin = useStore((s) => s.renderOrigin);
  const groundElevation = useStore((s) => s.document.siteContext?.groundElevation);
  const plane = useMemo(() => computeContactShadowPlane(bounds, renderOrigin, groundElevation), [bounds, renderOrigin, groundElevation]);
  const rig = useMemo(() => computeKeyLightRig(bounds, renderOrigin), [bounds, renderOrigin]);
  if (bounds === null) return null;
  const side = rig.halfExtent * 2;
  return (
    <mesh
      position={[rig.target[0], rig.target[1], plane.position[2]]}
      scale={[side, side, 1]}
      receiveShadow
      raycast={NO_RAYCAST}
      userData={{ noEdges: true }}
      renderOrder={-1}
    >
      <planeGeometry args={[1, 1]} />
      <shadowMaterial transparent opacity={opacity} depthWrite={false} color="#10131c" />
    </mesh>
  );
}

/** Shadow normal bias as a share of the shadow frustum's half extent (~1.5 texels of a 2048² map). */
const NORMAL_BIAS_PER_HALF_EXTENT = 0.0015;

/** Shadow-casting key light that follows the scene's extent (see keyLightRig.ts). */
function SceneKeyLight({
  shadowMapSize,
  shadowRadius,
  castShadow,
  bounds,
  sunDirection,
  intensity,
}: {
  shadowMapSize: number;
  shadowRadius: number;
  castShadow: boolean;
  bounds: SceneBounds;
  sunDirection: Vec3 | undefined;
  intensity: number;
}): React.ReactElement {
  const renderOrigin = useStore((s) => s.renderOrigin);
  const invalidate = useThree((s) => s.invalidate);
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);

  const rig = useMemo(() => computeKeyLightRig(bounds, renderOrigin, sunDirection), [bounds, renderOrigin, sunDirection]);

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
    // World units: scaled with the frustum so a mm part and a 100 m site get the same acne-free offset in texels.
    light.shadow.normalBias = rig.halfExtent * NORMAL_BIAS_PER_HALF_EXTENT;
    light.target = target;
    target.updateMatrixWorld();
    markShadowsDirty();
    invalidate();
  }, [rig, shadowMapSize, shadowRadius, castShadow, invalidate]);

  return (
    <>
      <object3D ref={targetRef} position={rig.target} />
      <directionalLight
        ref={lightRef}
        position={rig.position}
        intensity={intensity}
        castShadow={castShadow}
        shadow-mapSize={[shadowMapSize, shadowMapSize]}
        shadow-bias={-0.0004}
        // three's own PCF with a blur radius (in shadow-map texels): soft edges without patching the shadow shader chunk.
        shadow-radius={shadowRadius}
      />
    </>
  );
}

/** The site-context sun (null without a site context): recomputed only when the site changes. */
function useSiteSun(): SunState | null {
  const site = useStore((s) => s.document.siteContext);
  return useMemo(() => (site === undefined ? null : sunAt(site)), [site]);
}

/** Only this subscribes to the document, so edits never re-render the Environment (its cube map would re-bake). */
function SceneShadowRig({
  cascaded,
  shadowMapSize,
  shadowRadius,
  keyShadowsEnabled,
  contactShadows,
  contactShadowOpacity,
  groundShadowOpacity,
}: {
  cascaded: boolean;
  shadowMapSize: number;
  shadowRadius: number;
  keyShadowsEnabled: boolean;
  contactShadows: boolean;
  contactShadowOpacity: number;
  groundShadowOpacity: number;
}): React.ReactElement {
  const bounds = useSceneBounds();
  const renderOrigin = useStore((s) => s.renderOrigin);
  const sun = useSiteSun();
  const rig = useMemo(() => computeKeyLightRig(bounds, renderOrigin, sun?.direction), [bounds, renderOrigin, sun]);
  // Sun below the horizon (site context): no key light, no sun shadow; sky light only.
  const sunUp = sun === null || sun.up;
  // Authored lights (RV-M2): none = the rig as before; a sun light replaces the key light; others dim it to a fill (lightModel.keyLightRule).
  const lights = useAuthoredLights();
  const rule = useMemo(() => keyLightRule(lights), [lights]);
  const keyShadows = keyShadowsEnabled && rule.keyShadows;
  // Cascades (High) replace the single key light; with them off the single light is the whole path.
  const useCascades = cascaded && keyShadows && sunUp;
  return (
    <>
      {useCascades ? (
        <CascadedShadows rig={rig} shadowRadius={shadowRadius} />
      ) : (
        <SceneKeyLight
          shadowMapSize={shadowMapSize}
          shadowRadius={shadowRadius}
          castShadow={keyShadows && sunUp}
          bounds={bounds}
          sunDirection={sun?.direction}
          intensity={sunUp ? 1.8 * rule.keyScale : 0}
        />
      )}
      {keyShadows && sunUp && <GroundShadowCatcher opacity={groundShadowOpacity} bounds={bounds} />}
      {contactShadows && <SceneContactShadows opacity={contactShadowOpacity} bounds={bounds} />}
    </>
  );
}

export function SceneLighting({
  quality,
  contactShadowOpacity,
  groundShadowOpacity,
}: {
  quality: RenderQualitySettings;
  contactShadowOpacity: number;
  groundShadowOpacity: number;
}): React.ReactElement {
  // A loaded HDR environment (RV-M2) replaces the procedural one; until it loads (or if it cannot) the procedural one stays.
  const hdrActive = useHdrEnvironment() !== null;
  return (
    <>
      {quality.environmentEnabled && !hdrActive && (
        // Procedural IBL: preset="studio" fetches an HDR from a CDN and crashes offline.
        <Environment background={false} resolution={256}>
          <Lightformer form="rect" intensity={2} position={[0, 5, 5]} scale={[10, 6, 1]} />
          <Lightformer form="rect" intensity={1} position={[-6, -2, 2]} scale={[6, 4, 1]} />
          <Lightformer form="rect" intensity={1} position={[6, -2, 2]} scale={[6, 4, 1]} />
          <Lightformer form="ring" intensity={0.6} position={[0, 0, -4]} scale={8} />
          {/* Wide dim panels all around: a polished metal face must reflect something light from any camera angle. */}
          <Lightformer form="rect" intensity={0.7} position={[0, 0, -8]} scale={[16, 8, 1]} />
          <Lightformer form="rect" intensity={0.7} position={[-8, 0, 0]} rotation-y={Math.PI / 2} scale={[16, 8, 1]} />
          <Lightformer form="rect" intensity={0.7} position={[8, 0, 0]} rotation-y={-Math.PI / 2} scale={[16, 8, 1]} />
          <Lightformer form="rect" intensity={0.5} position={[0, -6, 0]} rotation-x={Math.PI / 2} scale={[16, 16, 1]} />
        </Environment>
      )}

      {/* Hemisphere fill avoids pure-black undersides; cool back-left rim. */}
      <hemisphereLight args={['#c8d8f0', '#3a3228', 0.45]} position={[0, 0, 1]} />
      <directionalLight position={[-6, 8, 4]} intensity={0.4} color="#a8c8ff" />

      <SceneShadowRig
        cascaded={quality.cascadedShadows}
        shadowMapSize={quality.shadowMapSize}
        shadowRadius={quality.shadowRadius}
        keyShadowsEnabled={quality.keyShadows}
        contactShadows={quality.contactShadowsEnabled}
        contactShadowOpacity={contactShadowOpacity}
        groundShadowOpacity={groundShadowOpacity}
      />
    </>
  );
}
