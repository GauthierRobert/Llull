import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { validateEntityValue } from '@core/commands/persistence/guards';
import { cptColour, parseCpt, type Cpt } from '@lib/cpt';
import { DEM2, terrainVertexColours } from '@aec/civil/surface/terrainPalette';
import { tessellateEntity } from '@core/commands/render/polygons';
import { civilErrors } from '@aec/civil/validate';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { surveyedDocument } from './fixtures';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';

const VENDORED = new URL('../../../docs/plant/09-plant-visualization-review/validation/data/gmt_cpt/dem2.cpt', import.meta.url);
const parsed = (): Cpt => {
  const result = parseCpt(readFileSync(VENDORED, 'utf8'));
  if (!result.ok) throw new Error(result.error);
  return result.cpt;
};

describe('CPT reader on the vendored GMT dem2.cpt', () => {
  it('reads 7 slices scaled from the normalised z to the RANGE 0-4900 m, with GMT B / F / N colours', () => {
    const cpt = parsed();
    expect(cpt.slices.map((slice) => slice.z0)).toEqual([
      0, 50, 500.000000002, 1200.000000002, 1699.999999999, 2800.000000002, 3999.999999999,
    ]);
    expect(cpt.slices[6]?.z1).toBe(4900);
    expect(cpt.background).toEqual([0, 0, 0]);
    expect(cpt.foreground).toEqual([255, 255, 255]);
    expect(cpt.nan).toEqual([128, 128, 128]);
  });
  it('the embedded DEM2 constant equals the parse of the vendored file', () => {
    expect(DEM2).toEqual(parsed());
  });
  it('colours at slice boundaries are the CPT values (a boundary belongs to the upper slice)', () => {
    const cpt = parsed();
    expect(cptColour(cpt, 0)).toEqual([0, 97, 71]);
    expect(cptColour(cpt, 50)).toEqual([16, 122, 47]);
    expect(cptColour(cpt, 500)).toEqual([232, 215, 125]);
    expect(cptColour(cpt, 1200)).toEqual([161, 67, 0]);
    expect(cptColour(cpt, 1700)).toEqual([100, 50, 25]);
    expect(cptColour(cpt, 2800)).toEqual([110, 109, 108]);
    expect(cptColour(cpt, 4000)).toEqual([255, 254, 253]);
    expect(cptColour(cpt, 4900)).toEqual([255, 254, 253]);
  });
  it('interpolates linearly in RGB: midpoints and quarter points against hand-read values', () => {
    const cpt = parsed();
    expect(cptColour(cpt, 10)).toEqual([3, 102, 66]); // 0/97/71 -> 16/122/47, t = 0.2
    expect(cptColour(cpt, 675)).toEqual([214, 178, 94]); // 232/215/125 -> 161/67/0, t = 0.25
    expect(cptColour(cpt, 1300)).toEqual([149, 64, 5]); // 161/67/0 -> 100/50/25, t = 0.2
  });
  it('uses B below, F above and N for NaN', () => {
    const cpt = parsed();
    expect(cptColour(cpt, -0.001)).toEqual([0, 0, 0]);
    expect(cptColour(cpt, 4900.5)).toEqual([255, 255, 255]);
    expect(cptColour(cpt, Number.NaN)).toEqual([128, 128, 128]);
  });
});

describe('parseCpt syntax and refusals', () => {
  it('reads r g b and gray slices, tabs, trailing annotation letters and comments, unscaled when there is no RANGE', () => {
    const result = parseCpt('# a comment\r\n0 0 0 0 10\t255 128 0 L\n10 gray 20 100\nB 1/2/3\nF 4 5 6\nN 7\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cpt.slices).toEqual([
      { z0: 0, rgb0: [0, 0, 0], z1: 10, rgb1: [255, 128, 0] },
      { z0: 10, rgb0: [128, 128, 128], z1: 20, rgb1: [100, 100, 100] },
    ]);
    expect(result.cpt.background).toEqual([1, 2, 3]);
    expect(result.cpt.foreground).toEqual([4, 5, 6]);
    expect(result.cpt.nan).toEqual([7, 7, 7]);
  });
  it('chooses gray or r g b by the token count', () => {
    const gray = parseCpt('0 0 10 255\n');
    expect(gray.ok && gray.cpt.slices).toEqual([{ z0: 0, rgb0: [0, 0, 0], z1: 10, rgb1: [255, 255, 255] }]);
    const rgb = parseCpt('0 0 0 0 10 255 255 255\n');
    expect(rgb.ok && rgb.cpt.slices).toEqual([{ z0: 0, rgb0: [0, 0, 0], z1: 10, rgb1: [255, 255, 255] }]);
    const mixed = parseCpt('0 5 10 1 2 3\n');
    expect(mixed.ok && mixed.cpt.slices).toEqual([{ z0: 0, rgb0: [5, 5, 5], z1: 10, rgb1: [1, 2, 3] }]);
    const annotated = parseCpt('0 0 10 255 L\n');
    expect(annotated.ok && annotated.cpt.slices[0]?.rgb1).toEqual([255, 255, 255]);
  });
  it('a normalised table without a RANGE stays normalised; with [R=a/b] in the title it scales', () => {
    const plain = parseCpt('0 0/0/0 1 255/255/255\n');
    expect(plain.ok && plain.cpt.slices[0]?.z1).toBe(1);
    const titled = parseCpt('# x [R=-10/10, C=RGB]\n0 0/0/0 1 255/255/255\n');
    expect(titled.ok && titled.cpt.slices[0]).toMatchObject({ z0: -10, z1: 10 });
  });
  it('a zero-width slice returns its first colour; an empty table has only N', () => {
    const result = parseCpt('5 10/20/30 5 40/50/60\n');
    expect(result.ok && cptColour(result.cpt, 5)).toEqual([10, 20, 30]);
    expect(cptColour({ slices: [], background: [0, 0, 0], foreground: [1, 1, 1], nan: [9, 9, 9] }, 1)).toEqual([9, 9, 9]);
  });
  it.each([
    ['HSV', '# COLOR_MODEL = HSV\n0 0/0/0 1 1/1/1\n', 'COLOR_MODEL'],
    ['HARD_HINGE', '# HARD_HINGE\n# RANGE = -10/10\n0 0/0/0 1 1/1/1\n', 'HARD_HINGE tables'],
    ['SOFT_HINGE on a table with real z', '# SOFT_HINGE\n-5 0/0/0 5 1/1/1\n', 'SOFT_HINGE tables'],
    ['z 1e309', '0 0/0/0 1e309 1/1/1\n', 'z value is not finite'],
    ['z NaN', 'NaN 0/0/0 1 1/1/1\n', 'line 1'],
    ['RANGE 1e309', '# RANGE = 0/1e309\n0 0/0/0 1 1/1/1\n', 'not finite'],
    ['RANGE NaN', '# RANGE = NaN/10\n0 0/0/0 1 1/1/1\n', 'not numeric'],
    ['no slices', '# only a comment\nB black\n', 'no colour slices'],
    ['colour names', '0 red 1 blue\n', 'line 1'],
    ['bad B', 'B nonsense\n0 0/0/0 1 1/1/1\n', 'unreadable B'],
    ['decreasing', '5 0/0/0 1 1/1/1\n', 'must not decrease'],
    ['overlap', '0 0/0/0 5 1/1/1\n3 0/0/0 6 1/1/1\n', 'must not decrease'],
    ['flat range', '# RANGE = 5/5\n0 0/0/0 1 1/1/1\n', 'RANGE must increase'],
  ])('refuses %s without throwing', (_name, text, error) => {
    const result = parseCpt(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(error);
  });
});

/** Surface z = 10 x over x in 0..100 m: heights 0..1000 m. */
const terrain = (): CadDocument => surveyedDocument((x) => x * 10);
const tin = (doc: CadDocument): MeshSolidEntity => doc.entities['surface-1:tin'] as MeshSolidEntity;
const vertexColour = (mesh: MeshSolidEntity, x: number): number[] | undefined => {
  for (let v = 0; v < mesh.mesh.positions.length / 3; v++)
    if (mesh.mesh.positions[v * 3] === x) return (mesh.vertexColors ?? []).slice(v * 3, v * 3 + 3);
  return undefined;
};

describe('set_civil_display terrainTint', () => {
  it('tints each TIN vertex by its height above the ground (absolute Z with no site)', () => {
    const doc = terrain();
    const result = execute(doc, 'set_civil_display', { terrainTint: 'dem2' });
    const mesh = tin(result.document);
    expect(result.summary).toContain('1 surface');
    expect(result.affected).toContain('surface-1');
    expect(mesh.vertexColors).toHaveLength(mesh.mesh.positions.length);
    expect(vertexColour(mesh, 0)).toEqual([0, 97, 71]);
    expect(vertexColour(mesh, 50)).toEqual([232, 215, 125]);
    expect(vertexColour(mesh, 100)).toEqual([181, 109, 36]); // 1000 m: 232/215/125 -> 161/67/0 at t = 5/7
    expect(result.document.civil?.terrainTint).toBe('dem2');
    expectPure(doc, () => execute(doc, 'set_civil_display', { terrainTint: 'dem2' }));
  });
  it('the render (vector) and the polygons use the mean of the three vertex colours', () => {
    const mesh = tin(execute(terrain(), 'set_civil_display', { terrainTint: 'dem2' }).document);
    const polygons = tessellateEntity(mesh);
    expect(polygons).toHaveLength(mesh.mesh.indices.length / 3);
    const first = [0, 1, 2].map((k) => mesh.mesh.indices[k] as number);
    const mean = [0, 1, 2].map((c) => Math.round(first.reduce((sum, v) => sum + (mesh.vertexColors?.[v * 3 + c] ?? 0), 0) / 3));
    expect(polygons[0]?.color).toBe(`#${mean.map((n) => n.toString(16).padStart(2, '0')).join('')}`);
    const svg = (doc: CadDocument, mode: 'raster' | 'vector' = 'vector'): string =>
      (execute(doc, 'render_view', { view: 'top', mode }).data as { svg: string }).svg;
    const tinted = execute(terrain(), 'set_civil_display', { terrainTint: 'dem2' }).document;
    const fills = (text: string): number => new Set([...text.matchAll(/<polygon [^>]*fill="([^"]+)"/g)].map((m) => m[1])).size;
    expect(fills(svg(tinted))).toBeGreaterThan(fills(svg(terrain())) + 3);
  });
  it('height is measured above siteContext.groundElevation and converted from document units, and follows later edits', () => {
    const base = execute(terrain(), 'set_civil_display', { terrainTint: 'dem2' }).document;
    const site = execute(base, 'set_site_context', {
      latitudeDeg: 48,
      longitudeDeg: 2,
      dateTime: '2026-06-21T12:00:00+02:00',
      groundElevation: 500,
    });
    expect(vertexColour(tin(site.document), 50)).toEqual([0, 97, 71]); // 500 m is now the ground
    expect(vertexColour(tin(site.document), 0)).toEqual([0, 0, 0]); // below the ground: GMT B colour
    expect(site.affected).toContain('surface-1:tin');
    const millimetres = terrainVertexColours([0, 0, 500_000], 'dem2', 0, 0.001);
    expect(millimetres).toEqual([232, 215, 125]);
  });
  it('a unit change re-derives the tint: the vertex at x = 100 m stays the colour of 304.8 m', () => {
    const tinted = execute(terrain(), 'set_civil_display', { terrainTint: 'dem2' }).document;
    const feet = execute(tinted, 'set_units', { units: 'ft' }).document;
    const top = Math.max(...(tin(feet).mesh.positions.filter((_, i) => i % 3 === 0) as number[]));
    expect(vertexColour(tin(feet), top)).toEqual(Array.from(cptColour(DEM2, 304.8)));
    expect(vertexColour(tin(feet), top)).not.toEqual(vertexColour(tin(tinted), 100));
    const fresh = execute(feet, 'set_civil_display', { terrainTint: 'none' }).document;
    expect(tin(fresh).vertexColors).toBeUndefined();
  });
  it('save and load re-derive the same tinted TIN', () => {
    const tinted = execute(terrain(), 'set_civil_display', { terrainTint: 'dem2' }).document;
    const loaded = deserializeDocument(serializeDocument(tinted));
    expect(tin(loaded)).toEqual(tin(tinted));
    expect(loaded.civil?.terrainTint).toBe('dem2');
  });
  it('is off unless chosen: a document that never opts in, or goes back to none, is bit-identical', () => {
    const plain = terrain();
    expect(tin(plain).vertexColors).toBeUndefined();
    expect(JSON.stringify(plain.civil)).not.toContain('terrainTint');
    const back = execute(execute(plain, 'set_civil_display', { terrainTint: 'dem2' }).document, 'set_civil_display', {
      terrainTint: 'none',
    }).document;
    expect(JSON.stringify(back.entities)).toBe(JSON.stringify(plain.entities));
    expect(JSON.stringify(back.order)).toBe(JSON.stringify(plain.order));
  });
  it('setting none on an untinted document, or the same tint twice, is a no-op', () => {
    const plain = terrain();
    const none = execute(plain, 'set_civil_display', { terrainTint: 'none' });
    expectNoOp(none, plain, 'already none');
    const tinted = execute(plain, 'set_civil_display', { terrainTint: 'dem2' }).document;
    expectNoOp(execute(tinted, 'set_civil_display', { terrainTint: 'dem2' }), tinted, 'already dem2');
  });
  it('rejects an unknown palette', () => {
    expect(execute(terrain(), 'set_civil_display', { terrainTint: 'etopo1' }).summary).toContain('rejected');
    expect(execute(createEmptyDocument(), 'set_civil_display', { terrainTint: 'dem2' }).document.civil?.terrainTint).toBe('dem2');
  });
  it('refuses a bad saved tint on load', () => {
    const saved = serializeDocument(execute(terrain(), 'set_civil_display', { terrainTint: 'dem2' }).document);
    expect(civilErrors({ objects: {}, order: [], counters: {}, terrainTint: 'etopo1' })).toEqual([
      'civil.terrainTint must be "none" or "dem2"',
    ]);
    expect(civilErrors({ objects: {}, order: [], counters: {}, terrainTint: 'none' })).toEqual([]);
    const parsedSave = JSON.parse(saved) as { document: { civil: { terrainTint: string } } };
    parsedSave.document.civil.terrainTint = 'etopo1';
    expect(() => deserializeDocument(JSON.stringify(parsedSave))).toThrow(/terrainTint/);
  });
  it('vertexColors validation: 3 bytes per vertex', () => {
    const mesh = tin(execute(terrain(), 'set_civil_display', { terrainTint: 'dem2' }).document);
    expect(validateEntityValue(mesh)).toBeNull();
    expect(validateEntityValue({ ...mesh, vertexColors: [1, 2, 3] })).toContain('vertexColors');
    expect(validateEntityValue({ ...mesh, vertexColors: mesh.vertexColors?.map(() => 300) })).toContain('vertexColors');
  });
});
