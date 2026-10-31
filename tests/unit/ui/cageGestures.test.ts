import { describe, expect, it, vi } from 'vitest';
import { type CadDocument, type SubdivisionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  type CageGesture,
  DEFAULT_FALLOFF,
  cliLine,
  falloffParam,
  gestureCommand,
  isIdleGesture,
} from '@ui/viewport/3d/cage/gestureCommands';
import { type CageSelection, EMPTY_CAGE_SELECTION } from '@ui/viewport/3d/cage/cageSelection';
import { runCagePreview } from '@ui/viewport/3d/cage/previewRunner';
import { createFrameScheduler } from '@ui/viewport/3d/cage/frameScheduler';
import { type KeyLike, cageKeyAction } from '@ui/viewport/3d/cage/cageKeys';

function cube(): { doc: CadDocument; id: string; cage: SubdivisionEntity } {
  const result = execute(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2], segments: [2, 2, 2] }, levels: 1 });
  const id = result.affected[0] as string;
  return { doc: result.document, id, cage: result.document.entities[id] as SubdivisionEntity };
}

const top = (cage: SubdivisionEntity): string[] => {
  const topVertices = new Set(cage.vertices.flatMap((v, i) => (v[2] === 1 ? [i] : [])));
  return cage.faces.flatMap((f, i) => (f.every((v) => topVertices.has(v)) ? [cage.elementIds.faces[i] as string] : []));
};

describe('gestureCommand: every gesture is ONE registered command with valid params', () => {
  const { doc, id, cage } = cube();
  const faces = top(cage).slice(0, 2);
  const vertices: CageSelection = { ...EMPTY_CAGE_SELECTION, vertices: [cage.elementIds.vertices[0] as string] };
  const faceSelection: CageSelection = { ...EMPTY_CAGE_SELECTION, faces };
  const cases: Array<[string, CageGesture, CageSelection, string]> = [
    ['translate', { kind: 'translate', delta: [0.25, 0, 0] }, vertices, 'edit_subdivision_cage'],
    ['rotate', { kind: 'rotate', axis: [0, 0, 1], angleDeg: 15, pivot: [0, 0, 0] }, vertices, 'edit_subdivision_cage'],
    ['scale', { kind: 'scale', factors: [1.2, 1.2, 1.2], pivot: [0, 0, 0] }, faceSelection, 'edit_subdivision_cage'],
    ['extrude', { kind: 'extrude', distance: 0.4 }, faceSelection, 'extrude_cage_faces'],
    ['inset', { kind: 'inset', thickness: 0.1 }, faceSelection, 'inset_cage_faces'],
  ];
  it.each(cases)('%s', (_name, gesture, selection, expected) => {
    const command = gestureCommand(id, gesture, selection, { ...DEFAULT_FALLOFF, radius: 0.5 });
    expect(command?.name).toBe(expected);
    const result = execute(doc, command?.name ?? '', command?.params ?? {});
    expect(result.error).toBeUndefined();
    expect(result.affected).toEqual([id]);
  });

  it('scale keeps the factor of each axis: an X handle stretches along X only', () => {
    const command = gestureCommand(id, { kind: 'scale', factors: [1.5, 1, 1], pivot: [0, 0, 1] }, faceSelection, DEFAULT_FALLOFF);
    expect(command?.params).toMatchObject({ scale: [1.5, 1, 1], pivot: [0, 0, 1] });
    const after = execute(doc, command?.name ?? '', command?.params ?? {}).document.entities[id] as SubdivisionEntity;
    const moved = cage.faces.filter((_, i) => faces.includes(cage.elementIds.faces[i] as string)).flat();
    expect(moved.length).toBeGreaterThan(0);
    for (const v of moved) {
      const [ax, ay] = cage.vertices[v] as [number, number, number];
      const [bx, by] = after.vertices[v] as [number, number, number];
      expect(by).toBeCloseTo(ay, 9);
      expect(bx).toBeCloseTo(ax * 1.5, 9);
    }
    expect(gestureCommand(id, { kind: 'scale', factors: [1, 1, 1.0000001], pivot: [0, 0, 0] }, faceSelection, DEFAULT_FALLOFF)).toBeNull();
  });

  it('loop cut names the edge and the number of loops', () => {
    const a = cage.elementIds.vertices;
    const edge = `e:${a[0]}|${a[1]}`;
    const command = gestureCommand(id, { kind: 'loop_cut', edge, cuts: 2 }, EMPTY_CAGE_SELECTION, DEFAULT_FALLOFF);
    expect(command).toEqual({ name: 'loop_cut_cage', params: { id, edge, cuts: 2 } });
  });
  it('refuses nothing-to-do: idle gestures, empty selections, extrude without faces', () => {
    expect(gestureCommand(id, { kind: 'translate', delta: [0, 0, 0] }, vertices, DEFAULT_FALLOFF)).toBeNull();
    expect(gestureCommand(id, { kind: 'translate', delta: [1, 0, 0] }, EMPTY_CAGE_SELECTION, DEFAULT_FALLOFF)).toBeNull();
    expect(gestureCommand(id, { kind: 'extrude', distance: 1 }, vertices, DEFAULT_FALLOFF)).toBeNull();
    expect(gestureCommand(id, { kind: 'inset', thickness: 1 }, vertices, DEFAULT_FALLOFF)).toBeNull();
    for (const idle of [
      { kind: 'rotate', axis: [0, 0, 1], angleDeg: 0, pivot: [0, 0, 0] },
      { kind: 'scale', factors: [1, 1, 1], pivot: [0, 0, 0] },
      { kind: 'extrude', distance: 0 },
      { kind: 'inset', thickness: 0 },
    ] as const)
      expect(isIdleGesture(idle)).toBe(true);
  });
  it('sends a bare radius for default falloff and the full object otherwise', () => {
    expect(falloffParam(DEFAULT_FALLOFF)).toBeUndefined();
    expect(falloffParam({ ...DEFAULT_FALLOFF, radius: 0.5 })).toBe(0.5);
    expect(falloffParam({ radius: 0.5, shape: 'linear', metric: 'topological' })).toEqual({
      radius: 0.5,
      shape: 'linear',
      metric: 'topological',
    });
  });
});

describe('cliLine', () => {
  it('repeats the command on the open app, escaping single quotes', () => {
    expect(cliLine({ name: 'extrude_cage_faces', params: { id: 'a', faces: ['f-1.2'], distance: 0.4 } })).toBe(
      `llull exec extrude_cage_faces '{"id":"a","faces":["f-1.2"],"distance":0.4}' --app`,
    );
    expect(cliLine({ name: 'loop_cut_cage', params: { id: "it's" } })).toContain(`it'\\''s`);
  });
});

describe('previewRunner (the drag preview)', () => {
  const { doc, id, cage } = cube();
  const command = gestureCommand(
    id,
    { kind: 'extrude', distance: 0.5 },
    { ...EMPTY_CAGE_SELECTION, faces: top(cage).slice(0, 1) },
    DEFAULT_FALLOFF,
  );

  it('returns local-space ghost triangles and leaves the document alone', () => {
    const placed = execute(doc, 'move_entities', { ids: [id], delta: [10, 0, 0] }).document;
    const before = JSON.stringify(placed);
    const preview = runCagePreview(placed, command ?? { name: 'extrude_cage_faces', params: {} });
    expect(preview.ok).toBe(true);
    expect(preview.entity?.faces.length).toBeGreaterThan(cage.faces.length);
    const xs = preview.triangles.flatMap((t) => t.map((p) => p[0]));
    expect(Math.max(...xs)).toBeLessThan(3);
    expect(JSON.stringify(placed)).toBe(before);
  });
  it('mints the ids the commit mints', () => {
    const preview = runCagePreview(doc, command ?? { name: 'extrude_cage_faces', params: {} });
    const committed = execute(doc, command?.name ?? '', command?.params ?? {}).document.entities[id] as SubdivisionEntity;
    expect(preview.entity?.elementIds).toEqual(committed.elementIds);
  });
  it('reports a refusal instead of a ghost', () => {
    const preview = runCagePreview(doc, { name: 'extrude_cage_faces', params: { id, faces: ['f-9.9'], distance: 1 } });
    expect(preview.ok).toBe(false);
    expect(preview.triangles).toEqual([]);
    expect(preview.summary).toContain('DIR_REF_LOST');
  });
});

describe('createFrameScheduler', () => {
  it('runs only the latest job once per frame', () => {
    const frames: Array<() => void> = [];
    const cancel = vi.fn();
    const scheduler = createFrameScheduler((cb) => frames.push(cb), cancel);
    const [first, second] = [vi.fn(), vi.fn()];
    scheduler.schedule(first);
    scheduler.schedule(second);
    expect(frames).toHaveLength(1);
    frames[0]?.();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    scheduler.schedule(first);
    expect(frames).toHaveLength(2);
  });
  it('cancel drops the waiting job', () => {
    const frames: Array<() => void> = [];
    const cancel = vi.fn();
    const scheduler = createFrameScheduler((cb) => frames.push(cb), cancel);
    const job = vi.fn();
    scheduler.schedule(job);
    scheduler.cancel();
    expect(cancel).toHaveBeenCalled();
    frames[0]?.();
    expect(job).not.toHaveBeenCalled();
  });
});

describe('cageKeyAction', () => {
  const key = (k: string, extra: object = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...extra });
  const idle = { gestureActive: false, tool: 'select', selectionEmpty: true, hasFaceSelection: false } as const;
  it('Escape unwinds: gesture, tool, selection, mode', () => {
    expect(cageKeyAction(key('Escape'), { ...idle, gestureActive: true })).toEqual({ kind: 'cancel_gesture' });
    expect(cageKeyAction(key('Escape'), { ...idle, tool: 'loop_cut' })).toEqual({ kind: 'end_tool' });
    expect(cageKeyAction(key('Escape'), { ...idle, selectionEmpty: false })).toEqual({ kind: 'clear_selection' });
    expect(cageKeyAction(key('Escape'), idle)).toEqual({ kind: 'exit' });
  });
  it('maps the tool keys', () => {
    expect(cageKeyAction(key('r', { ctrlKey: true }), idle)).toEqual({ kind: 'loop_cut_tool' });
    expect(cageKeyAction(key('i'), { ...idle, hasFaceSelection: true })).toEqual({ kind: 'inset' });
    expect(cageKeyAction(key('i'), idle)).toBeNull();
    expect(cageKeyAction(key('2'), idle)).toEqual({ kind: 'mode', mode: 'edge' });
    expect(cageKeyAction(key('2'), { ...idle, gestureActive: true })).toBeNull();
    expect(cageKeyAction(key('Tab'), idle)).toEqual({ kind: 'exit' });
    expect(cageKeyAction(key('Enter'), { ...idle, gestureActive: true })).toEqual({ kind: 'commit_gesture' });
    expect(cageKeyAction(key('Enter'), idle)).toBeNull();
  });
  it('arrows change the loop count only in the loop tool; x/y/z lock the axis only mid-gesture', () => {
    expect(cageKeyAction(key('ArrowUp'), { ...idle, tool: 'loop_cut' })).toEqual({ kind: 'cuts', delta: 1 });
    expect(cageKeyAction(key('ArrowDown'), { ...idle, tool: 'loop_cut' })).toEqual({ kind: 'cuts', delta: -1 });
    expect(cageKeyAction(key('ArrowUp'), idle)).toBeNull();
    expect(cageKeyAction(key('x'), { ...idle, gestureActive: true })).toEqual({ kind: 'axis_lock', axis: 'x' });
    expect(cageKeyAction(key('x'), idle)).toBeNull();
    expect(cageKeyAction(key('z', { altKey: true }), idle)).toBeNull();
  });
});

describe('previewRunner with a rotated entity', () => {
  it('returns triangles in the entity frame whatever its placement', () => {
    const { doc, id, cage } = cube();
    const placed = execute(execute(doc, 'rotate_entity', { id, delta: [0, 0, Math.PI / 2] }).document, 'move_entities', {
      ids: [id],
      delta: [10, 0, 0],
    }).document;
    const command = gestureCommand(
      id,
      { kind: 'translate', delta: [0.1, 0, 0] },
      { ...EMPTY_CAGE_SELECTION, vertices: [cage.elementIds.vertices[0] as string] },
      DEFAULT_FALLOFF,
    );
    const preview = runCagePreview(placed, command ?? { name: 'edit_subdivision_cage', params: {} });
    const extent = Math.max(...preview.triangles.flatMap((t) => t.flatMap((p) => p.map(Math.abs))));
    expect(preview.ok).toBe(true);
    expect(extent).toBeLessThan(1.6);
  });
});
