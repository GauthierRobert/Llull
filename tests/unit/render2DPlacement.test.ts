/** 2D shapes render (strokes and label markers) in their rotated work plane; splines use the real curve. */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { tessellateEntity } from '@core/commands/render/polygons';
import { catmullRomBeziers, segmentPoint } from '@core/geometry/curveSegments';
import { planeToWorld } from '@core/geometry/workPlane';

const QUARTER_TURN = Math.PI / 2;

/** Draws one entity; `rotation` (not a draw param) is written onto it afterwards. */
function draw(
  command: string,
  params: Record<string, unknown>,
  rotation: [number, number, number] = [0, 0, 0],
): { doc: CadDocument; entity: Entity } {
  const result = execute(createEmptyDocument(), command, params);
  const id = result.affected[0] as string;
  const entity = { ...(result.document.entities[id] as Entity), rotation };
  return { doc: { ...result.document, entities: { [id]: entity } }, entity };
}

describe('planeToWorld', () => {
  it('rotates about the plane origin then translates', () => {
    const world = planeToWorld([5, 0, 1], [0, 0, QUARTER_TURN], [2, 0]);
    expect(world[0]).toBeCloseTo(5, 12);
    expect(world[1]).toBeCloseTo(2, 12);
    expect(world[2]).toBeCloseTo(1, 12);
  });
});

describe('render stroke placement honours the work-plane rotation', () => {
  it('rotates a polyline', () => {
    const { entity } = draw(
      'draw_polyline',
      {
        points: [
          [0, 0],
          [2, 0],
        ],
      },
      [0, 0, QUARTER_TURN],
    );
    const verts = tessellateEntity(entity)[0]?.verts ?? [];
    expect(verts[1]?.[0]).toBeCloseTo(0, 12);
    expect(verts[1]?.[1]).toBeCloseTo(2, 12);
  });

  it('rotates a rectangle', () => {
    const { entity } = draw(
      'draw_rectangle',
      {
        width: 3,
        height: 1,
      },
      [0, 0, QUARTER_TURN],
    );
    const verts = tessellateEntity(entity)[0]?.verts ?? [];
    expect(verts[1]?.[0]).toBeCloseTo(0, 12);
    expect(verts[1]?.[1]).toBeCloseTo(3, 12);
    expect(verts).toHaveLength(5);
  });

  it('places label markers on the rotated shape', () => {
    const labelled = {
      width: 300,
      height: 200,
      showAxes: false,
      showGrid: false,
      showLabels: true,
    };
    const rotated = draw(
      'draw_polyline',
      {
        points: [
          [0, 0],
          [2, 0],
        ],
      },
      [0, 0, QUARTER_TURN],
    );
    const upright = draw('draw_polyline', {
      points: [
        [0, 0],
        [0, 2],
      ],
    });
    const dots = (doc: CadDocument): string[] => {
      const svg = (
        execute(doc, 'render_view', { view: 'top', ...labelled }).data as { svg: string }
      ).svg;
      return [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)"/g)].map(
        (m) => `${m[1]},${m[2]}`,
      );
    };
    const expected = dots(upright.doc);
    expect(expected.length).toBeGreaterThan(0);
    expect(dots(rotated.doc)).toEqual(expected);
  });
});

describe('spline stroke', () => {
  it('follows the centripetal Catmull-Rom curve of the entity', () => {
    const points = [
      [0, 0],
      [1, 0],
      [10, 0.5],
      [11, 5],
    ];
    const { entity } = draw('draw_spline', { points });
    const verts = tessellateEntity(entity)[0]?.verts ?? [];
    const curve = catmullRomBeziers(points as [number, number][], false);
    expect(verts).toHaveLength(curve.length * 8 + 1);
    const mid = segmentPoint(curve[1]!, 0.5);
    expect(verts[8 + 4]?.[0]).toBeCloseTo(mid[0], 9);
    expect(verts[8 + 4]?.[1]).toBeCloseTo(mid[1], 9);
  });
});
