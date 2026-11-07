import { describe, it, expect } from 'vitest';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { regionHatchLines } from '@core/geometry/region';
import { tessellateEntity } from '@core/commands/render/polygons';
import type { RegionEntity } from '@core/model/types';

/** 100 x 60 plate with a hole of diameter 20 centred in it, hatched with `params`. */
function hatched(params: object): { doc: CadDocument; region: RegionEntity } {
  let doc = createEmptyDocument();
  doc = execute(doc, 'draw_rectangle', { width: 100, height: 60 }).document;
  doc = execute(doc, 'draw_ellipse', { center: [50, 30], radiusX: 10, radiusY: 10 }).document;
  const result = execute(doc, 'hatch_region', { ids: [...doc.order], ...params });
  return { doc: result.document, region: result.document.entities[result.affected[0] as string] as RegionEntity };
}

const dxfOf = (doc: CadDocument): { dxf: string; layers: string[] } =>
  execute(doc, 'export_building_dxf', {}).data as { dxf: string; layers: string[] };

/** Entity names of an R12 file in order (group code 0 values after ENTITIES). */
const entityNames = (dxf: string): string[] => {
  const lines = dxf.split('\n');
  const start = lines.indexOf('ENTITIES');
  return lines.flatMap((line, index) => (index > start && lines[index - 1] === '0' && line !== 'ENDSEC' && line !== 'EOF' ? [line] : []));
};

describe('region in DXF export (R12: no HATCH entity)', () => {
  it('writes every loop as a closed polyline and the pattern lines on the -PATT layer', () => {
    const { doc, region } = hatched({ angle: 0, spacing: 10 });
    const { dxf, layers } = dxfOf(doc);
    expect(layers).toContain('Layer_0-PATT');
    const names = entityNames(dxf);
    const lines = regionHatchLines(region).length;
    expect(lines).toBeGreaterThan(5);
    // 2 source shapes (rectangle polyline + ellipse polyline) + 2 region loops; one LINE per pattern line
    expect(names.filter((name) => name === 'POLYLINE')).toHaveLength(4);
    expect(names.filter((name) => name === 'LINE')).toHaveLength(lines);
  });

  it('a solid hatch is SOLID triangles on the pattern layer, none for pattern none', () => {
    expect(entityNames(dxfOf(hatched({ pattern: 'solid' }).doc).dxf).filter((name) => name === 'SOLID').length).toBeGreaterThan(10);
    const none = entityNames(dxfOf(hatched({ pattern: 'none' }).doc).dxf);
    expect(none).not.toContain('LINE');
    expect(none).not.toContain('SOLID');
  });

  it('applies the entity position', () => {
    const { doc, region } = hatched({ pattern: 'none' });
    const moved = { ...doc, entities: { ...doc.entities, [region.id]: { ...region, position: [1000, 0, 0] as const } } } as CadDocument;
    const x = dxfOf(moved).dxf.split('\n');
    expect(x.some((line) => Number(line) >= 1000)).toBe(true);
  });
});

describe('region in render_view (SVG)', () => {
  it('draws loop outlines and hatch lines as strokes; a solid hatch adds filled triangles', () => {
    const { region } = hatched({ angle: 0, spacing: 10 });
    const strokes = tessellateEntity(region);
    expect(strokes.every((polygon) => polygon.stroke)).toBe(true);
    expect(strokes).toHaveLength(2 + regionHatchLines(region).length);
    const solid = tessellateEntity({ ...region, hatch: { pattern: 'solid', angle: 0, spacing: 10 } });
    expect(solid.filter((polygon) => !polygon.stroke).length).toBeGreaterThan(10);
    expect(solid.filter((polygon) => polygon.stroke)).toHaveLength(2);
  });

  it('render_view top view and labels include the region', () => {
    const { doc, region } = hatched({});
    const view = execute(doc, 'render_view', { view: 'top', showLabels: true });
    const data = view.data as { svg: string; visibleEntityIds: string[] };
    expect(data.visibleEntityIds).toContain(region.id);
    expect(data.svg).toContain('<polyline');
    expect(data.svg).toContain(region.id);
  });
});

describe('region in code export', () => {
  it('is 2D drafting like every Shape2D kind: it adds no solid to the program, and the export does not fail', () => {
    const { doc } = hatched({});
    const data = execute(doc, 'export_code', { language: 'cadquery' }).data as { solidCount: number; source: string };
    expect(data.solidCount).toBe(0);
    for (const language of ['openscad', 'freecad', 'build123d']) {
      expect(execute(doc, 'export_code', { language }).affected).toEqual([]);
    }
  });
});
