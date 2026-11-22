import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { siteLightOf, sunShadowNote } from '@core/commands/render/siteLight';
import { prepareRasterScene } from '@core/commands/render/rasterScene';
import { rasterScenePixels } from '@core/commands/render/raster';
import { renderCameraRgba } from '@core/commands/render/frames';
import type { Camera, RenderLight } from '@core/commands/render/camera';
import type { ShadowMap } from '@core/commands/render/shadowTypes';
import {
  GROUND_COLOR,
  GROUND_DROP,
  GROUND_OWNER,
  SHADOW_MAX_WORK,
  fillBounds,
  groundPlane,
  planShadows,
  withSunPlan,
} from '@core/commands/render/sunShadows';
import { PIECE_TEXELS, inShadow, shadowPieces } from '@core/commands/render/shadowReceivers';
import type { Polygon3D } from '@core/commands/render/types';

const face = (verts: Vec3[], normal: Vec3, owner: string, color = '#808080'): Polygon3D => ({
  verts,
  color,
  normal,
  stroke: false,
  depth: 0,
  owner,
});

/** The six faces of the axis-aligned box [x0,x1] x [y0,y1] x [z0,z1] (outward normals). */
function boxAt(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, owner: string, color = '#808080'): Polygon3D[] {
  const f = (verts: Vec3[], normal: Vec3): Polygon3D => face(verts, normal, owner, color);
  return [
    f(
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      [0, 0, 1],
    ),
    f(
      [
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
      ],
      [0, 0, -1],
    ),
    f(
      [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
      [1, 0, 0],
    ),
    f(
      [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
      [-1, 0, 0],
    ),
    f(
      [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
      [0, 1, 0],
    ),
    f(
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
      [0, -1, 0],
    ),
  ];
}
const boxFaces = (): Polygon3D[] => boxAt(0, 0, 0, 2, 2, 2, 'box');
const SUN45: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];
const mapOf = (polygons: Polygon3D[], toSun: Vec3): ShadowMap => {
  const plan = planShadows(polygons, toSun);
  if (plan.kind !== 'map') throw new Error(`no shadow map: ${plan.kind}`);
  return plan.map;
};

describe('shadow map', () => {
  it('shadows the ground where the box is, offset by height / tan(elevation) away from the sun', () => {
    const map = mapOf(boxFaces(), SUN45);
    const ground: Vec3 = [0, 0, 1];
    // height 2, elevation 45 deg: the roof's shadow lands 2 / tan(45) = 2 units toward -x, so the shadow spans x in [-2, 2], y in [0, 2]
    const probe = (x: number, y: number): boolean => inShadow(map, [x, y, 0], ground);
    for (const x of [-1.9, -1.5, -1, -0.5, -0.1]) expect(probe(x, 1)).toBe(true);
    expect(probe(-2.2, 1)).toBe(false);
    expect(probe(-1, 2.3)).toBe(false);
    expect(probe(-1, -0.3)).toBe(false);
    expect(probe(2.5, 1)).toBe(false);
    // the sun-facing wall x = 2 and the roof are lit: the box does not shadow itself
    expect(inShadow(map, [2, 1, 1], [1, 0, 0])).toBe(false);
    expect(inShadow(map, [1, 1, 2], [0, 0, 1])).toBe(false);
  });
  it('is deterministic, reuses the last map for identical input and ignores strokes', () => {
    const faces = boxFaces();
    const a = mapOf(faces, SUN45);
    expect(mapOf(faces, SUN45)).toBe(a);
    const copy = mapOf(boxFaces(), SUN45);
    expect(copy).toBe(a);
    const other = mapOf(faces, [0, 0, 1]);
    expect(other).not.toBe(a);
    // a fresh map of the same input is texel-for-texel identical (the memo holds only the last plan)
    const again = mapOf(faces, SUN45);
    expect(again.depth.every((d, i) => Object.is(d, a.depth[i]))).toBe(true);
    const stroke: Polygon3D = { ...faces[0]!, stroke: true };
    expect(planShadows([stroke], SUN45).kind).toBe('empty');
    expect(planShadows([], SUN45).kind).toBe('empty');
    expect(fillBounds([stroke])).toBeNull();
  });
  it('handles a sun straight overhead, a face turned from the sun and a receiver on the max edge', () => {
    const map = mapOf(boxFaces(), [0, 0, 1]);
    expect(inShadow(map, [1, 1, 0], [0, 0, 1])).toBe(true);
    expect(inShadow(map, [5, 5, 0], [0, 0, 1])).toBe(false);
    expect(inShadow(map, [1, 1, 0], [0, 0, -1])).toBe(false);
    // x = 2 is the max edge of the map in u: it belongs to the last texel, not outside
    expect(inShadow(map, [2, 1, 0], [0, 0, 1])).toBe(true);
  });
  it('costs texels covered plus rows, so a thin diagonal triangle is cheap', () => {
    const thin = face(
      [
        [0, 0, 0],
        [20, 20, 0],
        [20.05, 20, 0],
      ],
      [0, 0, 1],
      'thin',
    );
    const plan = planShadows([thin], [0, 0, 1]);
    expect(plan.kind).toBe('map');
    expect(plan.work).toBeLessThan(5000);
    const roof = face(
      [
        [0, 0, 5],
        [20, 0, 5],
        [20, 20, 5],
        [0, 20, 5],
      ],
      [0, 0, 1],
      'roof',
    );
    expect(planShadows([roof], [0, 0, 1]).work).toBeGreaterThan(1024 * 1024 - 5000);
  });
  it('skips the pass above the work limit and reports it', () => {
    const roof = face(
      [
        [0, 0, 5],
        [20, 0, 5],
        [20, 20, 5],
        [0, 20, 5],
      ],
      [0, 0, 1],
      'roof',
    );
    const floor = face(
      [
        [0, 0, 0],
        [20, 0, 0],
        [20, 20, 0],
        [0, 20, 0],
      ],
      [0, 0, 1],
      'floor',
    );
    const light: RenderLight = { direction: [0, 0, 1], shadows: { groundElevation: null } };
    const few = withSunPlan(light, [roof, floor]);
    expect(few.report?.state).toBe('drawn');
    const many = withSunPlan(light, [...Array.from({ length: 200 }, () => roof), floor]);
    expect(many.report?.state).toBe('skipped');
    expect(many.report?.work).toBeGreaterThan(SHADOW_MAX_WORK);
    expect(withSunPlan({ direction: null, shadows: { groundElevation: null } }, [roof]).report).toBeUndefined();
    expect(withSunPlan({ direction: [0, 0, 1] }, [roof]).report).toBeUndefined();
    expect(sunShadowNote(light, many.report, true)).toContain('skipped');
    expect(sunShadowNote(light, few.report, true)).toContain('pieces of at most 8 texels');
  });
});

describe('receiver pieces', () => {
  it('splits a large face so only the part under a small caster is shadowed', () => {
    const slab = face(
      [
        [0, 0, 0],
        [20, 0, 0],
        [20, 20, 0],
        [0, 20, 0],
      ],
      [0, 0, 1],
      'slab',
    );
    const map = mapOf([slab, ...boxAt(9.7, 9.7, 3, 10.3, 10.3, 3.6, 'small')], [0, 0, 1]);
    const pieces = shadowPieces(map, slab.verts, [0, 0, 1]);
    const dark = pieces.filter((p) => p.shadowed);
    expect(pieces.length).toBeGreaterThan(100);
    expect(dark.length).toBeGreaterThan(0);
    // the shadow of the 0.6 x 0.6 caster is 0.36 m2 of 400 m2: the dark pieces stay near that (within the piece quantisation)
    const area = (verts: readonly Vec3[]): number =>
      Math.abs(
        (verts[1]![0] - verts[0]![0]) * (verts[2]![1] - verts[0]![1]) - (verts[2]![0] - verts[0]![0]) * (verts[1]![1] - verts[0]![1]),
      ) / 2;
    const shadowArea = dark.reduce((sum, p) => sum + area(p.verts), 0);
    expect(shadowArea).toBeGreaterThan(0.2);
    expect(shadowArea).toBeLessThan(1.5);
    for (const p of dark) {
      const x = p.verts.reduce((s, v) => s + v[0], 0) / p.verts.length;
      const y = p.verts.reduce((s, v) => s + v[1], 0) / p.verts.length;
      expect(Math.abs(x - 10)).toBeLessThan(0.6);
      expect(Math.abs(y - 10)).toBeLessThan(0.6);
    }
    // a face away from the map is one lit piece with its own vertices; a small face stays whole
    expect(
      shadowPieces(
        map,
        [
          [100, 100, 0],
          [101, 100, 0],
          [101, 101, 0],
        ],
        [0, 0, 1],
      ),
    ).toEqual([
      {
        verts: [
          [100, 100, 0],
          [101, 100, 0],
          [101, 101, 0],
        ],
        shadowed: false,
      },
    ]);
    expect(PIECE_TEXELS).toBe(8);
    const tiny = shadowPieces(
      map,
      [
        [9.9, 9.9, 0],
        [10.0, 9.9, 0],
        [10.0, 10.0, 0],
      ],
      [0, 0, 1],
    );
    expect(tiny).toHaveLength(1);
    expect(tiny[0]!.shadowed).toBe(true);
  });
});

describe('ground plane', () => {
  it('is one quad below the stated level with a stated margin, none for a flat scene or a bad height', () => {
    const plane = groundPlane({ min: [0, 0, 0], max: [2, 2, 2] }, 0.5, 0.01)!;
    expect(plane.color).toBe(GROUND_COLOR);
    expect(plane.owner).toBe(GROUND_OWNER);
    expect(plane.verts.every((v) => v[2] === 0.49)).toBe(true);
    expect(Math.min(...plane.verts.map((v) => v[0]))).toBeCloseTo(-1);
    expect(Math.max(...plane.verts.map((v) => v[0]))).toBeCloseTo(3);
    expect(groundPlane({ min: [0, 0, 0], max: [0, 0, 2] }, 0, 0)).toBeNull();
    expect(groundPlane({ min: [0, 0, 0], max: [2, 2, 2] }, Number.NaN, 0)).toBeNull();
  });
});

/** Distinct red levels and the number of faces of one owner. */
function levels(faces: Float64Array, owner: number): { levels: number[]; count: number } {
  const found = new Set<number>();
  let count = 0;
  for (let i = 0; i < faces.length; i += 8)
    if (faces[i + 6] === owner) {
      found.add(Math.round(faces[i] ?? 0));
      count += 1;
    }
  return { levels: [...found].sort((a, b) => a - b), count };
}
const camera: Camera = { position: [1, 1, 50], target: [1, 1, 0], up: [0, 1, 0] };
const prepare = (light?: RenderLight, polygons = boxFaces()): ReturnType<typeof prepareRasterScene> =>
  prepareRasterScene(polygons, camera, 8, 100, 100, 3, light);

describe('prepareRasterScene with sun shadows', () => {
  it('draws shadowed ground at the ambient level and lit ground at the Lambert level', () => {
    const scene = prepare({ direction: SUN45, shadows: { groundElevation: 0 } })!;
    // ground owner 0 (concrete #9a9a96, red 154): shadow = ambient 0.35 -> 53.9; lit = 0.35 + 0.65 * cos(45 deg) = 0.8096 -> 124.7
    expect(levels(scene.faces, 0).levels).toEqual([54, 125]);
  });
  it('has no shadow when the sun is below the horizon, only the ground plane', () => {
    const scene = prepare({ direction: null, shadows: { groundElevation: 0 } })!;
    expect(levels(scene.faces, 0).levels).toEqual([54]);
  });
  it('draws no ground without groundElevation and leaves an unshadowed face as it was', () => {
    const shadows = prepare({ direction: SUN45, shadows: { groundElevation: null } })!;
    // sun overhead: every face is one piece (the roof faces the sun and nothing is above it, the walls are turned from it)
    expect(prepare({ direction: [0, 0, 1], shadows: { groundElevation: null } })!.fills.length / 3).toBe(6);
    const plain = prepare({ direction: SUN45 })!;
    expect(Array.from(shadows.faces.slice(0, 8))).toEqual(Array.from(plain.faces.slice(0, 8)));
  });
  it('is deterministic; without light.shadows the scene has no ground and is unchanged', () => {
    const light = { direction: SUN45, shadows: { groundElevation: 0 } };
    const a = prepare(light)!;
    const b = prepare(light)!;
    expect(Array.from(a.faces)).toEqual(Array.from(b.faces));
    expect(Array.from(a.points)).toEqual(Array.from(b.points));
    const x = prepare({ direction: SUN45 })!;
    expect(Array.from(x.faces)).toEqual(Array.from(prepare({ direction: SUN45 })!.faces));
    expect(x.fills.length / 3).toBe(6);
  });
  it('one entity shadows another: only the pieces under the small box darken on the large slab', () => {
    const slab = face(
      [
        [0, 0, 0],
        [20, 0, 0],
        [20, 20, 0],
        [0, 20, 0],
      ],
      [0, 0, 1],
      'slab',
    );
    const scene = prepareRasterScene([slab, ...boxAt(9.7, 9.7, 3, 10.3, 10.3, 3.6, 'small')], camera, 25, 100, 100, 15, {
      direction: [0, 0, 1],
      shadows: { groundElevation: null },
    })!;
    const onSlab = levels(scene.faces, 0);
    expect(onSlab.levels).toHaveLength(2);
    let dark = 0;
    for (let i = 0; i < scene.faces.length; i += 8)
      if (scene.faces[i + 6] === 0 && Math.round(scene.faces[i] ?? 0) === onSlab.levels[0]) dark += 1;
    expect(dark).toBeGreaterThan(0);
    // the slab stays a few large lit pieces; about 4 x 4 small pieces (8 texels of 0.02 m) carry the 0.6 m shadow
    expect(dark).toBeLessThan(100);
    expect(onSlab.count).toBeLessThan(2000);
  });
  it('a model face at the ground level keeps every pixel (the plane sits just below it)', () => {
    const slab = boxAt(0, 0, -0.3, 10, 10, 0, 'slab', '#ff0000');
    const eye: Camera = { position: [5, 5, 50], target: [5, 5, 0], up: [0, 1, 0] };
    const light: RenderLight = { direction: [0.3, -0.2, 1], shadows: { groundElevation: 0 } };
    const scene = prepareRasterScene(slab, eye, 8, 100, 100, 8, light)!;
    const pixels = rasterScenePixels(scene);
    for (let y = 35; y < 65; y += 1)
      for (let x = 35; x < 65; x += 1) {
        const i = (y * 100 + x) * 4;
        expect(pixels[i + 1]).toBeLessThan(5);
        expect(pixels[i]).toBeGreaterThan(10);
      }
    const ground = prepareRasterScene(slab, eye, 8, 100, 100, 8, light)!;
    expect(ground.fills.length / 3).toBeGreaterThan(6);
    expect(GROUND_DROP).toBeGreaterThan(0);
  });
});

const SITE = { latitudeDeg: 0, longitudeDeg: 0, northAngleDeg: 0 };
const boxDoc = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [0, 0, 1] }).document;
const withSite = (doc: CadDocument, dateTime: string, groundElevation?: number): CadDocument =>
  execute(doc, 'set_site_context', { ...SITE, dateTime, ...(groundElevation === undefined ? {} : { groundElevation }) }).document;
const render = (
  doc: CadDocument,
  params: Record<string, unknown> = {},
): { svg: string; summary: string; data: Record<string, unknown> } => {
  const result = execute(doc, 'render_view', { view: 'iso', width: 160, height: 160, ...params });
  const data = result.data as { svg: string } & Record<string, unknown>;
  return { svg: data.svg, summary: result.summary, data };
};

describe('render_view with a site context', () => {
  it('renders bit-identically without a site context, whatever sunShadows says', () => {
    const a = render(boxDoc);
    expect(render(boxDoc, { sunShadows: true }).svg).toBe(a.svg);
    expect(a.summary).not.toContain('Sun shadows');
    expect(a.data.sunShadows).toBeUndefined();
  });
  it('names the shadows and the ground plane, draws them, reports the pass and is repeatable', () => {
    const morning = withSite(boxDoc, '2026-03-20T09:00:00Z', 0);
    const shadowed = render(morning);
    expect(shadowed.summary).toContain('Sun shadows: 1024x1024 shadow map');
    expect(shadowed.summary).toContain('Ground plane at z=0');
    expect((shadowed.data.sunShadows as { state: string }).state).toBe('drawn');
    const off = render(morning, { sunShadows: false });
    expect(off.summary).not.toContain('Sun shadows');
    expect(off.svg).not.toBe(shadowed.svg);
    expect(render(morning).svg).toBe(shadowed.svg);
  });
  it('has no shadows at night but still the ground plane', () => {
    const night = render(withSite(boxDoc, '2026-03-20T00:00:00Z', 0));
    expect(night.summary).toContain('No sun shadows (sun below the horizon)');
    expect(night.summary).toContain('Ground plane');
  });
  it('without groundElevation the shadows fall on geometry only and no plane is named', () => {
    const r = render(withSite(boxDoc, '2026-03-20T09:00:00Z'));
    expect(r.summary).toContain('Sun shadows');
    expect(r.summary).not.toContain('Ground plane');
  });
  it('says vector mode does not draw them', () => {
    expect(render(withSite(boxDoc, '2026-03-20T09:00:00Z', 0), { mode: 'vector' }).summary).toContain('raster mode only');
  });
  it('siteLightOf carries the ground elevation', () => {
    expect(siteLightOf(withSite(boxDoc, '2026-03-20T09:00:00Z', 2))?.light.shadows).toEqual({ groundElevation: 2 });
    expect(sunShadowNote(undefined, undefined, true)).toBe('');
  });
});

describe('walkthrough / animation frames (renderCameraRgba)', () => {
  const down = { projection: 'perspective', eye: [0, 0, 14], direction: [0, 0, -1], up: [0, 1, 0], fovDeg: 60 } as const;
  const frame = (doc: CadDocument, extras = {}): Uint8Array =>
    renderCameraRgba(doc, down, 80, 80, [0, 0, 0], [0, 0, 0], rasterScenePixels, extras);
  /** Pixels at the ambient level of the concrete ground (the shadow level, about 54). */
  const shadowPixels = (rgba: Uint8Array): number => {
    let n = 0;
    for (let i = 0; i < rgba.length; i += 4) if (Math.abs((rgba[i] ?? 0) - 54) <= 2 && Math.abs((rgba[i + 1] ?? 0) - 54) <= 2) n += 1;
    return n;
  };
  it('draws the sun shadow on the ground plane, and only with a ground elevation', () => {
    const morning = '2026-03-20T09:00:00Z';
    expect(shadowPixels(frame(withSite(boxDoc, morning, 0)))).toBeGreaterThan(10);
    expect(shadowPixels(frame(withSite(boxDoc, morning)))).toBe(0);
  });
  it('fits the ground plane to the given static bounds instead of the frame', () => {
    const doc = withSite(boxDoc, '2026-03-20T09:00:00Z', 0);
    const wide = frame(doc, { groundBounds: { min: [-30, -30, 0], max: [30, 30, 2] } });
    expect(wide).not.toEqual(frame(doc));
  });
});
