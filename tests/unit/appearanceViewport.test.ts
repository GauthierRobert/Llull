import { describe, expect, it } from 'vitest';
import type { Appearance, SceneEnvironment, TextureRecord } from '@core/model/appearance';
import { cameraVerticalFov } from '@core/model/sceneKinds';
import { resolveAppearance } from '@core/model/appearance';
import { mapRequests, surfacePlan, type MapChannel } from '@ui/viewport/3d/appearance/surfacePlan';
import { environmentLook, hdrOrientation, skyTurbidity } from '@ui/viewport/3d/appearance/environmentPlan';
import { keyLightRule, perspectiveShadowRange, shadowCasterIds, sunShadowFrustum, threeLightOf } from '@ui/viewport/3d/lights/lightModel';
import { aimInPlan, cameraGlyph, lightGlyph, planSymbol } from '@ui/viewport/3d/lights/sceneObjectGlyphs';
import { glyphInk } from '@ui/viewport/3d/lights/glyphInk';
import { lookThroughCamera } from '@ui/viewport/3d/lights/lookThrough';
import { buildMeshSolidGeometry } from '@ui/viewport/3d/entities/meshSolidGeometry';

const tex = (id: string, format: TextureRecord['format'] = 'png'): TextureRecord => ({
  id,
  name: id,
  key: `key-${id}`,
  format,
  width: 4,
  height: 4,
  bytes: 1,
  colorSpace: 'srgb',
});
const FALLBACK = { color: '#c8553d', metalness: 0.1, roughness: 0.6 };
const NONE: ReadonlySet<MapChannel> = new Set();

describe('resolveAppearance', () => {
  const material = { appearance: { metalness: { value: 1 }, roughness: { value: 0.3 } } satisfies Appearance };
  it('is undefined without an appearance anywhere', () => {
    expect(resolveAppearance({}, undefined)).toBeUndefined();
    expect(resolveAppearance({}, {})).toBeUndefined();
  });
  it('takes the material appearance, and the entity override wins channel by channel', () => {
    expect(resolveAppearance({}, material)).toBe(material.appearance);
    expect(resolveAppearance({ appearance: { roughness: { value: 0.9 } } }, material)).toEqual({
      metalness: { value: 1 },
      roughness: { value: 0.9 },
    });
    const own: Appearance = { ior: 1.3 };
    expect(resolveAppearance({ appearance: own }, undefined)).toBe(own);
  });
});

describe('mapRequests', () => {
  const textures = { a: tex('a'), n: tex('n'), h: tex('h', 'hdr') };
  it('lists held, non-HDR textures with a colour space decided by the channel', () => {
    const requests = mapRequests(
      {
        baseColor: { texture: 'a' },
        normal: { texture: 'n' },
        roughness: { texture: 'a' },
        coat: { texture: 'gone' },
        emission: { texture: 'h' },
      },
      textures,
    );
    expect(requests.map((r) => [r.channel, r.colorSpace])).toEqual([
      ['baseColor', 'srgb'],
      ['roughness', 'linear'],
      ['normal', 'linear'],
    ]);
    expect(requests[0]?.key).toBe('key-a');
  });
});

describe('surfacePlan', () => {
  it('falls back to the material colour and defaults while a texture is missing', () => {
    const plan = surfacePlan({ baseColor: { texture: 'a' }, roughness: { texture: 'a' } }, FALLBACK, NONE);
    expect(plan).toMatchObject({
      color: '#c8553d',
      metalness: 0.1,
      roughness: 0.6,
      emissiveIntensity: 0,
      transmission: 0,
      ior: 1.5,
      uvScale: 100,
    });
  });
  it('multiplies by white / 1 once a map is ready, and values override the fallback', () => {
    const loaded = new Set<MapChannel>(['baseColor', 'roughness', 'metalness']);
    expect(
      surfacePlan({ baseColor: { texture: 'a' }, roughness: { texture: 'b' }, metalness: { texture: 'c' } }, FALLBACK, loaded),
    ).toMatchObject({ color: '#ffffff', roughness: 1, metalness: 1 });
    expect(
      surfacePlan({ baseColor: { value: '#112233', texture: 'a' }, roughness: { value: 0.4, texture: 'b' } }, FALLBACK, loaded),
    ).toMatchObject({ color: '#112233', roughness: 0.4 });
  });
  it('carries glass, coat, emission and normal scale', () => {
    const plan = surfacePlan(
      {
        transmission: { value: 1 },
        ior: 1.45,
        coat: { value: 0.5 },
        coatRoughness: 0.2,
        emission: { value: '#ff0000' },
        emissionStrength: 3,
        normal: { texture: 'n', normalScale: 0.5 },
        uvScale: 250,
      },
      FALLBACK,
      NONE,
    );
    expect(plan).toMatchObject({
      transmission: 1,
      ior: 1.45,
      clearcoat: 0.5,
      clearcoatRoughness: 0.2,
      emissive: '#ff0000',
      emissiveIntensity: 3,
      normalScale: 0.5,
      uvScale: 250,
    });
  });
  it('emission with only an unloaded texture stays off', () => {
    expect(surfacePlan({ emission: { texture: 'a' } }, FALLBACK, NONE).emissiveIntensity).toBe(0);
    expect(surfacePlan({ emission: { texture: 'a' } }, FALLBACK, new Set<MapChannel>(['emission']))).toMatchObject({
      emissive: '#ffffff',
      emissiveIntensity: 1,
    });
  });
});

describe('light model', () => {
  const point = { lightType: 'point', intensity: 100, lightColor: '#ffffff' } as const;
  it('converts power to candela per document unit squared (a mm document is 1e6 times brighter per unit)', () => {
    const metres = threeLightOf(point, 1);
    expect(metres.intensity).toBeCloseTo(100 / (4 * Math.PI), 6);
    expect(threeLightOf(point, 0.001).intensity).toBeCloseTo(metres.intensity * 1e6, 3);
  });
  it('maps a sun to the key-light scale, a spot cone to its half angle, an area light to radiance', () => {
    expect(threeLightOf({ ...point, lightType: 'sun', intensity: 3 }, 1).intensity).toBeCloseTo(1.8);
    const spot = threeLightOf({ ...point, lightType: 'spot', coneAngle: 1, blend: 0.25 }, 1);
    expect(spot.angle).toBeCloseTo(0.5);
    expect(spot.penumbra).toBe(0.25);
    const area = threeLightOf({ ...point, lightType: 'area', width: 2, height: 1 }, 1);
    expect(area.intensity).toBeCloseTo(100 / (Math.PI * 2), 6);
    expect(area).toMatchObject({ width: 2, height: 1 });
  });
  it('caps shadow casters at three, in document order, never area lights, none without shadows', () => {
    const lights = ['a', 'b', 'c', 'd'].map((id) => ({ id, castShadows: true, lightType: 'point' }));
    expect([...shadowCasterIds(lights, true)]).toEqual(['a', 'b', 'c']);
    expect(shadowCasterIds(lights, false).size).toBe(0);
    expect(shadowCasterIds([{ id: 'r', castShadows: true, lightType: 'area' }], true).size).toBe(0);
    expect([...shadowCasterIds([{ id: 'x', castShadows: false, lightType: 'spot' }, ...lights], true, 1)]).toEqual(['a']);
  });
  it('leaves the built-in key light alone without lights, dims it for others, replaces it for a sun', () => {
    expect(keyLightRule([])).toEqual({ keyScale: 1, keyShadows: true });
    expect(keyLightRule([{ lightType: 'point' }, { lightType: 'spot' }])).toEqual({ keyScale: 0.35, keyShadows: true });
    expect(keyLightRule([{ lightType: 'point' }, { lightType: 'sun' }])).toEqual({ keyScale: 0, keyShadows: false });
  });
  it('centres the sun shadow window on the scene and depth-ranges it around the scene sphere', () => {
    // Sun straight above the scene centre, aiming down (-Z already): window symmetric, scene 10 below.
    const f = sunShadowFrustum([0, 0, 10], [0, 0, 0], [0, 0, 0], 2);
    expect(f.left).toBeCloseTo(-2.1);
    expect(f.right).toBeCloseTo(2.1);
    expect(f.near).toBeCloseTo(10 - 2.1);
    expect(f.far).toBeCloseTo(10 + 2.1);
    // Scene centre one unit to the sun's local +X: the window shifts with it.
    const shifted = sunShadowFrustum([0, 0, 10], [0, 0, 0], [1, 0, 0], 2);
    expect(shifted.left).toBeCloseTo(1 - 2.1);
    expect(shifted.right).toBeCloseTo(1 + 2.1);
  });
  it('depth-ranges point / spot shadows and never gives a non-positive near', () => {
    const range = perspectiveShadowRange(10, 2);
    expect(range.far).toBeCloseTo(12.1);
    expect(range.near).toBeGreaterThan(0);
    expect(perspectiveShadowRange(0, 5).near).toBeGreaterThan(0);
  });
});

describe('glyph geometry', () => {
  const finite = (positions: readonly number[]): boolean => positions.length % 6 === 0 && positions.every(Number.isFinite);
  it('draws every light type as segment pairs; only the area rectangle is real size', () => {
    for (const lightType of ['sun', 'point', 'spot', 'area'] as const) {
      const glyph = lightGlyph({ lightType, coneAngle: 0.8, width: 4, height: 2 });
      expect(glyph.positions.length).toBeGreaterThan(0);
      expect(finite(glyph.positions)).toBe(true);
      expect(glyph.screenScaled).toBe(lightType !== 'area');
    }
    const area = lightGlyph({ lightType: 'area', width: 4, height: 2 }).positions;
    expect(Math.max(...area.filter((_, i) => i % 3 === 0))).toBeCloseTo(2);
    expect(Math.max(...area.filter((_, i) => i % 3 === 1))).toBeCloseTo(1);
  });
  it('keeps a spot cone inside the unit glyph for any cone angle', () => {
    for (const coneAngle of [0.1, 1, Math.PI / 2]) {
      const { positions } = lightGlyph({ lightType: 'spot', coneAngle });
      expect(Math.max(...positions.map(Math.abs))).toBeLessThanOrEqual(1.0001);
    }
  });
  it('shapes the camera frustum from the sensor aspect and focal length', () => {
    const camera = { focalLength: 35, sensorWidth: 36, sensorHeight: 24 };
    const { positions } = cameraGlyph(camera);
    expect(finite(positions)).toBe(true);
    // The far rectangle is the 4th ray end: x half = y half * aspect.
    const farCorner = [positions[3] ?? 0, positions[4] ?? 0];
    expect(Math.abs(farCorner[0] ?? 0) / Math.abs(farCorner[1] ?? 1)).toBeCloseTo(1.5);
    expect(Math.abs(farCorner[1] ?? 0)).toBeCloseTo(
      Math.tan(cameraVerticalFov(camera) / 2) * Math.min(1, 0.7 / Math.tan(cameraVerticalFov(camera) / 2)),
    );
    const wide = cameraGlyph({ ...camera, focalLength: 4 }).positions;
    expect(Math.max(...wide.map(Math.abs))).toBeLessThan(1.3);
  });
  it('gives the plan aim of an Euler pose, and null when it aims straight down', () => {
    expect(aimInPlan([0, 0, 0])).toBeNull();
    const east = aimInPlan([0, -Math.PI / 2, 0]);
    expect(east?.[0]).toBeCloseTo(1);
    expect(east?.[1]).toBeCloseTo(0);
    const north = aimInPlan([Math.PI / 2, 0, 0]);
    expect(north?.[1]).toBeCloseTo(1);
  });
  it('draws a top-view symbol per kind, with an aim tick except for a point light or a downward aim', () => {
    const down = { rotation: [0, 0, 0] } as const;
    const tilted = { rotation: [Math.PI / 2, 0, 0] } as const;
    const ring = planSymbol({ kind: 'light', ...down }, 'point').length;
    expect(planSymbol({ kind: 'light', ...tilted }, 'point')).toHaveLength(ring);
    expect(planSymbol({ kind: 'light', ...tilted }, 'spot').length).toBe(ring + 6);
    expect(planSymbol({ kind: 'light', ...down }, 'spot')).toHaveLength(ring);
    expect(planSymbol({ kind: 'light', ...down }, 'area').length).toBe(24);
    expect(planSymbol({ kind: 'camera', ...tilted }).length).toBe(30);
  });
});

describe('glyphInk', () => {
  it('pulls a pale colour toward dark on a light canvas and toward light on a dark one', () => {
    expect(glyphInk('#ffffff', '#eceef1')).toBe('#808080');
    expect(glyphInk('#000000', '#1b1d22')).toBe('#818181');
  });
  it('survives a malformed colour', () => {
    expect(glyphInk('red', '#eceef1')).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('lookThroughCamera', () => {
  const camera = { position: [10, 0, 5] as const, focusDistance: 4 };
  it('puts the orbit target focusDistance ahead along the aim', () => {
    // Aim along +X: rotation y = -pi/2 turns -Z to +X.
    const look = lookThroughCamera({ ...camera, position: [10, 0, 5], rotation: [0, -Math.PI / 2, 0] });
    expect(look.target[0]).toBeCloseTo(14);
    expect(look.target[1]).toBeCloseTo(0);
    expect(look.target[2]).toBeCloseTo(5);
    expect(look.distance).toBe(4);
    expect(look.polar).toBeCloseTo(Math.PI / 2);
    // Eye at target + d (sin a, cos a): the eye is at -X of the target: azimuth -pi/2.
    expect(look.azimuth).toBeCloseTo(-Math.PI / 2);
  });
  it('maps a downward aim to polar 0', () => {
    expect(lookThroughCamera({ ...camera, position: [0, 0, 5], rotation: [0, 0, 0] }).polar).toBeCloseTo(0);
  });
});

describe('environmentPlan', () => {
  it('is the palette background without an environment', () => {
    expect(environmentLook(undefined, '#eceef1')).toEqual({ background: '#eceef1', ambient: null });
    expect(skyTurbidity(undefined)).toBeUndefined();
  });
  it('colours the background and adds an ambient tint', () => {
    const env: SceneEnvironment = { source: 'color', color: '#102030', intensity: 2 };
    expect(environmentLook(env, '#eceef1')).toEqual({ background: '#102030', ambient: { color: '#102030', intensity: 0.6 } });
  });
  it('keeps the palette for sky and hdr; reads the sky turbidity; turns a Y-up map to Z-up', () => {
    const sky: SceneEnvironment = { source: 'sky', turbidity: 4, intensity: 1 };
    expect(environmentLook(sky, '#fff').background).toBe('#fff');
    expect(skyTurbidity(sky)).toBe(4);
    expect(skyTurbidity({ source: 'hdr', texture: 't', rotation: 0, intensity: 1 })).toBeUndefined();
    expect(hdrOrientation(0.5)).toEqual([Math.PI / 2, 0, 0.5]);
  });
});

describe('buildMeshSolidGeometry stored uvs / normals', () => {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const indices = [0, 1, 2];
  it('keeps stored uvs (flagged) and ignores a wrong-length array', () => {
    const stored = buildMeshSolidGeometry({ positions, indices, uvs: [0, 0, 1, 0, 0, 1] });
    expect(stored.userData['storedUvs']).toBe(true);
    expect(Array.from(stored.getAttribute('uv')?.array ?? [])).toEqual([0, 0, 1, 0, 0, 1]);
    const ignored = buildMeshSolidGeometry({ positions, indices, uvs: [0, 0] });
    expect(ignored.userData['storedUvs']).toBeUndefined();
    expect(ignored.getAttribute('uv')).toBeUndefined();
  });
  it('uses stored normals as authored and falls back to creased normals otherwise', () => {
    const smooth = buildMeshSolidGeometry({ positions, indices, normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] });
    expect(smooth.index).not.toBeNull();
    expect(Array.from(smooth.getAttribute('normal')?.array ?? [])).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const derived = buildMeshSolidGeometry({ positions, indices, normals: [0, 0, 1] });
    expect(derived.getAttribute('normal')?.count).toBe(3);
  });
});
