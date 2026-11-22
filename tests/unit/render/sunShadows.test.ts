import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { siteLightOf, sunShadowNote } from '@core/commands/render/siteLight';
import { prepareRasterScene } from '@core/commands/render/rasterScene';
import type { Camera, RenderLight } from '@core/commands/render/camera';
import {
  GROUND_CELLS,
  GROUND_COLOR,
  GROUND_OWNER,
  SHADOW_MAX_POLYGONS,
  buildShadowMap,
  fillBounds,
  groundCells,
  inShadow,
} from '@core/commands/render/sunShadows';
import type { Polygon3D } from '@core/commands/render/types';

const quad = (verts: Vec3[], normal: Vec3): Polygon3D => ({ verts, color: '#808080', normal, stroke: false, depth: 0, owner: 'box' });

/** The six faces of the axis-aligned box [0,2]^3 (outward normals). */
function boxFaces(): Polygon3D[] {
  return [
    quad(
      [
        [0, 0, 2],
        [2, 0, 2],
        [2, 2, 2],
        [0, 2, 2],
      ],
      [0, 0, 1],
    ),
    quad(
      [
        [0, 0, 0],
        [0, 2, 0],
        [2, 2, 0],
        [2, 0, 0],
      ],
      [0, 0, -1],
    ),
    quad(
      [
        [2, 0, 0],
        [2, 2, 0],
        [2, 2, 2],
        [2, 0, 2],
      ],
      [1, 0, 0],
    ),
    quad(
      [
        [0, 0, 0],
        [0, 0, 2],
        [0, 2, 2],
        [0, 2, 0],
      ],
      [-1, 0, 0],
    ),
    quad(
      [
        [0, 2, 0],
        [0, 2, 2],
        [2, 2, 2],
        [2, 2, 0],
      ],
      [0, 1, 0],
    ),
    quad(
      [
        [0, 0, 0],
        [2, 0, 0],
        [2, 0, 2],
        [0, 0, 2],
      ],
      [0, -1, 0],
    ),
  ];
}
const SUN45: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];

describe('shadow map', () => {
  it('shadows the ground where the box is, offset by height / tan(elevation) away from the sun', () => {
    const map = buildShadowMap(boxFaces(), SUN45)!;
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
  it('is deterministic and ignores strokes', () => {
    const faces = boxFaces();
    const a = buildShadowMap(faces, SUN45)!;
    const b = buildShadowMap(faces, SUN45)!;
    expect(a.depth.every((d, i) => Object.is(d, b.depth[i]))).toBe(true);
    const stroke: Polygon3D = { ...faces[0]!, stroke: true };
    expect(buildShadowMap([stroke], SUN45)).toBeNull();
    expect(buildShadowMap([], SUN45)).toBeNull();
    expect(fillBounds([stroke])).toBeNull();
  });
  it('handles a sun straight overhead and a face turned from the sun', () => {
    const map = buildShadowMap(boxFaces(), [0, 0, 1])!;
    expect(inShadow(map, [1, 1, 0], [0, 0, 1])).toBe(true);
    expect(inShadow(map, [5, 5, 0], [0, 0, 1])).toBe(false);
    expect(inShadow(map, [1, 1, 0], [0, 0, -1])).toBe(false);
  });
});

describe('ground cells', () => {
  it('is a GROUND_CELLS^2 grid at the given height with a stated margin, none for a flat scene or a bad height', () => {
    const cells = groundCells({ min: [0, 0, 0], max: [2, 2, 2] }, 0.5);
    expect(cells).toHaveLength(GROUND_CELLS * GROUND_CELLS);
    expect(cells.every((c) => c.color === GROUND_COLOR && c.owner === GROUND_OWNER && c.verts.every((v) => v[2] === 0.5))).toBe(true);
    const xs = cells.flatMap((c) => c.verts.map((v) => v[0]));
    expect(Math.min(...xs)).toBeCloseTo(-1);
    expect(Math.max(...xs)).toBeCloseTo(3);
    expect(groundCells({ min: [0, 0, 0], max: [0, 0, 2] }, 0)).toEqual([]);
    expect(groundCells({ min: [0, 0, 0], max: [2, 2, 2] }, Number.NaN)).toEqual([]);
  });
});

/** Distinct red levels of the faces of one owner. */
function levels(faces: Float64Array, owner: number): number[] {
  const found = new Set<number>();
  for (let i = 0; i < faces.length; i += 8) if (faces[i + 6] === owner) found.add(Math.round(faces[i] ?? 0));
  return [...found].sort((a, b) => a - b);
}
const camera: Camera = { position: [1, 1, 50], target: [1, 1, 0], up: [0, 1, 0] };
const prepare = (light?: RenderLight, polygons = boxFaces()): ReturnType<typeof prepareRasterScene> =>
  prepareRasterScene(polygons, camera, 8, 100, 100, 3, light);

describe('prepareRasterScene with sun shadows', () => {
  it('draws shadowed ground cells at the ambient level and lit ones at the Lambert level', () => {
    const scene = prepare({ direction: SUN45, shadows: { groundElevation: 0 } })!;
    // ground owner 0 (concrete #9a9a96, red 154): shadow = ambient 0.35 -> 53.9; lit = 0.35 + 0.65 * cos(45 deg) = 0.8096 -> 124.7
    expect(levels(scene.faces, 0)).toEqual([54, 125]);
  });
  it('has no shadow when the sun is below the horizon, only the ground plane', () => {
    const scene = prepare({ direction: null, shadows: { groundElevation: 0 } })!;
    expect(levels(scene.faces, 0)).toEqual([54]);
  });
  it('draws no ground without groundElevation and leaves an unshadowed face as it was', () => {
    const shadows = prepare({ direction: SUN45, shadows: { groundElevation: null } })!;
    expect(shadows.fills.length / 3).toBe(6);
    const plain = prepare({ direction: SUN45 })!;
    // the roof is lit and nothing shadows it
    expect(Array.from(shadows.faces.slice(0, 8))).toEqual(Array.from(plain.faces.slice(0, 8)));
  });
  it('is deterministic; without light.shadows the scene has no ground and is unchanged', () => {
    const a = prepare({ direction: SUN45, shadows: { groundElevation: 0 } })!;
    const b = prepare({ direction: SUN45, shadows: { groundElevation: 0 } })!;
    expect(Array.from(a.faces)).toEqual(Array.from(b.faces));
    expect(Array.from(a.points)).toEqual(Array.from(b.points));
    expect(a.fills.length / 3).toBe(6 + GROUND_CELLS * GROUND_CELLS);
    const x = prepare({ direction: SUN45 })!;
    expect(Array.from(x.faces)).toEqual(Array.from(prepare({ direction: SUN45 })!.faces));
    expect(x.fills.length / 3).toBe(6);
  });
  it('skips the shadow pass above the polygon limit', () => {
    const light = { direction: SUN45, shadows: { groundElevation: null } };
    const many = Array.from({ length: SHADOW_MAX_POLYGONS + 1 }, () => boxFaces()[0]!);
    const scene = prepareRasterScene(many, camera, 8, 20, 20, 3, light)!;
    expect(scene.fills.length / 3).toBe(SHADOW_MAX_POLYGONS + 1);
    expect(sunShadowNote(light, SHADOW_MAX_POLYGONS + 1, true)).toContain('skipped');
  });
});

const SITE = { latitudeDeg: 0, longitudeDeg: 0, northAngleDeg: 0 };
const boxDoc = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [0, 0, 1] }).document;
const withSite = (doc: CadDocument, dateTime: string, groundElevation?: number): CadDocument =>
  execute(doc, 'set_site_context', { ...SITE, dateTime, ...(groundElevation === undefined ? {} : { groundElevation }) }).document;
const render = (doc: CadDocument, params: Record<string, unknown> = {}): { svg: string; summary: string } => {
  const result = execute(doc, 'render_view', { view: 'iso', width: 160, height: 160, ...params });
  return { svg: (result.data as { svg: string }).svg, summary: result.summary };
};

describe('render_view with a site context', () => {
  it('renders bit-identically without a site context, whatever sunShadows says', () => {
    const a = render(boxDoc);
    expect(render(boxDoc, { sunShadows: true }).svg).toBe(a.svg);
    expect(a.summary).not.toContain('Sun shadows');
  });
  it('names the shadows and the ground plane, draws them, and is repeatable', () => {
    const morning = withSite(boxDoc, '2026-03-20T09:00:00Z', 0);
    const shadowed = render(morning);
    expect(shadowed.summary).toContain('Sun shadows: 1024x1024 shadow map');
    expect(shadowed.summary).toContain('Ground plane at z=0');
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
    expect(sunShadowNote(undefined, 1, true)).toBe('');
  });
});
