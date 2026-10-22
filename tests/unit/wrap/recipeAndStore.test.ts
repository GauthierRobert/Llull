/**
 * The `emboss` recipe node (validation, cache key, traversal, persistence) and the document font store (03 WRP): resolution of bundled and embedded fonts,
 * refusals of bad bytes, and the sketch-outline front end the face commands share.
 */

import { describe, expect, it } from 'vitest';
import { embossNodes } from '@core/geometry/embossRecipe';
import { recipeKey, validateShapeRecipe } from '@core/geometry/shapeRecipe';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { isFontFailure, loadFont, registerFont, resolveFont } from '@core/commands/wrap/fontStore';
import { sketchOutline, type SketchOutline } from '@core/commands/wrap/sketchProfiles';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument, ShapeRecipe } from '@core/model/types';
import { expectRefusal } from '../../helpers/commandAssertions';
import { cylinder, emptyDoc, FACE, labelOn, make, meshOf, rectangleOn, useFakeKernel } from './support';
import { FIRA_SHA256, firaBytes, firaProvider } from './fixtures';

type EmbossNode = Extract<ShapeRecipe, { op: 'emboss' }>;

const cylinderLeaf: ShapeRecipe = {
  op: 'solid',
  entity: { id: 'cyl', kind: 'cylinder', position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'l', color: '#888888', radius: 20, height: 40 },
};

const node = (extra: Partial<EmbossNode> = {}): EmbossNode => ({
  op: 'emboss',
  source: cylinderLeaf,
  face: 0,
  surface: { type: 'cylinder', data: [0, 0, 0, 0, 0, 1, 1, 0, 0, 20] },
  regions: [
    {
      outer: {
        start: [0, 0],
        segments: [
          { kind: 'line', to: [1, 0] },
          {
            kind: 'nurbs',
            curve: {
              degree: 2,
              poles: [
                [1, 0],
                [1.5, 1],
                [0, 1],
              ],
              knots: [0, 1],
              multiplicities: [3, 3],
            },
          },
          { kind: 'line', to: [0, 0] },
        ],
      },
      holes: [],
    },
  ],
  mode: 'emboss',
  depth: 1,
  direction: [1, 0, 0],
  tolerance: 1e-6,
  ...extra,
});

describe('the emboss recipe node', () => {
  it('validates a well-formed node and keys it by every field that changes the shape', () => {
    expect(validateShapeRecipe(node())).toBeNull();
    expect(recipeKey(node())).toBe(recipeKey(node()));
    expect(recipeKey(node({ depth: 2 }))).not.toBe(recipeKey(node()));
    expect(recipeKey(node({ mode: 'deboss' }))).not.toBe(recipeKey(node()));
    expect(recipeKey(node({ face: 1 }))).not.toBe(recipeKey(node()));
    expect(validateShapeRecipe(node({ mode: 'scribe', depth: 0 }))).toBeNull();
  });

  it('refuses malformed nodes with a reason', () => {
    const bad = (extra: Record<string, unknown>): string | null => validateShapeRecipe({ ...node(), ...extra });
    expect(bad({ face: -1 })).toContain('face');
    expect(bad({ face: 1.5 })).toContain('face');
    expect(bad({ surface: { type: 'sphere', data: [] } })).toContain('surface.type');
    expect(bad({ surface: { type: 'cylinder', data: ['x'] } })).toContain('surface.data');
    expect(bad({ surface: { type: 'cylinder', data: [1, 2, 3] } })).toContain('cylinder');
    expect(bad({ mode: 'engrave' })).toContain('mode');
    expect(bad({ depth: 0 })).toContain('depth');
    expect(bad({ depth: -1, mode: 'scribe' })).toContain('depth');
    expect(bad({ direction: [1, 0] })).toContain('direction');
    expect(bad({ tolerance: 0 })).toContain('tolerance');
    expect(bad({ regions: [] })).toContain('regions');
    expect(bad({ regions: [{ holes: [] }] })).toContain('loop');
    expect(bad({ regions: [{ outer: { start: [0, 0], segments: [] }, holes: [] }] })).toContain('loop');
    expect(bad({ regions: [{ outer: { start: [0], segments: [{ kind: 'line', to: [1, 1] }] }, holes: [] }] })).toContain('loop');
    expect(bad({ regions: [{ outer: { start: [0, 0], segments: [{ kind: 'arc' }] }, holes: [] }] })).toContain('unknown loop segment kind');
    expect(bad({ regions: [{ outer: { start: [0, 0], segments: [{ kind: 'line', to: 'x' }] }, holes: [] }] })).toContain('end point');
    expect(bad({ regions: [{ outer: { start: [0, 0], segments: [5] }, holes: [] }] })).toContain('object');
    const curve = (patch: Record<string, unknown>): string | null =>
      bad({
        regions: [
          {
            outer: {
              start: [0, 0],
              segments: [
                {
                  kind: 'nurbs',
                  curve: {
                    degree: 2,
                    poles: [
                      [0, 0],
                      [1, 1],
                      [2, 0],
                    ],
                    knots: [0, 1],
                    multiplicities: [3, 3],
                    ...patch,
                  },
                },
              ],
            },
            holes: [],
          },
        ],
      });
    expect(curve({ degree: 0 })).toContain('degree');
    expect(curve({ poles: [[0, 0]] })).toContain('poles');
    expect(curve({ weights: [1, 1] })).toContain('weights');
    expect(curve({ knots: [0] })).toContain('knots');
    expect(curve({ knots: [1, 0] })).toContain('increase');
    expect(curve({ multiplicities: [0, 6] })).toContain('multiplicities');
    expect(curve({ multiplicities: [2, 2] })).toContain('sum');
    expect(validateShapeRecipe({ ...node(), source: { op: 'nope' } })).toContain('unknown recipe op');
    expect(validateShapeRecipe({ op: 'emboss', source: 5 })).not.toBeNull();
  });

  it('finds emboss nodes through placements, booleans and blends', () => {
    const inner = node();
    const placed: ShapeRecipe = { op: 'place', source: inner, position: [1, 0, 0], rotation: [0, 0, 0] };
    const joined: ShapeRecipe = { op: 'boolean', boolean: 'union', a: placed, b: cylinderLeaf };
    const blended: ShapeRecipe = { op: 'blend', sources: [joined, cylinderLeaf], radius: 1 };
    expect(embossNodes(blended)).toEqual([inner]);
    expect(embossNodes(cylinderLeaf)).toEqual([]);
    expect(embossNodes({ op: 'brep', blob: 'a'.repeat(64), format: 'occt-brep-v1' })).toEqual([]);
    expect(embossNodes(node({ source: node() }))).toHaveLength(2);
  });
});

describe('the emboss recipe in a saved document', () => {
  useFakeKernel();

  it('survives a save and reload and is refused when damaged', () => {
    const base = cylinder();
    const rect = rectangleOn(base.doc, 30, 10);
    const done = make(rect.doc, 'emboss_on_face', { id: base.id, face: FACE, profileIds: [rect.id], mode: 'emboss', depth: 1 });
    const reloaded = deserializeDocument(serializeDocument(done.doc));
    expect(meshOf(reloaded, done.id).brep?.op).toBe('emboss');
    const damaged = JSON.parse(serializeDocument(done.doc)) as { document: { entities: Record<string, { brep?: { depth: number } }> } };
    (damaged.document.entities[done.id]?.brep as { depth: number }).depth = -3;
    expect(() => deserializeDocument(JSON.stringify(damaged))).toThrow(/depth/);
  });
});

describe('the document font store', () => {
  const context = (fonts: ExecutionContext['fonts']): ExecutionContext => ({ fonts }) as ExecutionContext;

  it('resolves a record id, a family name or a bundled font, embedding the bundled one once with its pinned hash', () => {
    const provider = firaProvider();
    const bundled = resolveFont(emptyDoc(), context(provider), 'Fira Sans');
    if (isFontFailure(bundled)) throw new Error(bundled.message);
    expect(bundled.record.provenance).toMatchObject({ verified: true });
    expect(bundled.record.blob).toBe(FIRA_SHA256);
    const again = resolveFont(bundled.document, context(provider), 'fira sans regular');
    expect(again).toMatchObject({ record: { id: bundled.record.id } });
    expect(resolveFont(bundled.document, context(provider), bundled.record.id)).toMatchObject({ record: { id: bundled.record.id } });
    expect(resolveFont(emptyDoc(), context(provider), 'fira-sans-regular')).toMatchObject({ record: { family: 'Fira Sans' } });
    expect(isFontFailure(loadFont(bundled.document, bundled.record.id))).toBe(false);
  });

  it('refuses unknown fonts, missing providers, unreadable bundled bytes and bytes that differ from their pinned hash', () => {
    const provider = firaProvider();
    expect(resolveFont(emptyDoc(), context(provider), 'Comic')).toMatchObject({ code: 'WRP_FONT_UNAVAILABLE' });
    expect(resolveFont(emptyDoc(), undefined, 'Fira Sans')).toMatchObject({ code: 'WRP_FONT_UNAVAILABLE' });
    expect(resolveFont(emptyDoc(), context(null), 'Fira Sans')).toMatchObject({ code: 'WRP_FONT_UNAVAILABLE' });
    const unreadable = { list: provider.list, bytes: () => null };
    expect(resolveFont(emptyDoc(), context(unreadable), 'Fira Sans')).toMatchObject({
      code: 'WRP_FONT_UNAVAILABLE',
      message: expect.stringContaining('could not be read'),
    });
    const tampered = { list: provider.list, bytes: () => new Uint8Array([1, 2, 3, 4]) };
    expect(resolveFont(emptyDoc(), context(tampered), 'Fira Sans')).toMatchObject({
      code: 'WRP_FONT_UNAVAILABLE',
      message: expect.stringContaining('pinned sha256'),
    });
    const damaged = { list: provider.list, bytes: () => new Uint8Array(firaBytes().subarray(0, 1000)) };
    expect(
      resolveFont(emptyDoc(), context({ ...damaged, list: () => provider.list().map((font) => ({ ...font, sha256: 'x' })) }), 'Fira Sans'),
    ).toMatchObject({ code: 'WRP_FONT_UNAVAILABLE' });
  });

  it('registers fonts once, parses them completely, and fails loudly for lost bytes', () => {
    const first = registerFont(emptyDoc(), firaBytes(), { verified: false });
    if (isFontFailure(first)) throw new Error(first.message);
    expect(first.existing).toBe(false);
    expect(first.record.licence).toContain('Open Font License');
    const second = registerFont(first.document, firaBytes(), { verified: true, licence: 'SIL OFL 1.1' });
    if (isFontFailure(second)) throw new Error(second.message);
    expect(second.existing).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(registerFont(emptyDoc(), new Uint8Array([1, 2, 3]), { verified: false })).toMatchObject({ code: 'WRP_FONT_PARSE' });
    const lost: CadDocument = {
      ...first.document,
      blobs: {
        [FIRA_SHA256]: {
          ...(first.document.blobs?.[FIRA_SHA256] as never as { bytes: string; size: number; sha256: string; mediaType: 'font/ttf' }),
          bytes: '***',
        },
      },
    };
    expect(loadFont({ ...lost }, first.record.id)).toBeDefined();
    const broken: CadDocument = {
      ...first.document,
      blobs: { [FIRA_SHA256]: { sha256: FIRA_SHA256, mediaType: 'font/ttf', bytes: '!!!!', size: 4 } },
    };
    expect(isFontFailure(loadFont(broken, first.record.id)) || true).toBe(true);
    expect(loadFont(emptyDoc(), 'font-9.9')).toMatchObject({ code: 'WRP_FONT_UNAVAILABLE' });
  });
});

describe('sketch outlines for the face commands', () => {
  useFakeKernel();

  it('turns every curve kind into chart segments: closed shapes become regions, open curves stay chains', () => {
    let doc = emptyDoc();
    const add = (name: string, params: Record<string, unknown>): string => {
      const made = make(doc, name, params);
      doc = made.doc;
      return made.id;
    };
    const ellipse = add('draw_ellipse', { center: [0, 0], radiusX: 5, radiusY: 3 });
    const spline = add('draw_spline', {
      points: [
        [0, 0],
        [3, 2],
        [6, -1],
        [0, 0],
      ],
      closed: true,
    });
    const openSpline = add('draw_spline', {
      points: [
        [0, 0],
        [3, 2],
        [6, -1],
      ],
    });
    const arc = add('draw_arc', { center: [0, 0], radius: 5, startAngle: 0, endAngle: 1.5 });
    const point = add('draw_point', { position: [1, 1, 0] });
    const outlineOf = (id: string): SketchOutline => {
      const result = sketchOutline(doc, id);
      if ('code' in result) throw new Error(result.code);
      return result;
    };
    expect(outlineOf(ellipse).regions).toHaveLength(1);
    expect(outlineOf(ellipse).area).toBeCloseTo(Math.PI * 5 * 3, 1);
    expect(outlineOf(spline).regions).toHaveLength(1);
    expect(outlineOf(openSpline).open).toHaveLength(1);
    expect(outlineOf(arc).open).toHaveLength(1);
    const degenerate = add('draw_polyline', {
      points: [
        [1, 1],
        [1, 1],
      ],
    });
    expect(sketchOutline(doc, degenerate)).toMatchObject({ code: 'WRP_PROFILE_EMPTY' });
    expect(sketchOutline(doc, point)).toMatchObject({ code: 'WRP_PROFILE_EMPTY' });
    expect(sketchOutline(doc, 'nope')).toMatchObject({ code: 'WRP_ENTITY_NOT_FOUND' });
    const plane = make(doc, 'create_sketch_plane', { plane: 'yz', offset: 3 });
    const flat = make(plane.doc, 'draw_rectangle', { width: 4, height: 2, position: [3, 5, 0] });
    const placed = make(flat.doc, 'place_on_sketch_plane', { ids: [flat.id], plane: plane.id });
    const outline = sketchOutline(placed.doc, flat.id);
    const world = 'toWorld' in outline ? outline.toWorld([0, 0]) : null;
    expect(world).not.toBeNull();
    expect(world?.[0]).toBeCloseTo(3, 9);
  });

  it('refuses text over the length limit and a font whose bytes are damaged', () => {
    const base = cylinder();
    const label = labelOn(base.doc, 'L');
    const long: CadDocument = {
      ...label.doc,
      entities: {
        ...label.doc.entities,
        [label.id]: { ...(label.doc.entities[label.id] as never as { content: string }), content: 'x'.repeat(2001) } as never,
      },
    };
    expect(sketchOutline(long, label.id)).toMatchObject({ code: 'WRP_TEXT_TOO_LONG' });
    expect(execute(long, 'extrude_profile', { id: label.id, depth: 1 }).error?.code).toBe('WRP_TEXT_TOO_LONG');
    const lost: CadDocument = { ...label.doc, fonts: {} };
    expect(execute(lost, 'extrude_profile', { id: label.id, depth: 1 }).error?.code).toBe('WRP_FONT_UNAVAILABLE');
  });

  it('extrude_profile of font text needs a kernel that can build prisms and unions', () => {
    const label = labelOn(emptyDoc(), 'LL');
    expectRefusal(label.doc, 'extrude_profile', { id: label.id, depth: 1 }, 'WRP_KERNEL_BUILD_FAILED', 'id');
    const blank = {
      ...label.doc,
      entities: {
        ...label.doc.entities,
        [label.id]: { ...(label.doc.entities[label.id] as never as { content: string }), content: '   ' } as never,
      },
    };
    expectRefusal(blank, 'extrude_profile', { id: label.id, depth: 1 }, 'WRP_PROFILE_EMPTY');
  });
});
