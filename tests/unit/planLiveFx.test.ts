import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  CREATE_MS,
  MAX_ANIMATED_CHANGES,
  diffEntities,
  liveSourceLabel,
  planLiveFx,
  staggerDelay,
  type LiveFxOrigin,
} from '@ui/viewport/liveFx/planLiveFx';
import {
  easeInOutCubic,
  ghostMatrix,
  ghostOpacity,
  glowAt,
  progressAt,
  springGrow,
  transitionMatrix,
} from '@ui/viewport/liveFx/liveFxMath';

const REMOTE: LiveFxOrigin = { kind: 'remote', name: 'add_box', source: 'cli' };
const LOCAL: LiveFxOrigin = { kind: 'local' };

function run(doc: CadDocument, name: string, params: unknown): { doc: CadDocument; ids: string[] } {
  const result = execute(doc, name, params);
  return { doc: result.document, ids: [...result.affected] };
}

function withBox(): { doc: CadDocument; id: string } {
  const { doc, ids } = run(createEmptyDocument(), 'add_box', { size: [2, 2, 2], position: [0, 0, 1] });
  return { doc, id: ids[0]! };
}

describe('diffEntities', () => {
  it('classifies created, modified and removed entities by reference', () => {
    const { doc: start, id } = withBox();
    const second = run(start, 'add_sphere', { radius: 1 });
    const moved = run(second.doc, 'move_entities', { ids: [id], delta: [1, 0, 0] });
    const removed = run(moved.doc, 'delete_entities', { ids: second.ids });
    expect(diffEntities(start, second.doc).created.map((e) => e.id)).toEqual(second.ids);
    expect(diffEntities(second.doc, moved.doc).modified.map((m) => m.after.id)).toEqual([id]);
    expect(diffEntities(moved.doc, removed.doc).removed.map((e) => e.id)).toEqual(second.ids);
  });
  it('is empty when the entity bag is unchanged (selection only)', () => {
    const { doc } = withBox();
    const diff = diffEntities(doc, { ...doc, selection: [] });
    expect(diff.created.length + diff.modified.length + diff.removed.length).toBe(0);
  });
});

describe('planLiveFx', () => {
  it('grows a remotely created solid from its base, with a ripple, badge and activity entry', () => {
    const empty = createEmptyDocument();
    const { doc, ids } = run(empty, 'add_box', { size: [2, 2, 2], position: [0, 0, 1] });
    const id = ids[0]!;
    const plan = planLiveFx(empty, doc, REMOTE, 1000, 1);
    expect(plan.transitions).toEqual([
      expect.objectContaining({ id, change: 'created', tone: 'cli', startMs: 1000, durationMs: CREATE_MS }),
    ]);
    expect(plan.transitions[0]?.pivot).toEqual([0, 0, 0]);
    expect(plan.ripples).toHaveLength(1);
    expect(plan.badge?.label).toBe('CLI · add_box');
    expect(plan.badge?.anchor[2]).toBe(2);
    expect(plan.activity).toMatchObject({ name: 'add_box', source: 'cli', created: 1, modified: 0, removed: 0 });
    expect(plan.refocus).toBe(true);
  });
  it('tweens the pose of a remotely moved entity but leaves a local move alone', () => {
    const { doc, id } = withBox();
    const moved = run(doc, 'move_entities', { ids: [id], delta: [3, 0, 0] }).doc;
    expect(planLiveFx(doc, moved, REMOTE, 0, 1).transitions[0]).toMatchObject({ change: 'modified', poseTween: true });
    const local = planLiveFx(doc, moved, LOCAL, 0, 1);
    expect(local.transitions[0]).toMatchObject({ poseTween: false, tone: 'local' });
    expect(local.badge).toBeNull();
    expect(local.activity).toBeNull();
    expect(local.refocus).toBe(false);
  });
  it('shows a hologram of the previous shape when a remote edit reshapes in place', () => {
    const { doc, id } = withBox();
    const scaled = run(doc, 'scale_entity', { id, factor: 2 }).doc;
    const plan = planLiveFx(doc, scaled, REMOTE, 0, 7);
    expect(plan.ghosts).toEqual([expect.objectContaining({ mode: 'replaced', key: `ghost-7-${id}` })]);
  });
  it('dissolves removed entities as ghosts of the previous document', () => {
    const { doc, id } = withBox();
    const removed = run(doc, 'delete_entities', { ids: [id] }).doc;
    const plan = planLiveFx(doc, removed, { kind: 'snapshot' }, 0, 2);
    expect(plan.ghosts).toEqual([expect.objectContaining({ mode: 'removed', document: doc, size: 2, tone: 'snapshot' })]);
    expect(plan.ghosts[0]?.center).toEqual([0, 0, 1]);
    expect(plan.badge).toBeNull();
  });
  it('staggers a burst into a cascade bounded in time', () => {
    expect(staggerDelay(0, 1)).toBe(0);
    expect(staggerDelay(3, 10)).toBe(135);
    expect(staggerDelay(99, 100)).toBe(1400);
  });
  it('keeps only the activity entry for huge changes, and nothing for no change', () => {
    let doc = createEmptyDocument();
    const before = doc;
    doc = run(doc, 'array_linear', {}).doc; // invalid params: unchanged document
    expect(planLiveFx(before, doc, REMOTE, 0, 1).activity).toBeNull();
    const boxes = run(before, 'add_box', { size: [1, 1, 1] });
    const many = run(boxes.doc, 'array_linear', { id: boxes.ids[0], count: MAX_ANIMATED_CHANGES + 2, offset: [2, 0, 0] }).doc;
    const plan = planLiveFx(before, many, REMOTE, 0, 1);
    expect(plan.transitions).toHaveLength(0);
    expect(plan.activity?.created).toBeGreaterThan(MAX_ANIMATED_CHANGES);
  });
  it('does not refocus when the command moved the shared camera itself', () => {
    const { doc } = withBox();
    const framed = { ...run(doc, 'add_sphere', { radius: 1 }).doc, camera: { ...doc.camera, distance: 99 } };
    expect(planLiveFx(doc, framed, REMOTE, 0, 1).refocus).toBe(false);
  });
  it('labels sources with the named user when known', () => {
    expect(liveSourceLabel('mcp')).toBe('MCP agent');
    expect(liveSourceLabel('rest', 'Ed')).toBe('Ed · API');
  });
});

describe('liveFxMath', () => {
  it('clamps progress and shapes the curves', () => {
    expect(progressAt(0, 100, 200)).toBe(0);
    expect(progressAt(200, 100, 200)).toBe(0.5);
    expect(progressAt(999, 100, 200)).toBe(1);
    expect(progressAt(5, 0, 0)).toBe(1);
    expect(springGrow(0)).toBe(0);
    expect(springGrow(1)).toBe(1);
    expect(springGrow(0.29)).toBeGreaterThan(1.05);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(0.8)).toBeCloseTo(0.968);
    expect(glowAt(0)).toBe(0);
    expect(glowAt(0.12)).toBeCloseTo(1);
    expect(glowAt(1)).toBe(0);
    expect(ghostOpacity('removed', 0)).toBe(0.85);
    expect(ghostOpacity('replaced', 1)).toBe(0);
  });
  it('builds wrapper matrices that end at identity and start at the previous pose', () => {
    const { doc, id } = withBox();
    const moved = run(doc, 'move_entities', { ids: [id], delta: [4, 0, 0] }).doc;
    const transition = planLiveFx(doc, moved, REMOTE, 0, 1).transitions[0]!;
    const entity = moved.entities[id]!;
    const m = new THREE.Matrix4();
    expect(transitionMatrix(m, transition, entity, 1, false).equals(new THREE.Matrix4())).toBe(true);
    const start = new THREE.Vector3(...entity.position).applyMatrix4(transitionMatrix(m, transition, entity, 0, false));
    expect(start.toArray().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 1]);

    const created = planLiveFx(createEmptyDocument(), doc, REMOTE, 0, 1).transitions[0]!;
    const top = new THREE.Vector3(0, 0, 2).applyMatrix4(transitionMatrix(m, created, doc.entities[id]!, 0, false));
    expect(top.z).toBeCloseTo(0, 2); // collapsed onto the base pivot
    const pulse = { ...transition, poseTween: false };
    expect(transitionMatrix(m, pulse, entity, 0.5, false).getMaxScaleOnAxis()).toBeGreaterThan(1);
  });
  it('shrinks and lifts a removed ghost, swells a replaced one', () => {
    const m = new THREE.Matrix4();
    const lifted = new THREE.Vector3(0, 0, 0).applyMatrix4(ghostMatrix(m, 'removed', [0, 0, 0], 2, 1));
    expect(lifted.z).toBeCloseTo(2);
    expect(ghostMatrix(m, 'removed', [0, 0, 0], 2, 1).getMaxScaleOnAxis()).toBeCloseTo(0.55);
    expect(ghostMatrix(m, 'replaced', [0, 0, 0], 2, 1).getMaxScaleOnAxis()).toBeCloseTo(1.04);
  });
});
