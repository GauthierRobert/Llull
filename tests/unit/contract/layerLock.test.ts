import { describe, expect, it } from 'vitest';
import { type CadDocument, DEFAULT_LAYER_ID, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { currentContext } from '@core/commands/context';
import { getCommand, listCommands } from '@core/commands/registry';
import { layerLockViolation } from '@core/commands/layerLock';

const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument => {
  const result = execute(doc, name, params);
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
};

interface Scene {
  readonly doc: CadDocument;
  readonly layer: string;
  readonly box: string;
  readonly line: string;
  readonly ring: string;
}

/** Entities on the layer "Walls" (id `layer`), then the layer is locked. */
function lockedScene(): Scene {
  let doc = createEmptyDocument();
  const layerResult = execute(doc, 'add_layer', { name: 'Walls' });
  const layer = layerResult.affected[0] ?? '';
  doc = layerResult.document;
  const ids: string[] = [];
  for (const [command, params] of [
    ['add_box', { size: [2, 2, 2] }],
    [
      'draw_polyline',
      {
        points: [
          [0, 0],
          [4, 0],
          [4, 3],
        ],
      },
    ],
    ['add_cylinder', { radius: 1, height: 2, position: [6, 0, 0] }],
  ] as const) {
    const made = execute(doc, command, params);
    const id = made.affected[0] ?? '';
    ids.push(id);
    doc = run(made.document, 'set_entity_layer', { entityId: id, layerId: layer });
  }
  doc = run(doc, 'update_layer', { id: layer, locked: true });
  return { doc, layer, box: ids[0] ?? '', line: ids[1] ?? '', ring: ids[2] ?? '' };
}

const CASES: ReadonlyArray<readonly [string, (scene: Scene) => Record<string, unknown>]> = [
  ['move_entities', (s) => ({ ids: [s.box], delta: [1, 0, 0] })],
  ['delete_entities', (s) => ({ ids: [s.box] })],
  ['duplicate_entities', (s) => ({ ids: [s.box], offset: [5, 0, 0] })],
  ['set_entity_name', (s) => ({ id: s.box, name: 'wall' })],
  ['set_entity_color', (s) => ({ entityIds: [s.box], color: '#336699' })],
  ['rotate_entity', (s) => ({ id: s.box, delta: [0, 0, 0.5] })],
  ['scale_entity', (s) => ({ id: s.box, factor: 2 })],
  ['mirror_entity', (s) => ({ id: s.box, axis: 'x' })],
  ['explode_polyline', (s) => ({ id: s.line })],
  ['offset_2d', (s) => ({ id: s.line, distance: 0.5 })],
  ['array_linear', (s) => ({ id: s.box, count: 3, offset: [3, 0, 0] })],
  ['set_entity_layer', (s) => ({ entityId: s.box, layerId: DEFAULT_LAYER_ID })],
];

describe('locked layers are enforced for every caller (FR-INT-08)', () => {
  it.each(CASES)('%s on a locked layer is refused LAYER_LOCKED and the document is unchanged', (name, params) => {
    const scene = lockedScene();
    const before = structuredClone(scene.doc);
    const result = execute(scene.doc, name, params(scene));
    if (name === 'set_entity_layer') {
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(scene.doc);
      return;
    }
    expect(result.rejected, result.summary).toBe(true);
    expect(result.error?.code).toBe('LAYER_LOCKED');
    expect(result.error?.remediation).toContain('Unlock layer Walls with update_layer first');
    expect(result.summary).toContain(scene.layer);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(scene.doc);
    expect(scene.doc).toEqual(before);
  });

  it('after update_layer unlocks the layer the same command succeeds', () => {
    const scene = lockedScene();
    expect(execute(scene.doc, 'move_entities', { ids: [scene.box], delta: [1, 0, 0] }).rejected).toBe(true);
    const unlocked = run(scene.doc, 'update_layer', { id: scene.layer, locked: false });
    const moved = execute(unlocked, 'move_entities', { ids: [scene.box], delta: [1, 0, 0] });
    expect(moved.rejected).toBeUndefined();
    expect(moved.affected).toEqual([scene.box]);
  });

  it('creating an entity on a locked layer is refused (the new entity lands on the locked default layer)', () => {
    const locked = run(createEmptyDocument(), 'update_layer', { id: DEFAULT_LAYER_ID, locked: true });
    const result = execute(locked, 'add_box', { size: [1, 1, 1] });
    expect(result.error?.code).toBe('LAYER_LOCKED');
    expect(result.document).toBe(locked);
  });

  it('plugin commands are guarded too: airfoil_from_naca and create_wing (aero surfacing) refuse a locked layer', () => {
    const locked = run(createEmptyDocument(), 'update_layer', { id: DEFAULT_LAYER_ID, locked: true });
    const airfoil = execute(locked, 'airfoil_from_naca', { designation: '0012' });
    expect(airfoil.error?.code).toBe('LAYER_LOCKED');
    expect(airfoil.document).toBe(locked);

    const profile = execute(createEmptyDocument(), 'airfoil_from_naca', { designation: '0012' });
    const airfoilId = profile.affected[0] ?? '';
    const withLayer = execute(profile.document, 'add_layer', { name: 'Skin' });
    const skin = withLayer.affected[0] ?? '';
    const frozen = run(withLayer.document, 'update_layer', { id: skin, locked: true });
    const sections = [
      { airfoilId, span: 0, chord: 2 },
      { airfoilId, span: 5, chord: 1 },
    ];
    const wing = execute(frozen, 'create_wing', { sections, layerId: skin });
    expect(wing.error?.code).toBe('LAYER_LOCKED');
    expect(wing.document).toBe(frozen);
    const open = run(frozen, 'update_layer', { id: skin, locked: false });
    expect(execute(open, 'create_wing', { sections, layerId: skin }).affected.length).toBeGreaterThan(0);
  });

  it('plugin-derived entities are exempt: add_equipment (industrial) derives its body on a locked default layer', () => {
    const locked = run(createEmptyDocument(), 'update_layer', { id: DEFAULT_LAYER_ID, locked: true });
    const result = execute(locked, 'add_equipment', { name: 'Pump', location: [0, 0], size: [1, 1, 1] });
    expect(result.error).toBeUndefined();
    expect(result.affected.length).toBeGreaterThan(0);
  });

  it('layer-management commands are exempt: locked layers can be unlocked, renamed and deleted', () => {
    const scene = lockedScene();
    const renamed = execute(scene.doc, 'update_layer', { id: scene.layer, name: 'Walls 2' });
    expect(renamed.rejected).toBeUndefined();
    const deleted = execute(scene.doc, 'delete_layer', { id: scene.layer });
    expect(deleted.rejected).toBeUndefined();
    expect(deleted.document.entities[scene.box]?.layerId).toBe(DEFAULT_LAYER_ID);
  });

  it('a history replay is not blocked (ctx.replaying)', () => {
    const scene = lockedScene();
    const params = { ids: [scene.box], delta: [1, 0, 0] };
    expect(execute(scene.doc, 'move_entities', params).rejected).toBe(true);
    const replayed = execute(scene.doc, 'move_entities', params, { ...currentContext(), replaying: true });
    expect(replayed.rejected).toBeUndefined();
    expect(replayed.affected).toEqual([scene.box]);
  });

  it('replay_history of a document with a locked layer is not blocked and changes nothing', () => {
    const scene = lockedScene();
    const result = execute(scene.doc, 'replay_history', {});
    expect(result.rejected).toBeUndefined();
    expect(result.document.entities[scene.box]).toEqual(scene.doc.entities[scene.box]);
  });

  it('a plan that unlocks the layer then edits it runs end to end (build_project steps are guarded one by one)', () => {
    const scene = lockedScene();
    const blocked = execute(scene.doc, 'build_project', {
      actions: [{ command: 'move_entities', params: { ids: [scene.box], delta: [1, 0, 0] } }],
    });
    expect(blocked.document.entities[scene.box]).toEqual(scene.doc.entities[scene.box]);
    const plan = execute(scene.doc, 'build_project', {
      actions: [
        { command: 'update_layer', params: { id: scene.layer, locked: false } },
        { command: 'move_entities', params: { ids: [scene.box], delta: [1, 0, 0] } },
      ],
    });
    expect(plan.document.entities[scene.box]?.position[0]).toBe(1);
  });

  it('every mutating command refuses an entity edit on a locked layer or is annotated layerManagement', () => {
    const exempt = listCommands()
      .filter((command) => command.annotations?.layerManagement === true)
      .map((command) => command.name);
    expect(exempt.sort()).toEqual(
      ['build_project', 'clear_document', 'delete_layer', 'load_document', 'set_entity_layer', 'update_layer'].sort(),
    );
  });
});

describe('VC-INT-19: lock guard cost', () => {
  it('stays within a few milliseconds (p95; target 1 ms, VC-INT-19 reports the number) per move_entities on a 4,000-box document with a locked layer', () => {
    let doc = run(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const seed = Object.keys(doc.entities)[0] ?? '';
    doc = run(doc, 'array_linear', { id: seed, count: 4000, offset: [2, 0, 0] });
    doc = run(doc, 'add_layer', { name: 'Frozen' });
    doc = run(doc, 'update_layer', { id: Object.keys(doc.layers).find((id) => id !== DEFAULT_LAYER_ID) ?? '', locked: true });
    const ids = Object.keys(doc.entities);
    expect(ids).toHaveLength(4000);
    const def = getCommand('move_entities');
    const context = currentContext();
    const overhead: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const moved = execute(doc, 'move_entities', { ids: [ids[i] ?? ''], delta: [0, 1, 0] });
      expect(moved.rejected).toBeUndefined();
      const started = performance.now();
      const verdict = def === undefined ? 'missing' : layerLockViolation(def, doc, moved.document, context);
      overhead.push(performance.now() - started);
      expect(verdict).toBeNull();
    }
    overhead.sort((a, b) => a - b);
    const p95 = overhead[Math.floor(overhead.length * 0.95)] ?? Infinity;
    expect(p95).toBeLessThan(5);
  });
});
