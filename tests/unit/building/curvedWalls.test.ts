import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  arcThrough,
  curvedWallBand,
  curvedWallLength,
} from '@core/commands/building/curvedWallGeometry';
import { buildPlanDrawing } from '@core/commands/building/plan';
import { buildingErrors } from '@core/commands/building/validate';
import { serializeDocument } from '@core/commands/persistence';
import type { CurvedWallElement } from '@core/model/building';
import type { TakeoffLine } from '@core/commands/building/quantities';
import type { IfcExport } from '@core/commands/building/ifc';
import type { DxfExport } from '@core/commands/building/dxf';
import type { Clash } from '@core/commands/building/industrial/clash';
import { __resetIdCounter } from '@lib/id';

/** Half circle of radius 5000 from (−5000, 0) over (0, 5000) to (5000, 0). */
const HALF = { start: [-5000, 0], through: [0, 5000], end: [5000, 0], thickness: 300 };

function wallOf(doc: CadDocument, id = 'curvedWall-1'): CurvedWallElement {
  const element = doc.building?.elements[id];
  if (element?.category !== 'curvedWall') throw new Error(id);
  return element;
}

beforeEach(() => __resetIdCounter());

describe('arcThrough', () => {
  it('finds centre, radius and the sweep through the middle point', () => {
    const ccw = arcThrough([5000, 0], [0, 5000], [-5000, 0])!;
    expect(ccw.center[0]).toBeCloseTo(0);
    expect(ccw.center[1]).toBeCloseTo(0);
    expect(ccw.radius).toBeCloseTo(5000);
    expect(ccw.sweep).toBeCloseTo(Math.PI);
    const cw = arcThrough([-5000, 0], [0, 5000], [5000, 0])!;
    expect(cw.sweep).toBeCloseTo(-Math.PI);
    // A three-quarter arc.
    const major = arcThrough([1, 0], [0, -1], [0, 1])!;
    expect(Math.abs(major.sweep)).toBeCloseTo((3 * Math.PI) / 2);
  });

  it('rejects collinear or coincident points', () => {
    expect(arcThrough([0, 0], [1, 1], [2, 2])).toBeNull();
    expect(arcThrough([0, 0], [0, 0], [0, 0])).toBeNull();
  });
});

describe('add_curved_wall', () => {
  it('creates a curved wall mesh with length, marks shared with straight walls', () => {
    let doc = execute(createEmptyDocument(), 'add_wall', {
      start: [0, -2000],
      end: [4000, -2000],
    }).document;
    const before = JSON.stringify(doc);
    const result = execute(doc, 'add_curved_wall', HALF);
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.summary).toMatch(
      /Added curved wall W2 \(curvedWall-1\): radius 5000\.0, 180\.0°, length 15\.71 m, 300 thick, 3000 high\./,
    );
    doc = result.document;
    expect(result.affected[0]).toBe('curvedWall-1');
    expect(doc.entities['curvedWall-1:body']?.kind).toBe('mesh');
    expect(doc.entities['curvedWall-1:body']?.layerId).toBe('layer-A-WALL');
    expect(curvedWallLength(wallOf(doc))).toBeCloseTo(Math.PI * 5000);
    const band = curvedWallBand(wallOf(doc))!;
    const radii = band.map(([x, y]) => Math.hypot(x, y));
    expect(Math.min(...radii)).toBeCloseTo(4850);
    expect(Math.max(...radii)).toBeCloseTo(5150);
  });

  it.each([
    [{ ...HALF, start: [0] }, /must be \[x, y\]/],
    [{ ...HALF, through: [0, 0], end: [5000, 0], start: [-5000, 0] }, /collinear/],
    [{ ...HALF, thickness: 0 }, /must be > 0/],
    [{ ...HALF, thickness: 20000 }, /smaller than the diameter/],
    [{ ...HALF, levelId: 'nope' }, /add_curved_wall failed/],
  ])('rejects %j', (params, message) => {
    const result = execute(createEmptyDocument(), 'add_curved_wall', params);
    expect(result.affected).toEqual([]);
    expect(result.summary).toMatch(message);
  });

  it('feeds wall quantities, schedule, plan, DXF, IFC and clashes', () => {
    let doc = execute(createEmptyDocument(), 'add_curved_wall', {
      ...HALF,
      material: 'masonry',
    }).document;
    const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(lines.find((line) => line.key === 'wall.masonry.m')?.quantity).toBeCloseTo(15.708, 2);
    expect(lines.find((line) => line.key === 'wall.masonry.m3')?.quantity).toBeCloseTo(
      15.708 * 3 * 0.3,
      2,
    );
    const schedule = execute(doc, 'building_schedule', { kind: 'wall' }).data as {
      rows: unknown[][];
    };
    expect(schedule.rows[0]?.[0]).toBe('W1');
    const plan = buildPlanDrawing(doc, undefined)!;
    const cut = plan.primitives.find((p) => p.type === 'polygon' && p.layer === 'A-WALL');
    expect(cut?.type === 'polygon' && cut.fill).toBe('hatch');
    expect((execute(doc, 'export_dxf', {}).data as DxfExport).layers).toContain('A-WALL-PATT');
    expect((execute(doc, 'export_ifc', {}).data as IfcExport).ifc).toMatch(
      /IFCWALL\('[^']+',\$,'W1'/,
    );
    doc = execute(doc, 'add_pipe_run', {
      points: [
        [0, 0, 1000],
        [0, 8000, 1000],
      ],
    }).document;
    const clashes = (execute(doc, 'check_clashes', {}).data as { clashes: Clash[] }).clashes;
    expect(clashes.map((clash) => [clash.a, clash.b].sort())).toEqual([['curvedWall-1', 'pipe-1']]);
  });

  it('is drawn hidden when above the cut, moves, copies and survives save / load', () => {
    let doc = execute(createEmptyDocument(), 'add_curved_wall', {
      ...HALF,
      baseOffset: 2000,
    }).document;
    const plan = buildPlanDrawing(doc, undefined)!;
    expect(plan.primitives.find((p) => p.layer === 'A-WALL')?.style).toBe('hidden');
    doc = execute(doc, 'move_building_element', {
      elementIds: ['curvedWall-1'],
      delta: [1000, 0],
    }).document;
    expect(wallOf(doc).through).toEqual([1000, 5000]);
    doc = execute(doc, 'add_level', { name: 'Upper' }).document;
    doc = execute(doc, 'copy_level_elements', {
      sourceLevelId: 'level-1',
      targetLevelIds: ['level-2'],
    }).document;
    expect(wallOf(doc, 'curvedWall-2').levelId).toBe('level-2');
    const loaded = execute(createEmptyDocument(), 'load_document', {
      json: serializeDocument(doc),
    }).document;
    expect(loaded.entities['curvedWall-2:body']).toBeDefined();
    expect(buildingErrors(doc.building)).toEqual([]);
    const broken = JSON.parse(JSON.stringify(doc.building)) as {
      elements: Record<string, Record<string, unknown>>;
    };
    broken.elements['curvedWall-1']!['through'] = 'x';
    expect(buildingErrors(broken)).toEqual([expect.stringMatching(/through/)]);
  });
});

describe('curved wall review regressions', () => {
  it('is hatched as concrete when cut in a section', async () => {
    const { buildElevationDrawing } = await import('@core/commands/building/elevation');
    const doc = execute(createEmptyDocument(), 'add_curved_wall', HALF).document;
    const drawing = buildElevationDrawing(doc, { direction: 'south', cutAt: 4000 })!;
    expect(drawing.cutRegions.map((region) => region.material)).toEqual(['concrete']);
  });

  it('rejects collinear curved walls on load and gives no clash boxes without a band', async () => {
    const { elementBoxes } = await import('@core/commands/building/industrial/clash');
    const doc = execute(createEmptyDocument(), 'add_curved_wall', HALF).document;
    const broken = JSON.parse(JSON.stringify(doc.building)) as {
      elements: Record<string, Record<string, unknown>>;
    };
    broken.elements['curvedWall-1']!['through'] = [0, 0];
    expect(buildingErrors(broken)).toEqual([expect.stringMatching(/collinear/)]);
    const thick = { ...wallOf(doc), thickness: 20000 };
    expect(elementBoxes(doc, doc.building!, thick)).toEqual([]);
  });
});
