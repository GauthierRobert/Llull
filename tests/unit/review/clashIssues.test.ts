/** create_clash_issues (VIS-M5, TR-VIS-40): issues from check_clashes / check_assembly, §5.8 framing, clashKey idempotence, the human gate stays closed. */
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { clashBox, clashCamera, clashKeyOf, clashesOf } from '@core/commands/review/clashFraming';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});
const ctxOf = (): ExecutionContext => ({ ...defaultContext(), kernel });

function run(doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CadDocument {
  const result = execute(doc, name, params, ctx);
  expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
  return result.document;
}

/** Two overlapping cubes (box-1, box-2) and a distant third. */
function solids(): CadDocument {
  let doc = createEmptyDocument();
  doc = run(doc, 'add_box', { size: [20, 20, 20], position: [0, 0, 0] }, ctxOf());
  doc = run(doc, 'add_box', { size: [20, 20, 20], position: [10, 0, 0] }, ctxOf());
  return run(doc, 'add_box', { size: [20, 20, 20], position: [200, 0, 0] }, ctxOf());
}

/** A beam through a stair flight: a building clash between elements (not entity ids). */
function building(): CadDocument {
  let doc = createEmptyDocument();
  doc = run(doc, 'set_units', { units: 'mm' });
  doc = run(doc, 'add_level', { name: 'Ground', elevation: 0, height: 3500 });
  doc = run(doc, 'add_level', { name: 'Level 1', elevation: 3500, height: 3500, makeActive: false });
  doc = run(doc, 'add_stair', { start: [500, 1000], angle: 0, width: 1000, levelId: 'level-1' });
  return run(doc, 'add_beam', { start: [5650, 600], end: [5650, 1400], levelId: 'level-1', width: 300, depth: 500 });
}

interface Out {
  created: number;
  unchanged: number;
  updated: number;
  skipped: number;
  issueIds: string[];
}

describe('create_clash_issues from check_assembly', () => {
  it('opens one framed Clash issue per overlapping pair, open and unsigned', () => {
    const doc = solids();
    const result = execute(doc, 'create_clash_issues', { source: 'check_assembly' }, ctxOf());
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as Out;
    expect(data).toMatchObject({ created: 1, unchanged: 0, skipped: 0 });
    expect(result.affected).toEqual(data.issueIds);
    const review = result.document.review;
    const issue = review?.issues[data.issueIds[0] ?? ''];
    expect(issue).toMatchObject({ type: 'Clash', status: 'open', priority: 'normal', history: [], labels: ['clash', 'hard'] });
    expect(issue?.clashKey).toBe('clash:box-1.1,box-2.1|hard');
    expect(issue?.entityIds).toEqual(['box-1.1', 'box-2.1']);
    const viewpoint = review?.viewpoints[issue?.viewpointIds[0] ?? ''];
    expect(viewpoint?.selection).toEqual(['box-1.1', 'box-2.1']);
    expect(viewpoint?.camera.projection).toBe('perspective');
    expect(result.document.review?.issueOrder).toEqual(data.issueIds);
    expect(result.document.order).toEqual(doc.order);
  });

  it('frames the clash box grown by margin along the (1, -1, 1) diagonal', () => {
    const doc = solids();
    const wide = execute(doc, 'create_clash_issues', { source: 'check_assembly', margin: 5000 }, ctxOf()).document;
    const tight = execute(doc, 'create_clash_issues', { source: 'check_assembly', margin: 0 }, ctxOf()).document;
    const cameraOf = (d: CadDocument): { eye: number[]; direction: number[] } => {
      const camera = d.review?.viewpoints['vp-1']?.camera;
      return { eye: [...(camera?.eye ?? [])], direction: [...(camera?.direction ?? [])] };
    };
    const [wx = 0, wy = 0, wz = 0] = cameraOf(wide).eye;
    const [tx = 0, ty = 0, tz = 0] = cameraOf(tight).eye;
    expect(Math.hypot(wx, wy, wz)).toBeGreaterThan(Math.hypot(tx, ty, tz) * 5);
    const [sx, sy, sz] = [wx - tx, wy - ty, wz - tz];
    expect(sx).toBeCloseTo(sz, 6);
    expect(sy).toBeCloseTo(-sz, 6);
    expect(sz).toBeGreaterThan(0);
    const [dx = 0, dy = 0, dz = 0] = cameraOf(tight).direction;
    expect([dx, dy, dz].map((v) => Number(v.toFixed(9)))).toEqual([-0.577350269, 0.577350269, -0.577350269]);
  });

  it('is idempotent on clashKey: a re-run is unchanged and never touches status or history', () => {
    const first = execute(solids(), 'create_clash_issues', { source: 'check_assembly' }, ctxOf());
    const second = execute(first.document, 'create_clash_issues', { source: 'check_assembly' }, ctxOf());
    expect(second.data).toMatchObject({ created: 0, unchanged: 1, updated: 0 });
    expect(second.document).toBe(first.document);
    expect(second.affected).toEqual([]);
    const progressed = run(first.document, 'set_issue_status', { issueId: 'iss-2', status: 'in_progress', reason: 'looking' });
    const third = execute(progressed, 'create_clash_issues', { source: 'check_assembly' }, ctxOf());
    expect(third.document.review?.issues['iss-2']?.status).toBe('in_progress');
    expect(third.document.review?.issueOrder).toEqual(['iss-2']);
  });

  it('refreshes the depth in the description when the clash moved, still without a second issue', () => {
    const first = execute(solids(), 'create_clash_issues', { source: 'check_assembly' }, ctxOf());
    const moving = first.document.order[1] ?? '';
    const moved = run(first.document, 'move_entities', { ids: [moving], delta: [5, 0, 0] }, ctxOf());
    const again = execute(moved, 'create_clash_issues', { source: 'check_assembly' }, ctxOf());
    expect(again.data).toMatchObject({ created: 0, updated: 1 });
    expect(again.document.review?.issueOrder).toEqual(['iss-2']);
    expect(again.document.review?.issues['iss-2']?.description).not.toBe(first.document.review?.issues['iss-2']?.description);
  });

  it('is pure', () => {
    const doc = solids();
    const before = JSON.stringify(doc);
    execute(doc, 'create_clash_issues', { source: 'check_assembly' }, ctxOf());
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('create_clash_issues from check_clashes (building elements)', () => {
  it('frames the entities of the clashing elements and keys the issue by element ids', () => {
    const doc = building();
    const result = execute(doc, 'create_clash_issues', { source: 'check_clashes', sourceParams: { tolerance: 0 }, priority: 'high' });
    expect(result.rejected, result.summary).toBeUndefined();
    const data = result.data as Out;
    expect(data.created).toBe(1);
    const issue = result.document.review?.issues[data.issueIds[0] ?? ''];
    expect(issue?.priority).toBe('high');
    expect(issue?.clashKey).toMatch(/^clash:.+,.+\|hard$/);
    expect(issue?.entityIds.length).toBeGreaterThan(1);
    expect(issue?.entityIds.every((id) => doc.entities[id] !== undefined)).toBe(true);
    expect(issue?.description).toMatch(/hard clash .* depth [\d.]+ mm/);
  });
});

describe('create_clash_issues failures', () => {
  it('refuses a check_assembly source without a kernel (VIS_CLASH_SOURCE_INVALID)', () => {
    const doc = solids();
    const result = execute(doc, 'create_clash_issues', { source: 'check_assembly' });
    expect(result.error?.code).toBe('VIS_CLASH_SOURCE_INVALID');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('refuses a source that returns no clashes[] and an unknown source', () => {
    const doc = building();
    expect(execute(doc, 'create_clash_issues', { source: 'check_clashes', sourceParams: { levelId: 'nope' } }).error?.code).toBe(
      'VIS_CLASH_SOURCE_INVALID',
    );
    expect(execute(doc, 'create_clash_issues', { source: 'measure_volume' }).rejected).toBe(true);
  });

  it('rejects a negative margin; clashes of parts without geometry are skipped and counted', () => {
    const doc = solids();
    expect(execute(doc, 'create_clash_issues', { source: 'check_assembly', margin: -1 }, ctxOf()).error?.code).toBe('VIS_ISSUE_INVALID');
    const ghost = clashesOf(doc, 'check_clashes', { clashes: [{ a: 'ghost-1', b: 'ghost-2', kind: 'hard', depth: 3 }] });
    expect(ghost).toEqual([{ a: 'ghost-1', b: 'ghost-2', kind: 'hard', depthMm: 3 }]);
  });
});

describe('clash framing helpers', () => {
  it('reads the gap between two separated boxes when they do not overlap, and sorts the key', () => {
    const box = clashBox({ min: [0, 0, 0], max: [10, 10, 10] }, { min: [30, 5, 0], max: [40, 8, 10] });
    expect(box).toEqual({ min: [10, 5, 0], max: [30, 8, 10] });
    expect(clashKeyOf({ a: 'z', b: 'a', kind: 'hard', depthMm: 1 })).toBe('clash:a,z|hard');
    expect(clashCamera(box, 0)).toMatchObject({ projection: 'perspective', fovDeg: 45, up: [0, 0, 1] });
  });

  it('rejects malformed source data', () => {
    const doc = createEmptyDocument();
    expect(clashesOf(doc, 'check_clashes', 3)).toBeNull();
    expect(clashesOf(doc, 'check_clashes', { clashes: [{ a: 1 }] })).toBeNull();
    expect(clashesOf(doc, 'check_assembly', {})).toBeNull();
    expect(clashesOf(doc, 'check_assembly', { items: [{ code: 'FPR_PART_FLOATING', ids: ['a'] }, 3] })).toEqual([]);
  });
});
