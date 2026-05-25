/**
 * Unit tests for the `check_model` command and `runModelChecks` helper.
 *
 * Strategy (workflow W3):
 *  - One test per issue code: construct the minimal doc that exhibits it, assert
 *    the right severity and code appear.
 *  - Happy path: a clean doc → ok:true, issues:[].
 *  - Purity: same doc reference returned, affected:[].
 *  - `__resetIdCounter()` in beforeEach for stable ids.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { runModelChecks } from '@core/commands/check';
import type { CheckResult } from '@core/commands/check';
import { __resetIdCounter } from '@lib/id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a raw entity directly (bypassing commands) for failure-path tests. */
function injectEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

const BASE = {
  position: [0, 0, 0] as const,
  rotation: [0, 0, 0] as const,
  layerId: 'layer-default',
  color: '#ffffff',
};

// ---------------------------------------------------------------------------
// check_model — happy path
// ---------------------------------------------------------------------------

describe('check_model — clean document', () => {
  beforeEach(() => __resetIdCounter());

  it('returns ok:true for an empty document (empty-layer info does not make ok=false)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'check_model', {});
    const data = result.data as CheckResult;
    // An empty document has one empty layer → one info issue. ok is still true (no errors).
    expect(data.ok).toBe(true);
    expect(data.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('returns ok:true for a document with well-formed entities', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    doc = execute(doc, 'add_cylinder', { radius: 1, height: 3 }).document;
    doc = execute(doc, 'add_sphere', { radius: 1.5 }).document;
    const result = execute(doc, 'check_model', {});
    const data = result.data as CheckResult;
    expect(data.ok).toBe(true);
    expect(data.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('check_model — purity', () => {
  beforeEach(() => __resetIdCounter());

  it('returns the SAME doc reference and affected:[]', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    const result = execute(doc, 'check_model', {});
    expect(result.document).toBe(doc);
    expect(result.affected).toHaveLength(0);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// degenerate_size
// ---------------------------------------------------------------------------

describe('check_model — degenerate_size', () => {
  beforeEach(() => __resetIdCounter());

  it('flags a box with a zero size component', () => {
    const badBox: Entity = { ...BASE, id: 'b1', kind: 'box', size: [1, 0, 1] };
    const doc = injectEntity(createEmptyDocument(), badBox);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'degenerate_size' && i.entityId === 'b1');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags a cylinder with radius ≤ 0', () => {
    const bad: Entity = { ...BASE, id: 'c1', kind: 'cylinder', radius: -1, height: 5 };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'degenerate_size' && i.entityId === 'c1');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags a cylinder with height ≤ 0', () => {
    const bad: Entity = { ...BASE, id: 'c2', kind: 'cylinder', radius: 2, height: 0 };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'degenerate_size' && i.entityId === 'c2');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags a sphere with radius ≤ 0', () => {
    const bad: Entity = { ...BASE, id: 's1', kind: 'sphere', radius: 0 };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'degenerate_size' && i.entityId === 's1');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags an extrusion with depth ≤ 0', () => {
    const bad: Entity = { ...BASE, id: 'e1', kind: 'extrusion', profile: [[0,0],[1,0],[1,1],[0,1]], depth: 0 };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'degenerate_size' && i.entityId === 'e1');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags a circle with radius ≤ 0', () => {
    const bad: Entity = { ...BASE, id: 'ci1', kind: 'circle', center: [0, 0], radius: -2 };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'degenerate_size' && i.entityId === 'ci1');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags an arc with radius ≤ 0', () => {
    const bad: Entity = { ...BASE, id: 'a1', kind: 'arc', center: [0, 0], radius: 0, startAngle: 0, endAngle: 1 };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'degenerate_size' && i.entityId === 'a1');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags an ellipse with radiusX ≤ 0', () => {
    const bad: Entity = { ...BASE, id: 'el1', kind: 'ellipse', center: [0, 0], radiusX: 0, radiusY: 1 };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'degenerate_size' && i.entityId === 'el1');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags an ellipse with radiusY ≤ 0', () => {
    const bad: Entity = { ...BASE, id: 'el2', kind: 'ellipse', center: [0, 0], radiusX: 1, radiusY: -1 };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'degenerate_size' && i.entityId === 'el2');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('does NOT flag a well-formed box', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 2, 3] }).document;
    const { issues } = runModelChecks(doc, 1e6);
    expect(issues.filter((i) => i.code === 'degenerate_size')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// open_profile
// ---------------------------------------------------------------------------

describe('check_model — open_profile', () => {
  beforeEach(() => __resetIdCounter());

  it('flags an open polyline with a warning', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_polyline', { points: [[0,0],[1,0],[1,1]], closed: false }).document;
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'open_profile');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
  });

  it('does NOT flag a closed polyline', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_polyline', { points: [[0,0],[1,0],[1,1]], closed: true }).document;
    const { issues } = runModelChecks(doc, 1e6);
    expect(issues.filter((i) => i.code === 'open_profile')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// insufficient_points
// ---------------------------------------------------------------------------

describe('check_model — insufficient_points', () => {
  beforeEach(() => __resetIdCounter());

  it('flags a polyline with fewer than 2 points', () => {
    const bad: Entity = { ...BASE, id: 'pl1', kind: 'polyline', points: [[0, 0]], closed: false };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'insufficient_points' && i.entityId === 'pl1');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags a polyline with zero points', () => {
    const bad: Entity = { ...BASE, id: 'pl2', kind: 'polyline', points: [], closed: false };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'insufficient_points' && i.entityId === 'pl2');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('flags a spline with fewer than 2 points', () => {
    const bad: Entity = { ...BASE, id: 'sp1', kind: 'spline', points: [[0, 0]], closed: false };
    const doc = injectEntity(createEmptyDocument(), bad);
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'insufficient_points' && i.entityId === 'sp1');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
  });

  it('does NOT flag a polyline with 2 or more points', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'draw_polyline', { points: [[0,0],[1,0]] }).document;
    const { issues } = runModelChecks(doc, 1e6);
    expect(issues.filter((i) => i.code === 'insufficient_points')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// far_from_origin
// ---------------------------------------------------------------------------

describe('check_model — far_from_origin', () => {
  beforeEach(() => __resetIdCounter());

  it('flags an entity whose bounding-box center exceeds the threshold', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1], position: [2e6, 0, 0] }).document;
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'far_from_origin');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
  });

  it('does NOT flag an entity within the threshold', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] }).document;
    const { issues } = runModelChecks(doc, 1e6);
    expect(issues.filter((i) => i.code === 'far_from_origin')).toHaveLength(0);
  });

  it('respects a custom farThreshold param', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1], position: [500, 0, 0] }).document;
    // tight threshold: 100
    const result = execute(doc, 'check_model', { farThreshold: 100 });
    const data = result.data as CheckResult;
    const hit = data.issues.find((i) => i.code === 'far_from_origin');
    expect(hit).toBeDefined();
    // same entity is clean with default (1e6) threshold
    const clean = execute(doc, 'check_model', {});
    const cleanData = clean.data as CheckResult;
    expect(cleanData.issues.filter((i) => i.code === 'far_from_origin')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// empty_layer
// ---------------------------------------------------------------------------

describe('check_model — empty_layer', () => {
  beforeEach(() => __resetIdCounter());

  it('flags a layer with no entities as info', () => {
    // The empty document has 'layer-default' with no entities.
    const doc = createEmptyDocument();
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'empty_layer');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('info');
    expect(hit!.message).toContain('layer-default');
  });

  it('does NOT flag a layer that has entities', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const { issues } = runModelChecks(doc, 1e6);
    expect(issues.filter((i) => i.code === 'empty_layer')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// orphaned_group_member
// ---------------------------------------------------------------------------

describe('check_model — orphaned_group_member', () => {
  beforeEach(() => __resetIdCounter());

  it('flags a group that references a missing entity id', () => {
    const doc: CadDocument = {
      ...createEmptyDocument(),
      groups: {
        'g1': { id: 'g1', name: 'Broken Group', memberIds: ['ghost-id'] },
      },
    };
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'orphaned_group_member');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
    expect(hit!.entityId).toBe('ghost-id');
    expect(hit!.message).toContain('ghost-id');
  });

  it('does NOT flag a group whose members all exist', () => {
    let doc = createEmptyDocument();
    const a = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = a.document;
    const b = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = b.document;
    doc = execute(doc, 'group_entities', { ids: [a.affected[0]!, b.affected[0]!], name: 'Good' }).document;
    const { issues } = runModelChecks(doc, 1e6);
    expect(issues.filter((i) => i.code === 'orphaned_group_member')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parameter_error
// ---------------------------------------------------------------------------

describe('check_model — parameter_error', () => {
  beforeEach(() => __resetIdCounter());

  it('flags a parameter whose error field is set', () => {
    const doc: CadDocument = {
      ...createEmptyDocument(),
      parameters: {
        broken: { name: 'broken', expression: 'unknown_ref * 2', value: 0, error: 'unknown parameter: unknown_ref' },
      },
    };
    const { issues } = runModelChecks(doc, 1e6);
    const hit = issues.find((i) => i.code === 'parameter_error');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('error');
    expect(hit!.message).toContain('broken');
    expect(hit!.message).toContain('unknown parameter');
  });

  it('does NOT flag a parameter with no error', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'set_parameter', { name: 'width', expression: '10' }).document;
    const { issues } = runModelChecks(doc, 1e6);
    expect(issues.filter((i) => i.code === 'parameter_error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ok flag
// ---------------------------------------------------------------------------

describe('check_model — ok flag', () => {
  beforeEach(() => __resetIdCounter());

  it('ok is false when there are error-severity issues', () => {
    const bad: Entity = { ...BASE, id: 'b1', kind: 'box', size: [0, 1, 1] };
    const doc = injectEntity(createEmptyDocument(), bad);
    const data = runModelChecks(doc, 1e6);
    expect(data.ok).toBe(false);
  });

  it('ok is true when there are only warnings/info but no errors', () => {
    let doc = createEmptyDocument();
    // open polyline → warning; empty layer-default has entity now so no empty-layer info
    doc = execute(doc, 'draw_polyline', { points: [[0,0],[1,0],[1,1]], closed: false }).document;
    const data = runModelChecks(doc, 1e6);
    // no error issues
    expect(data.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(data.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// summary string
// ---------------------------------------------------------------------------

describe('check_model — summary', () => {
  beforeEach(() => __resetIdCounter());

  it('summary mentions counts when issues are present', () => {
    const bad: Entity = { ...BASE, id: 'b1', kind: 'box', size: [-1, 1, 1] };
    const doc = injectEntity(createEmptyDocument(), bad);
    const result = execute(doc, 'check_model', {});
    expect(result.summary).toContain('error');
    expect(result.summary).toContain('ok=');
  });
});
