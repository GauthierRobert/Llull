import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { buildPlanDrawing } from '@aec/plan';
import { buildingErrors } from '@aec/validate';
import { layerBoundaries, parseWallLayers } from '@aec/wallLayers';
import type { TakeoffLine } from '@aec/quantities';
import type { IfcExport } from '@aec/ifc';
import type { WallElement } from '@core/model/building';

const BUILD_UP = [
  { material: 'brick', thickness: 100, function: 'finish' },
  { material: 'mineral-wool', thickness: 120, function: 'insulation' },
  { material: 'concrete', thickness: 200, function: 'structure' },
  { material: 'gypsum', thickness: 15, function: 'finish' },
];

function wallDoc(): CadDocument {
  return execute(createEmptyDocument(), 'add_wall', {
    start: [0, 0],
    end: [5000, 0],
    height: 3000,
  }).document;
}

function wallOf(doc: CadDocument, id = 'wall-1'): WallElement {
  const element = doc.building?.elements[id];
  if (element?.category !== 'wall') throw new Error(id);
  return element;
}

describe('set_wall_layers', () => {
  it('sets a build-up, its total thickness and structural material', () => {
    const doc = wallDoc();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'set_wall_layers', { wallIds: ['wall-1'], layers: BUILD_UP });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.summary).toBe(
      'Set a 4-layer build-up (435 total: 100 brick + 120 mineral-wool + 200 concrete + 15 gypsum) on W1.',
    );
    expect(result.affected[0]).toBe('wall-1');
    const wall = wallOf(result.document);
    expect(wall).toMatchObject({ thickness: 435, material: 'concrete' });
    expect(layerBoundaries(wall)).toEqual([-117.5, 2.5, 202.5]);
  });

  it('removes a build-up and is dropped when update_wall changes the thickness', () => {
    let doc = execute(wallDoc(), 'set_wall_layers', {
      wallIds: ['wall-1'],
      layers: BUILD_UP,
    }).document;
    const removed = execute(doc, 'set_wall_layers', { wallIds: ['wall-1'], layers: null });
    expect(removed.summary).toBe('Removed the build-up of W1.');
    expect(wallOf(removed.document).layers).toBeUndefined();
    const kept = execute(doc, 'update_wall', { wallId: 'wall-1', height: 2800 });
    expect(wallOf(kept.document).layers).toHaveLength(4);
    doc = execute(doc, 'update_wall', { wallId: 'wall-1', thickness: 300 }).document;
    expect(wallOf(doc).layers).toBeUndefined();
  });

  it.each([
    [{ wallIds: ['wall-9'], layers: BUILD_UP }, /must list existing walls/],
    [{ wallIds: ['wall-1'], layers: [] }, /1–10/],
    [{ wallIds: ['wall-1'], layers: [{ material: 'x', thickness: 0 }] }, /thickness > 0/],
    [
      { wallIds: ['wall-1'], layers: [{ material: 'x', thickness: 10, function: 'glue' }] },
      /function/,
    ],
    [{ wallIds: 'wall-1', layers: BUILD_UP }, /rejected: invalid params — wallIds/],
  ])('rejects %j', (params, message) => {
    const result = execute(wallDoc(), 'set_wall_layers', params);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(message);
  });

  it('defaults the layer function to structure and picks the thickest without one', () => {
    expect(parseWallLayers([{ material: 'timber', thickness: 100 }])).toEqual([
      { material: 'timber', thickness: 100, function: 'structure' },
    ]);
    const doc = execute(wallDoc(), 'set_wall_layers', {
      wallIds: ['wall-1'],
      layers: [
        { material: 'board', thickness: 20, function: 'finish' },
        { material: 'wool', thickness: 150, function: 'insulation' },
      ],
    }).document;
    expect(wallOf(doc).material).toBe('wool');
  });

  it('reports quantities per layer, draws layer lines, exports an IFC layer set', () => {
    const doc = execute(wallDoc(), 'set_wall_layers', {
      wallIds: ['wall-1'],
      layers: BUILD_UP,
    }).document;
    const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(lines.find((line) => line.key === 'wall.mineral-wool.m3')?.quantity).toBeCloseTo(
      5 * 3 * 0.12,
      3,
    );
    expect(lines.find((line) => line.key === 'wall.brick.m2')?.quantity).toBeCloseTo(15, 3);
    expect(lines.find((line) => line.key === 'wall.concrete.m')?.quantity).toBeCloseTo(5, 3);
    const layerLines = buildPlanDrawing(doc, undefined)!.primitives.filter(
      (p) => p.type === 'line' && p.layer === 'A-WALL',
    );
    expect(layerLines).toHaveLength(3);
    const ifc = (execute(doc, 'export_ifc', {}).data as IfcExport).ifc;
    expect(ifc.match(/IFCMATERIALLAYER\(/g)).toHaveLength(4);
    expect(ifc).toContain('IFCMATERIALLAYERSETUSAGE(');
  });

  it('validates build-ups on load', () => {
    const doc = execute(wallDoc(), 'set_wall_layers', {
      wallIds: ['wall-1'],
      layers: BUILD_UP,
    }).document;
    expect(buildingErrors(doc.building)).toEqual([]);
    const broken = JSON.parse(JSON.stringify(doc.building)) as {
      elements: Record<string, Record<string, unknown>>;
    };
    broken.elements['wall-1']!['thickness'] = 400;
    expect(buildingErrors(broken)).toEqual([expect.stringMatching(/add up to the wall thickness/)]);
    broken.elements['wall-1']!['layers'] = 'x';
    expect(buildingErrors(broken)).toEqual([expect.stringMatching(/layers must be/)]);
  });
});

describe('build-up review regressions', () => {
  it('rejects stored layers without a function and never crashes the IFC export', () => {
    const doc = execute(wallDoc(), 'set_wall_layers', {
      wallIds: ['wall-1'],
      layers: BUILD_UP,
    }).document;
    const broken = JSON.parse(JSON.stringify(doc.building)) as {
      elements: Record<string, { layers?: Array<Record<string, unknown>> }>;
    };
    delete broken.elements['wall-1']!.layers![0]!['function'];
    expect(buildingErrors(broken)).toEqual([expect.stringMatching(/needs a function/)]);
    const loose = {
      ...doc,
      building: broken as unknown as NonNullable<CadDocument['building']>,
    };
    expect(() => execute(loose, 'export_ifc', {})).not.toThrow();
  });

  it('counts layered walls as IFC products', () => {
    const plain = execute(wallDoc(), 'export_ifc', {}).data as IfcExport;
    const layered = execute(
      execute(wallDoc(), 'set_wall_layers', { wallIds: ['wall-1'], layers: BUILD_UP }).document,
      'export_ifc',
      {},
    ).data as IfcExport;
    expect(layered.productCount).toBe(plain.productCount);
  });

  it('drops the build-up when update_wall changes the material', () => {
    const doc = execute(wallDoc(), 'set_wall_layers', {
      wallIds: ['wall-1'],
      layers: BUILD_UP,
    }).document;
    const same = execute(doc, 'update_wall', { wallId: 'wall-1', material: 'concrete' });
    expect(wallOf(same.document).layers).toHaveLength(4);
    const changed = execute(doc, 'update_wall', { wallId: 'wall-1', material: 'timber' });
    expect(changed.summary).toMatch(/\(build-up removed\)/);
    expect(wallOf(changed.document)).toMatchObject({ material: 'timber' });
    expect(wallOf(changed.document).layers).toBeUndefined();
  });
});
