/** Retired instantiate_template: saved steps replay as a build_project of the same draws. */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type Entity, createEmptyDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';

/** Replay a saved document whose only history step is `instantiate_template` with `params`. */
function replayTemplate(params: Record<string, unknown>): CadDocument {
  const saved = serializeDocument({
    ...createEmptyDocument(),
    featureHistory: [{ id: 'step-1', name: 'instantiate_template', params }],
    nextStepNumber: 2,
  });
  return execute(deserializeDocument(saved), 'replay_history', {}).document;
}

const shapes = (doc: CadDocument): Entity[] => doc.order.map((id) => doc.entities[id] as Entity);

describe('retired instantiate_template', () => {
  it('is no longer registered', () => {
    expect(getCommand('instantiate_template')).toBeUndefined();
  });

  it('bolt_hole_pattern replays as the same circles on the bolt circle, with the same ids', () => {
    const doc = replayTemplate({
      template: 'bolt_hole_pattern',
      params: { count: 4, boltCircleRadius: 10, holeRadius: 1 },
      position: [0, 0, 5],
      color: '#123456',
    });
    expect(doc.featureHistory[0]?.name).toBe('build_project');
    const circles = shapes(doc);
    expect(circles.map((e) => e.id)).toEqual(['circ-1.1', 'circ-1.2', 'circ-1.3', 'circ-1.4']);
    circles.forEach((entity, k) => {
      expect(entity).toMatchObject({
        kind: 'circle',
        radius: 1,
        position: [0, 0, 5],
        color: '#123456',
      });
      const [x, y] = (entity as Extract<Entity, { kind: 'circle' }>).center;
      expect(x).toBeCloseTo(10 * Math.cos((k * Math.PI) / 2));
      expect(y).toBeCloseTo(10 * Math.sin((k * Math.PI) / 2));
    });
  });

  it('flange replays as outer + bore + bolt holes', () => {
    const doc = replayTemplate({
      template: 'flange',
      params: { outerRadius: 20, boreRadius: 5, boltCount: 3, boltCircleRadius: 12, holeRadius: 1 },
    });
    expect(shapes(doc).map((e) => (e as Extract<Entity, { kind: 'circle' }>).radius)).toEqual([20, 5, 1, 1, 1]);
  });

  it('rectangular_plate_with_holes replays as the plate then the hole grid row by row', () => {
    const doc = replayTemplate({
      template: 'rectangular_plate_with_holes',
      params: {
        width: 40,
        height: 20,
        holeRows: 2,
        holeCols: 3,
        holeRadius: 2,
        marginX: 5,
        marginY: 5,
      },
    });
    const [plate, ...holes] = shapes(doc);
    expect(plate).toMatchObject({ id: 'rect-1.1', kind: 'rectangle', width: 40, height: 20 });
    expect(holes.map((e) => (e as Extract<Entity, { kind: 'circle' }>).center)).toEqual([
      [5, 5],
      [20, 5],
      [35, 5],
      [5, 15],
      [20, 15],
      [35, 15],
    ]);
    const single = replayTemplate({
      template: 'rectangular_plate_with_holes',
      params: {
        width: 10,
        height: 10,
        holeRows: 1,
        holeCols: 1,
        holeRadius: 1,
        marginX: 2,
        marginY: 3,
      },
    });
    expect((shapes(single)[1] as Extract<Entity, { kind: 'circle' }>).center).toEqual([2, 3]);
  });

  it('invalid or unknown templates still create nothing', () => {
    const cases: Array<Record<string, unknown>> = [
      { template: 'gear', params: {} },
      { template: 'bolt_hole_pattern', params: { count: 0, boltCircleRadius: 5, holeRadius: 1 } },
      { template: 'bolt_hole_pattern', params: { count: 3, boltCircleRadius: 5, holeRadius: -1 } },
      { template: 'bolt_hole_pattern', params: 'nope' },
      {
        template: 'flange',
        params: { outerRadius: 5, boreRadius: 5, boltCount: 2, boltCircleRadius: 3, holeRadius: 1 },
      },
      {
        template: 'rectangular_plate_with_holes',
        params: {
          width: 10,
          height: 10,
          holeRows: 1e5,
          holeCols: 1e5,
          holeRadius: 1,
          marginX: 1,
          marginY: 1,
        },
      },
      {
        template: 'rectangular_plate_with_holes',
        params: {
          width: 10,
          height: 10,
          holeRows: 1,
          holeCols: 1,
          holeRadius: 1,
          marginX: -1,
          marginY: 1,
        },
      },
    ];
    for (const params of cases) expect(shapes(replayTemplate(params))).toEqual([]);
  });
});
