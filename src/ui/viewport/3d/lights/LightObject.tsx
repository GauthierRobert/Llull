// Render branch of `kind: 'light'`: the glyph (sun arrow, point bulb, spot cone, area rectangle: pickable, moved by the gizmo like any
// entity) and the actual three.js light at the same pose, driven by intensity / colour / cone / blend / size. Lights aim along local -Z.
// Shadows: only `castShadows` lights, at most MAX_AUTHORED_SHADOW_LIGHTS, none when the quality tier has no shadows. Area lights never cast
// (three.js limit). The built-in rig yields to authored lights per `keyLightRule` (SceneLighting).

import { useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { boundsCenter, boundsDiagonalRadius } from '@core/geometry/bounds';
import { MM_PER_UNIT } from '@core/model/units';
import type { LightEntity, Vec3 } from '@core/model/types';
import { useStore } from '@ui/store';
import { useSceneBounds } from '../SceneLighting';
import { markShadowsDirty } from '../renderRigState';
import { useRenderQuality } from '../useRenderQuality';
import { SceneObjectGlyph } from './SceneObjectGlyph';
import { lightGlyph } from './sceneObjectGlyphs';
import { perspectiveShadowRange, shadowCasterIds, sunShadowFrustum, threeLightOf, type ThreeLight } from './lightModel';
import { useAuthoredLights } from './useAuthoredLights';

let areaLightsReady = false;

/** Area lights need three's LTC lookup tables once, before the first material that sees one compiles. */
function ensureAreaLights(): void {
  if (areaLightsReady) return;
  areaLightsReady = true;
  RectAreaLightUniformsLib.init();
}

/** Point / spot shadow maps are cube / perspective maps: capped below the key light's. */
const POINT_SHADOW_MAP = 1024;
const FALLBACK_EXTENT = { center: [0, 0, 0] as Vec3, radius: 10 };

function useSceneExtent(): { center: Vec3; radius: number } {
  const bounds = useSceneBounds();
  return useMemo(
    () => (bounds === null ? FALLBACK_EXTENT : { center: boundsCenter(bounds), radius: Math.max(boundsDiagonalRadius(bounds), 1e-3) }),
    [bounds],
  );
}

interface LightRigProps {
  entity: LightEntity;
  three: ThreeLight;
  castShadow: boolean;
  mapSize: number;
  shadowRadius: number;
}

/** The three.js light itself, a child of the entity group: world pose = entity pose. */
function LightRig({ entity, three, castShadow, mapSize, shadowRadius }: LightRigProps): React.ReactElement {
  const invalidate = useThree((s) => s.invalidate);
  const extent = useSceneExtent();
  const lightRef = useRef<THREE.DirectionalLight | THREE.SpotLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);
  if (three.type === 'area') ensureAreaLights();

  const { position, rotation } = entity;
  useLayoutEffect(() => {
    const light = lightRef.current;
    const target = targetRef.current;
    if (light === null || target === null) return;
    light.target = target;
    if (castShadow) {
      if (light instanceof THREE.DirectionalLight) {
        const f = sunShadowFrustum(position, rotation, extent.center, extent.radius);
        const camera = light.shadow.camera;
        camera.left = f.left;
        camera.right = f.right;
        camera.top = f.top;
        camera.bottom = f.bottom;
        camera.near = f.near;
        camera.far = f.far;
        camera.updateProjectionMatrix();
        light.shadow.normalBias = extent.radius * 0.002;
      } else {
        const distance = Math.hypot(extent.center[0] - position[0], extent.center[1] - position[1], extent.center[2] - position[2]);
        const range = perspectiveShadowRange(distance, extent.radius);
        light.shadow.camera.near = range.near;
        light.shadow.camera.far = range.far;
        light.shadow.camera.updateProjectionMatrix();
      }
    }
    markShadowsDirty();
    invalidate();
  }, [castShadow, position, rotation, extent, three, invalidate]);

  const shadowProps = {
    castShadow,
    'shadow-mapSize': [mapSize, mapSize] as [number, number],
    'shadow-bias': -0.0004,
    'shadow-radius': shadowRadius,
  };
  switch (three.type) {
    case 'sun':
      return (
        <directionalLight
          ref={lightRef as React.Ref<THREE.DirectionalLight>}
          color={three.color}
          intensity={three.intensity}
          {...shadowProps}
        >
          <object3D ref={targetRef} position={[0, 0, -1]} />
        </directionalLight>
      );
    case 'spot':
      return (
        <spotLight
          ref={lightRef as React.Ref<THREE.SpotLight>}
          color={three.color}
          intensity={three.intensity}
          angle={three.angle}
          penumbra={three.penumbra}
          decay={2}
          {...shadowProps}
          shadow-mapSize={[Math.min(mapSize, POINT_SHADOW_MAP), Math.min(mapSize, POINT_SHADOW_MAP)]}
        >
          <object3D ref={targetRef} position={[0, 0, -1]} />
        </spotLight>
      );
    case 'point':
      return (
        <pointLight
          color={three.color}
          intensity={three.intensity}
          decay={2}
          {...shadowProps}
          shadow-mapSize={[Math.min(mapSize, POINT_SHADOW_MAP), Math.min(mapSize, POINT_SHADOW_MAP)]}
        />
      );
    case 'area':
      return <rectAreaLight color={three.color} intensity={three.intensity} width={three.width} height={three.height} />;
  }
}

export function LightObject({
  entity,
  selected,
  onSelect,
}: {
  entity: LightEntity;
  selected: boolean;
  onSelect: (id: string, additive: boolean) => void;
}): React.ReactElement {
  const units = useStore((s) => s.document.units);
  const quality = useRenderQuality();
  const lights = useAuthoredLights();
  const casters = useMemo(() => shadowCasterIds(lights, quality.keyShadows), [lights, quality.keyShadows]);
  const three = useMemo(() => threeLightOf(entity, MM_PER_UNIT[units] / 1000), [entity, units]);
  const glyph = useMemo(() => lightGlyph(entity), [entity]);
  const pickPlane = entity.lightType === 'area' ? { width: entity.width ?? 1, height: entity.height ?? 1 } : undefined;
  return (
    <SceneObjectGlyph
      entity={entity}
      positions={glyph.positions}
      screenScaled={glyph.screenScaled}
      color={entity.lightColor}
      selected={selected}
      onSelect={onSelect}
      {...(pickPlane !== undefined && { pickPlane })}
    >
      <LightRig
        entity={entity}
        three={three}
        castShadow={casters.has(entity.id)}
        mapSize={quality.shadowMapSize}
        shadowRadius={quality.shadowRadius}
      />
    </SceneObjectGlyph>
  );
}
