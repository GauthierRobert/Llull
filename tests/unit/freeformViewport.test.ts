import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type NurbsCurveEntity, type NurbsSurfaceEntity, type SubdivisionEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { netAnchor, netSegments, pickPole, poleBuffer, poleMoveCommand, polesOf, toWorld } from '@ui/viewport/3d/nurbsNet/controlNet';
import { cancelsOnCaptureLoss, loopCutEdge, loopCutFactor } from '@ui/viewport/3d/cage/loopCutDrag';
import { gestureCommand, DEFAULT_FALLOFF } from '@ui/viewport/3d/cage/gestureCommands';
import { gizmoFramePosition } from '@ui/viewport/3d/gizmoSpace';
import { toRenderPosition } from '@ui/viewport/3d/floatingOrigin';
import { translateDelta } from '@ui/viewport/3d/cage/dragMath';
import { visibleFields } from '@ui/components/commandPalette/fieldVisibility';
import { commandLabel, fieldsFromSchema, humanizeName } from '@ui/components/commandPalette/paramForm';
import { getCommand } from '@core/commands/registry';

const empty = createEmptyDocument();
const curveRun = execute(empty, 'create_nurbs_curve', {
  degree: 2,
  poles: [
    [0, 0, 0],
    [1, 2, 0],
    [2, 0, 0],
    [3, 2, 0],
  ],
});
const curve = curveRun.document.entities[curveRun.affected[0] as string] as NurbsCurveEntity;
const surfaceRun = execute(empty, 'create_nurbs_surface', {
  degreeU: 1,
  degreeV: 1,
  poles: [
    [
      [0, 0, 0],
      [0, 1, 0],
      [0, 2, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 1],
      [1, 2, 0],
    ],
  ],
});
const surface = surfaceRun.document.entities[surfaceRun.affected[0] as string] as NurbsSurfaceEntity;

describe('control polygon and net', () => {
  it('a curve polygon has one segment per pole pair, a surface net one per grid edge', () => {
    expect(polesOf(curve)).toHaveLength(4);
    expect(netSegments(curve)).toHaveLength(3 * 6);
    expect(polesOf(surface)).toHaveLength(6);
    // 2 rows x 3 columns: 4 along v, 3 along u
    expect(netSegments(surface)).toHaveLength(7 * 6);
  });

  it('re-bases the buffers on the anchor pole (floating origin)', () => {
    const far = {
      ...curve,
      curve: { ...curve.curve, poles: curve.curve.poles.map((p) => [p[0] + 1e7, p[1], p[2]] as [number, number, number]) },
    };
    const anchor = netAnchor(far);
    expect(anchor[0]).toBe(1e7);
    expect(Array.from(poleBuffer(far, anchor)).slice(0, 3)).toEqual([0, 0, 0]);
    expect(Array.from(poleBuffer(far, anchor, 2))).toEqual([2, 0, 0]);
    expect(Array.from(netSegments(far, anchor)).slice(0, 6)).toEqual([0, 0, 0, 1, 2, 0]);
  });

  it('picks the pole nearest the ray within the pixel reach and none outside', () => {
    const ray = { origin: [1.02, 2.05, 10] as [number, number, number], direction: [0, 0, -1] as [number, number, number] };
    const hit = pickPole(curve, ray, 10, () => 0.01);
    expect(hit?.pole.id).toBe(1);
    expect(pickPole(curve, ray, 3, () => 0.01)).toBeNull();
    expect(pickPole(curve, { ...ray, direction: [0, 0, 1] }, 10, () => 0.01)).toBeNull();
  });

  it('moves a pole by the entity-local delta of a world displacement', () => {
    expect(poleMoveCommand(curve, 1, [0, 0, 0.0000001])).toBeNull();
    expect(poleMoveCommand(curve, 1, [0.5, 0, 0])).toEqual({
      name: 'edit_nurbs',
      params: { id: curve.id, operation: 'move_poles', indices: [1], delta: [0.5, 0, 0] },
    });
    expect(poleMoveCommand(surface, [1, 1], [0, 0, 2])).toEqual({
      name: 'edit_nurbs_surface',
      params: { id: surface.id, operation: 'move_poles', poles: [[1, 1]], delta: [0, 0, 2] },
    });
    // a pole id of the wrong shape never builds a command
    expect(poleMoveCommand(curve, [0, 0], [1, 0, 0])).toBeNull();
    expect(poleMoveCommand(surface, 0, [1, 0, 0])).toBeNull();
  });

  it('converts a world drag to the local frame of a rotated entity, and the command accepts it', () => {
    const turned: NurbsCurveEntity = { ...curve, rotation: [0, 0, Math.PI / 2], position: [10, 0, 0] };
    const world = toWorld(turned, [1, 0, 0]);
    expect(world[0]).toBeCloseTo(10, 9);
    expect(world[1]).toBeCloseTo(1, 9);
    const command = poleMoveCommand(turned, 0, [0, 1, 0]);
    expect(command?.params['delta']).toEqual([1, 0, 0]);
    const doc = { ...curveRun.document, entities: { ...curveRun.document.entities, [turned.id]: turned } };
    const moved = execute(doc, command?.name ?? '', command?.params);
    expect((moved.document.entities[turned.id] as NurbsCurveEntity).curve.poles[0]).toEqual([1, 0, 0]);
  });
});

describe('loop cut factor drag', () => {
  const cageRun = execute(empty, 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 1 });
  const cage = cageRun.document.entities[cageRun.affected[0] as string] as SubdivisionEntity;
  const topology = cage.faces[0] as number[];
  const first = cage.elementIds.vertices[topology[0] as number] as string;
  const second = cage.elementIds.vertices[topology[1] as number] as string;
  const edgeId = `e:${[first, second].sort().join('|')}`;

  it('maps the pointer to a factor along the edge from its first id vertex and keeps it off the ends', () => {
    const edge = loopCutEdge(cage, edgeId);
    expect(edge).not.toBeNull();
    const ends = edge as NonNullable<typeof edge>;
    const along = [ends.b[0] - ends.a[0], ends.b[1] - ends.a[1], ends.b[2] - ends.a[2]];
    // look at the edge from the side: perpendicular to it, through the point at parameter t
    const side = [
      (along[1] as number) * 0.5 - (along[2] as number) * 0.7,
      (along[2] as number) * 0.3 - (along[0] as number) * 0.5,
      (along[0] as number) * 0.7 - (along[1] as number) * 0.3,
    ];
    const norm = Math.hypot(...side);
    const direction = side.map((v) => v / norm) as [number, number, number];
    const viewed = (t: number): { origin: [number, number, number]; direction: [number, number, number] } => ({
      origin: [0, 1, 2].map((k) => (ends.a[k] as number) + (along[k] as number) * t - (direction[k] as number) * 5) as [
        number,
        number,
        number,
      ],
      direction,
    });
    const factor = loopCutFactor(ends, viewed(0.3));
    expect(factor).toBe(0.3);
    expect(loopCutFactor(ends, viewed(5))).toBe(0.98);
    expect(loopCutFactor(ends, viewed(-5))).toBe(0.02);
  });

  it('is unknown for an edge id that is not in the cage', () => {
    expect(loopCutEdge(cage, 'e:nope|nada')).toBeNull();
    expect(loopCutEdge(cage, 'garbage')).toBeNull();
  });

  it('commits the dragged factor with cuts 1 only', () => {
    const selection = { vertices: [], edges: [], faces: [] };
    expect(gestureCommand('c', { kind: 'loop_cut', edge: edgeId, cuts: 1, factor: 0.3 }, selection, DEFAULT_FALLOFF)?.params).toEqual({
      id: 'c',
      edge: edgeId,
      cuts: 1,
      factor: 0.3,
    });
    expect(gestureCommand('c', { kind: 'loop_cut', edge: edgeId, cuts: 3 }, selection, DEFAULT_FALLOFF)?.params).toEqual({
      id: 'c',
      edge: edgeId,
      cuts: 3,
    });
    const run = execute(cageRun.document, 'loop_cut_cage', { id: cage.id, edge: edgeId, cuts: 1, factor: 0.3 });
    expect(run.affected).toContain(cage.id);
  });

  it('translateDelta locks to one world axis', () => {
    const start = {
      ray: { origin: [0, 0, 10] as [number, number, number], direction: [0, 0, -1] as [number, number, number] },
      origin: [0, 0, 0] as [number, number, number],
      axis: [0, 0, 1] as [number, number, number],
    };
    const ray = { origin: [2, 3, 10] as [number, number, number], direction: [0, 0, -1] as [number, number, number] };
    expect(translateDelta(start, ray, null)).toEqual([2, 3, 0]);
    expect(translateDelta(start, ray, 'x')).toEqual([2, 0, 0]);
    expect(translateDelta(start, { ...ray, direction: [1, 0, 0] }, null)).toBeNull();
  });
});

describe('form fields of the freeform commands', () => {
  const fieldsOf = (name: string): ReturnType<typeof fieldsFromSchema> =>
    fieldsFromSchema((getCommand(name) as NonNullable<ReturnType<typeof getCommand>>).paramsSchema);
  const names = (name: string, values: Record<string, string>): string[] => visibleFields(name, fieldsOf(name), values).map((f) => f.name);

  it('move_faces shows only the parameters of the chosen mode', () => {
    const offset = names('move_faces', { mode: 'offset' });
    expect(offset).toContain('distance');
    expect(offset).not.toContain('vector');
    expect(offset).not.toContain('angleDeg');
    expect(names('move_faces', { mode: 'rotate' })).toEqual(expect.arrayContaining(['axis', 'angleDeg', 'facesNear']));
    expect(names('move_faces', { mode: 'translate' })).not.toContain('axis');
  });

  it('edit_nurbs and edit_nurbs_surface follow their operation', () => {
    expect(names('edit_nurbs', { operation: 'drag_point' })).toEqual(expect.arrayContaining(['id', 'operation', 'u', 'displacement']));
    expect(names('edit_nurbs', { operation: 'drag_point' })).not.toContain('delta');
    expect(names('edit_nurbs', { operation: 'reverse' })).toEqual(['id', 'operation']);
    expect(names('edit_nurbs_surface', { operation: 'set_weight' })).toEqual(expect.arrayContaining(['i', 'j', 'weight']));
    expect(names('edit_nurbs_surface', { operation: 'set_weight' })).not.toContain('poles');
  });

  it('shows everything while no operation is chosen and for commands without a rule', () => {
    expect(names('edit_nurbs', { operation: '' })).toEqual(fieldsOf('edit_nurbs').map((f) => f.name));
    expect(names('add_box', {})).toEqual(fieldsOf('add_box').map((f) => f.name));
  });

  it('labels the freeform commands and humanizes the rest', () => {
    expect(commandLabel('push_pull_face')).toBe('Push / pull face');
    expect(commandLabel('add_box')).toBe(humanizeName('add_box'));
  });
});

describe('capture loss during a cage press', () => {
  it('cancels a loop-cut press even before it moved, and a drag only once it moved', () => {
    expect(cancelsOnCaptureLoss({ kind: 'loopcut', active: false })).toBe(true);
    expect(cancelsOnCaptureLoss({ kind: 'loopcut', active: true })).toBe(true);
    expect(cancelsOnCaptureLoss({ kind: 'drag', active: false })).toBe(false);
    expect(cancelsOnCaptureLoss({ kind: 'drag', active: true })).toBe(true);
    expect(cancelsOnCaptureLoss({ kind: 'background' })).toBe(false);
  });
});

describe('transform gizmo frame under a floating origin', () => {
  it('draws the handle at entity position - renderOrigin, not position - 2 * renderOrigin', () => {
    const position: [number, number, number] = [100020, 5, 7];
    const renderOrigin: [number, number, number] = [100000, 0, 0];
    // the target sits inside the group offset by -renderOrigin: what is drawn is group offset + target
    const drawn = gizmoFramePosition(position).map((v, k) => v - (renderOrigin[k] as number));
    expect(drawn).toEqual(toRenderPosition(position, renderOrigin));
    expect(drawn).toEqual([20, 5, 7]);
  });
});
