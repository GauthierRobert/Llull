import { type CadDocument, type Entity, type Vec2, type Vec3, createEmptyDocument } from '@core/model/types';
import { entityPlanPoint } from '@core/geometry/entityFrame';

const TURN = 2 * Math.PI;

type Geometry = Record<string, unknown> & { kind: Entity['kind'] };

/** One entity of a hand-built drawing: `layer` is a layer id of `goldenDraft`. */
const entity = (
  id: string,
  geometry: Geometry,
  layerId: string,
  color: string,
  position: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0],
): Entity => ({ id, ...geometry, position, rotation, layerId, color }) as unknown as Entity;

export const GOLDEN_LAYER_COLOR = '#ff0000';

/** A drawing with every exportable 2D kind, placed (position, Z rotation, elevation), on three layers (one hidden + locked, one without colour). */
export function goldenDraft(): CadDocument {
  const base = createEmptyDocument();
  const doc: CadDocument = {
    ...base,
    layers: {
      ...base.layers,
      walls: { id: 'walls', name: 'WALLS', visible: true, locked: false, color: GOLDEN_LAYER_COLOR },
      notes: { id: 'notes', name: 'Notes & dims', visible: false, locked: true, color: '#00aa00' },
    },
    layerOrder: [...base.layerOrder, 'walls', 'notes'],
  };
  const plate: Vec2[] = [
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 10],
  ];
  const hole: Vec2[] = [
    [8, 3],
    [12, 3],
    [12, 7],
    [8, 7],
  ];
  const list: Entity[] = [
    entity('line-1', { kind: 'line', start: [0, 0], end: [10, 5] }, 'walls', GOLDEN_LAYER_COLOR, [2, 3, 1.5], [0, 0, 0.3]),
    entity(
      'poly-1',
      {
        kind: 'polyline',
        points: [
          [0, 0],
          [3, 4],
          [6, 1],
        ],
        closed: false,
      },
      'walls',
      '#123456',
    ),
    entity(
      'poly-2',
      {
        kind: 'polyline',
        points: [
          [0, 0],
          [4, 0],
          [4, 3],
          [1, 5],
        ],
        closed: true,
      },
      'walls',
      '#123456',
      [5, 5, 0],
    ),
    entity(
      'arc-1',
      { kind: 'arc', center: [1, 1], radius: 4, startAngle: 0.3, endAngle: 2.0 },
      'walls',
      GOLDEN_LAYER_COLOR,
      [0, 0, 0],
      [0, 0, 0.5],
    ),
    entity('circle-1', { kind: 'circle', center: [2, 3], radius: 1.5 }, 'walls', '#abcdef'),
    entity('rect-1', { kind: 'rectangle', width: 6, height: 3 }, 'walls', GOLDEN_LAYER_COLOR, [10, 10, 0], [0, 0, 0.7]),
    entity('ellipse-1', { kind: 'ellipse', center: [1, 2], radiusX: 3, radiusY: 1.5 }, 'walls', GOLDEN_LAYER_COLOR, [0, 0, 0], [0, 0, 0.4]),
    entity('ellipse-2', { kind: 'ellipse', center: [0, 0], radiusX: 1, radiusY: 2 }, 'walls', GOLDEN_LAYER_COLOR, [30, 0, 0]),
    entity(
      'spline-1',
      {
        kind: 'spline',
        points: [
          [0, 0],
          [2, 3],
          [5, 3],
          [7, 0],
          [9, 2],
        ],
        closed: false,
      },
      'walls',
      GOLDEN_LAYER_COLOR,
      [0, 20, 0],
    ),
    entity(
      'spline-2',
      {
        kind: 'spline',
        points: [
          [0, 0],
          [3, 0],
          [3, 3],
          [0, 3],
        ],
        closed: true,
      },
      'walls',
      GOLDEN_LAYER_COLOR,
      [20, 20, 0.25],
      [0, 0, 0.2],
    ),
    entity('point-1', { kind: 'point' }, 'walls', '#ff00ff', [7, 8, 0]),
    entity('text-1', { kind: 'text', content: 'Ø25 ±0.1', height: 2.5, anchor: 'center' }, 'notes', '#00aa00', [4, 4, 0], [0, 0, 0.2]),
    entity('text-2', { kind: 'text', content: 'Left note', height: 1.5, anchor: 'left' }, 'notes', '#00aa00', [0, -5, 0]),
    entity('text-3', { kind: 'text', content: 'Right', height: 1, anchor: 'right' }, 'notes', '#00aa00', [30, -5, 0]),
    entity(
      'region-1',
      { kind: 'region', loops: [plate, hole], hatch: { pattern: 'lines', angle: Math.PI / 4, spacing: 1.5 } },
      'walls',
      GOLDEN_LAYER_COLOR,
      [50, 0, 0],
      [0, 0, 0.1],
    ),
    entity(
      'region-2',
      { kind: 'region', loops: [plate], hatch: { pattern: 'cross', angle: 0.3, spacing: 2 } },
      'walls',
      '#123456',
      [50, 20, 0],
    ),
    entity(
      'region-3',
      { kind: 'region', loops: [plate], hatch: { pattern: 'solid', angle: Math.PI / 4, spacing: 1 } },
      'walls',
      '#654321',
      [50, 40, 0],
    ),
    entity('region-4', { kind: 'region', loops: [plate, hole] }, 'walls', GOLDEN_LAYER_COLOR, [50, 60, 0]),
  ];
  return { ...doc, entities: Object.fromEntries(list.map((e) => [e.id, e])), order: list.map((e) => e.id) };
}

const wrap = (angle: number): number => ((angle % TURN) + TURN) % TURN;
const wrapHalf = (angle: number, period: number): number => ((angle % period) + period) % period;

/** World-space signature of an entity: kind, layer name, colour, elevation and geometry as numbers (equal drawings give equal signatures). */
export function worldSignature(doc: CadDocument, e: Entity): { key: string; numbers: number[] } {
  const layer = doc.layers[e.layerId]?.name ?? '?';
  const world = (point: Vec2): number[] => [...entityPlanPoint(e, point)];
  const turn = e.rotation[2];
  const head = [e.position[2]];
  const part = (numbers: number[], extra = ''): { key: string; numbers: number[] } => ({
    key: `${e.kind}|${layer}|${e.color}${extra}`,
    numbers: [...head, ...numbers],
  });
  switch (e.kind) {
    case 'line':
      return part([...world(e.start), ...world(e.end)]);
    case 'polyline':
      return part(e.points.flatMap(world), `|${e.closed}|${e.points.length}`);
    case 'rectangle': {
      const { width, height } = e;
      return part(
        [
          [0, 0],
          [width, 0],
          [width, height],
          [0, height],
        ].flatMap((p) => world([p[0] as number, p[1] as number])),
      );
    }
    case 'arc':
      return part([...world(e.center), e.radius, wrap(e.startAngle + turn), wrapSweep(e.endAngle - e.startAngle)]);
    case 'circle':
      return part([...world(e.center), e.radius]);
    case 'ellipse': {
      const wide = e.radiusX >= e.radiusY;
      return part([
        ...world(e.center),
        Math.max(e.radiusX, e.radiusY),
        Math.min(e.radiusX, e.radiusY),
        wrapHalf(wide ? turn : turn + Math.PI / 2, Math.PI),
      ]);
    }
    case 'spline':
      return part(e.points.flatMap(world), `|${e.closed}|${e.points.length}`);
    case 'point':
      return part([e.position[0], e.position[1]]);
    case 'text':
      return part([e.position[0], e.position[1], e.height, wrap(turn)], `|${e.content}|${e.anchor ?? 'left'}`);
    case 'region': {
      const hatch = e.hatch;
      const period = hatch?.pattern === 'cross' ? Math.PI / 2 : Math.PI;
      const hatchNumbers = hatch === undefined || hatch.pattern === 'solid' ? [] : [wrapHalf(hatch.angle + turn, period), hatch.spacing];
      return part(
        [...e.loops.flatMap((loop) => loop.flatMap(world)), ...hatchNumbers],
        `|${hatch?.pattern ?? 'none'}|${e.loops.map((l) => l.length).join(',')}`,
      );
    }
    default:
      return part([]);
  }
}

function wrapSweep(sweep: number): number {
  const wrapped = wrap(sweep);
  return wrapped === 0 ? TURN : wrapped;
}
