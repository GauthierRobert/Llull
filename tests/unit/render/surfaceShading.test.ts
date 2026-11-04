/** 09 VIS §5.6 / §12.17: material-class Blinn-Phong in the reference raster, the surface shading of a document, the rendererVersion bump. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { prepareRasterScene } from '@core/commands/render/rasterScene';
import { surfaceShadingOf } from '@core/commands/render/surfaceShading';
import { REFERENCE_RENDERER_VERSION } from '@core/commands/render/rendererProvenance';
import type { Camera } from '@core/commands/render/camera';
import type { Polygon3D, SurfaceShading } from '@core/commands/render/types';
import { apply } from '../../helpers/commandAssertions';
import { expectPure } from '../../helpers/expectNoOp';

const topCamera: Camera = { position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0] };
const face = (shading?: SurfaceShading, normal: [number, number, number] = [0, 0, 1]): Polygon3D => ({
  verts: [
    [-1, -1, 0],
    [1, -1, 0],
    [1, 1, 0],
    [-1, 1, 0],
  ],
  color: '#406080',
  normal,
  stroke: false,
  depth: 0,
  ...(shading === undefined ? {} : { shading }),
});
const faceColour = (polygon: Polygon3D, camera: Camera = topCamera): number[] => {
  const scene = prepareRasterScene([polygon], camera, 2, 40, 40, 2);
  return Array.from(scene?.faces.slice(0, 3) ?? []);
};

describe('reference raster Blinn-Phong', () => {
  it('leaves a face without a class exactly as before (flat Lambert)', () => {
    const [r, g, b] = faceColour(face());
    const factor = 0.35 + 0.65 * (1 / Math.sqrt(2));
    expect(r).toBeCloseTo(0x40 * factor, 9);
    expect(g).toBeCloseTo(0x60 * factor, 9);
    expect(b).toBeCloseTo(0x80 * factor, 9);
  });

  it('adds a highlight for a class, stronger for a metal, narrower for a smooth surface, never above 255', () => {
    const base = faceColour(face());
    const matte = faceColour(face({ metalness: 0, roughness: 1 }));
    const metal = faceColour(face({ metalness: 1, roughness: 1 }));
    const lessMetal = faceColour(face({ metalness: 0.2, roughness: 1 }));
    expect(matte[0]).toBeGreaterThan(base[0] ?? 0);
    expect(metal[0]).toBeGreaterThan(lessMetal[0] ?? 0);
    expect(faceColour(face({ metalness: 0, roughness: 0.2 }))[0]).not.toBe(faceColour(face({ metalness: 0, roughness: 0.9 }))[0]);
    for (const channel of metal) expect(channel).toBeLessThanOrEqual(255);
  });

  it('tints a metal highlight by the albedo and keeps a dielectric highlight white', () => {
    const base = faceColour(face());
    const gain = (shading: SurfaceShading): number[] => faceColour(face(shading)).map((c, k) => c - (base[k] ?? 0));
    const dielectric = gain({ metalness: 0, roughness: 0.2 });
    expect(dielectric[0]).toBeCloseTo(dielectric[2] ?? 0, 9);
    const metal = gain({ metalness: 1, roughness: 0.2 });
    expect(metal[2]).toBeGreaterThan(metal[0] ?? 0);
  });

  it('is bit-stable: the same input gives the same colour and one value is pinned', () => {
    const shading = { metalness: 0.7, roughness: 0.5 };
    expect(faceColour(face(shading))).toEqual(faceColour(face(shading)));
    expect(faceColour(face(shading)).map((c) => c.toFixed(6))).toEqual(['81.233936', '112.574319', '143.914702']);
  });

  it('survives a degenerate surface (roughness 0, out-of-range and non-finite values) without NaN', () => {
    for (const shading of [
      { metalness: 0, roughness: 0 },
      { metalness: 5, roughness: -3 },
      { metalness: Number.NaN, roughness: Number.NaN },
    ])
      for (const channel of faceColour(face(shading))) expect(Number.isNaN(channel)).toBe(false);
  });

  it('lights a back-facing normal like the front', () => {
    const shading = { metalness: 0.5, roughness: 0.4 };
    expect(faceColour(face(shading, [0, 0, -1]))).toEqual(faceColour(face(shading, [0, 0, 1])));
  });
});

function twoBoxes(): CadDocument {
  let doc = createEmptyDocument();
  for (const x of [0, 3000]) doc = apply(doc, 'add_box', { size: [1000, 1000, 1000], position: [x, 0, 500], color: '#808080' });
  return doc;
}
const [A, B] = twoBoxes().order as [string, string];
const withDefaults = (table: Record<string, string>): ExecutionContext => ({
  ...defaultContext(),
  properties: (_doc, id) => (Object.hasOwn(table, id) ? { defaultMaterialClass: table[id] ?? '' } : {}),
});

describe('surfaceShadingOf', () => {
  it('is undefined when no entity has a class (documents without classes render as before)', () => {
    expect(surfaceShadingOf(twoBoxes(), undefined)).toBeUndefined();
    expect(surfaceShadingOf(twoBoxes(), withDefaults({}))).toBeUndefined();
  });

  it('uses the assigned class, else the default a plugin names, and an assignment wins', () => {
    const assigned = apply(twoBoxes(), 'assign_material_class', { entityIds: [A], classId: 'concrete' });
    expect(surfaceShadingOf(assigned, undefined)?.get(A)).toEqual({ metalness: 0, roughness: 0.9 });
    expect(surfaceShadingOf(assigned, undefined)?.has(B)).toBe(false);
    const both = surfaceShadingOf(assigned, withDefaults({ [A]: 'concrete', [B]: 'grating' }));
    expect(both?.get(A)).toEqual({ metalness: 0, roughness: 0.9 });
    expect(both?.get(B)).toEqual({ metalness: 0.7, roughness: 0.5 });
  });

  it('honours a document override of the default class and ignores an unknown default class', () => {
    const doc = apply(twoBoxes(), 'define_material_class', { id: 'grating', colour: null, metalness: 0.2, roughness: 0.8 });
    expect(surfaceShadingOf(doc, withDefaults({ [A]: 'grating' }))?.get(A)).toEqual({ metalness: 0.2, roughness: 0.8 });
    expect(surfaceShadingOf(twoBoxes(), withDefaults({ [A]: 'no_such_class' }))).toBeUndefined();
  });

  it('skips 2D shapes and unknown order ids and does not modify the document', () => {
    const doc = apply(twoBoxes(), 'draw_polyline', {
      points: [
        [0, 0],
        [5, 5],
      ],
    });
    const line = doc.order[doc.order.length - 1] as string;
    const ghost: CadDocument = { ...doc, order: [...doc.order, 'ghost'] };
    const shading = surfaceShadingOf(ghost, withDefaults({ [line]: 'grating', ghost: 'grating', [A]: 'grating' }));
    expect(shading?.has(line)).toBe(false);
    expect(shading?.has('ghost')).toBe(false);
    expect(shading?.has(A)).toBe(true);
    expectPure(ghost, () => surfaceShadingOf(ghost, undefined));
  });
});

describe('render_view with material classes', () => {
  const image = (doc: CadDocument, ctx: ExecutionContext = defaultContext()): { rendererVersion: string; svgSha256: string } =>
    execute(doc, 'render_view', { view: 'iso', width: 200, height: 150 }, ctx).data as never;

  it('reports the bumped rendererVersion', () => {
    expect(REFERENCE_RENDERER_VERSION).toBe('llull-ts-raster/2');
    expect(image(twoBoxes()).rendererVersion).toBe('llull-ts-raster/2');
  });

  it('draws a highlight for a default class and an explicit assignment overrides the default', () => {
    const plain = image(twoBoxes(), withDefaults({})).svgSha256;
    const defaulted = image(twoBoxes(), withDefaults({ [A]: 'concrete' })).svgSha256;
    expect(defaulted).not.toBe(plain);
    const sheen = apply(
      apply(twoBoxes(), 'define_material_class', { id: 'sheen', colour: null, metalness: 1, roughness: 1 }),
      'assign_material_class',
      { entityIds: [A], classId: 'sheen' },
    );
    expect(image(sheen, withDefaults({ [A]: 'concrete' })).svgSha256).toBe(image(sheen, withDefaults({})).svgSha256);
    expect(image(sheen, withDefaults({})).svgSha256).not.toBe(defaulted);
  });

  it('is deterministic and leaves a document without any class unchanged by the default rule', () => {
    expect(image(twoBoxes()).svgSha256).toBe(image(twoBoxes()).svgSha256);
    expect(image(twoBoxes(), withDefaults({})).svgSha256).toBe(image(twoBoxes()).svgSha256);
  });
});
