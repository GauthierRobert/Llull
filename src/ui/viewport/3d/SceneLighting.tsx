/**
 * @layer ui/viewport/3d
 * Environment, shadows and light rig scaled by the render-quality tier. Presentation only.
 */

import { Environment, Lightformer, ContactShadows, SoftShadows } from '@react-three/drei';
import type { RenderQualitySettings } from './useRenderQuality';

/** drei ContactShadows lie in the Y-up XZ plane; rotate them into the +Z-up XY ground plane. */
export const GROUND_PLANE_ROTATION: [number, number, number] = [Math.PI / 2, 0, 0];

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
      <directionalLight
        position={[8, -6, 14]}
        intensity={1.8}
        castShadow
        shadow-mapSize={[quality.shadowMapSize, quality.shadowMapSize]}
        shadow-camera-near={0.5}
        shadow-camera-far={200}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.0004}
      />
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
