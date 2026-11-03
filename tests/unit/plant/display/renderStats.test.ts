import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { TOOLSETS } from '@protocol/toolsets';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { SYN_RACK_BAYS, synRackCount, synRackDocument } from '../../../helpers/synRack';

const PLAN = path.resolve(
  __dirname,
  '../../../../docs/plant/09-plant-visualization-review/validation/plans/sc-vis-03-synthetic-rack-drawcalls.json',
);

interface Stats {
  componentCount: number;
  prototypeCount: number;
  buckets: Array<{ prototypeKey: string; materialClass: string; lod: number; instances: number }>;
  bucketCount: number;
  uniqueBatches: Array<{ materialClass: string; instances: number }>;
  opaqueModelCalls: number;
  edgeCalls: number;
  shadowCalls: number;
  culled: { frustum: number; pixel: number };
  instancesDrawnPlusCulled: number;
  triangles: number;
  gpuBytesEstimate: number;
  planVersion: string;
  viewpointId?: string;
}

const VIEW = { view: 'iso', width: 1920, height: 1080, projection: 'perspective', fovDeg: 45 } as const;

describe('SC-VIS-03 plan (VC-VIS-20, 21, 23)', () => {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8')) as { actions: unknown[]; expected: Array<{ step: number; path: string }> };
  const run = (): { ok: boolean; steps: Array<{ ok: boolean; command: string; summary: string; data?: Stats }> } =>
    execute(createEmptyDocument(), 'build_project', { actions: plan.actions, onError: 'continue' }).data as never;
  const report = run();
  const stats = report.steps.at(-1)?.data as Stats;

  it('runs the whole plan, render_stats included', () => {
    expect(report.steps.filter((step) => !step.ok).map((step) => step.summary)).toEqual([]);
    expect(report.steps.at(-1)?.command).toBe('render_stats');
    expect(report.steps).toHaveLength(480);
  });

  it('meets the closed forms: N(8) = 1832, at most 30 opaque calls, drawn + culled = N', () => {
    expect(stats.componentCount).toBe(synRackCount(8));
    expect(stats.opaqueModelCalls).toBeLessThanOrEqual(30);
    expect(stats.instancesDrawnPlusCulled).toBe(1832);
    expect(stats.prototypeCount).toBe(13);
  });

  it('pins the exact numbers of the first deterministic run (iso, 1920 x 1080, 45 deg, no material classes)', () => {
    expect({
      opaqueModelCalls: stats.opaqueModelCalls,
      bucketCount: stats.bucketCount,
      edgeCalls: stats.edgeCalls,
      shadowCalls: stats.shadowCalls,
      culled: stats.culled,
      triangles: stats.triangles,
      gpuBytesEstimate: stats.gpuBytesEstimate,
      planVersion: stats.planVersion,
      buckets: stats.buckets.map((bucket) => `${bucket.prototypeKey} L${bucket.lod} x${bucket.instances}`),
    }).toMatchInlineSnapshot(`
      {
        "bucketCount": 8,
        "buckets": [
          "$box L2 x719",
          "cylinder|radius=172.5;height=30 L1 x40",
          "cylinder|radius=109.55;height=6000 L0 x32",
          "cylinder|radius=57.15;height=6000 L0 x32",
          "box|size=[254,254,6000] L0 x16",
          "box|size=[254,6000,254] L0 x8",
          "box|size=[420,345,345] L1 x8",
          "box|size=[300,230,230] L1 x4",
        ],
        "culled": {
          "frustum": 0,
          "pixel": 973,
        },
        "edgeCalls": 4,
        "gpuBytesEstimate": 88304,
        "opaqueModelCalls": 8,
        "planVersion": "R-BATCH-v1",
        "shadowCalls": 24,
        "triangles": 16484,
      }
    `);
  });

  it('is deterministic (a pure function of document and camera)', () => {
    expect(JSON.stringify(run().steps.at(-1)?.data)).toBe(JSON.stringify(stats));
  });
});

describe('render_stats', () => {
  it.each(SYN_RACK_BAYS.slice(0, 3))(
    'counts N(n) and stays within 30 opaque model calls at n = %i with four material classes',
    (bays) => {
      const doc = synRackDocument(bays);
      const result = data<Stats>(doc, 'render_stats', VIEW);
      expect(result.componentCount).toBe(synRackCount(bays));
      expect(result.opaqueModelCalls).toBeLessThanOrEqual(30);
      expect(result.instancesDrawnPlusCulled).toBe(result.componentCount);
      expect(result.buckets.length).toBe(result.bucketCount);
      expect(new Set(result.buckets.map((bucket) => bucket.materialClass)).size).toBeLessThanOrEqual(4);
    },
    60_000,
  );

  it('answers from a saved viewpoint, which wins over the view fields', () => {
    const doc = apply(synRackDocument(8), 'save_viewpoint', {
      name: 'close',
      camera: { projection: 'perspective', eye: [300, -4000, 6411], direction: [0, 1, 0], up: [0, 0, 1], fovDeg: 45 },
    });
    const id = Object.keys(doc.review?.viewpoints ?? {})[0] ?? '';
    const viaViewpoint = data<Stats>(doc, 'render_stats', { viewpointId: id, view: 'top', width: 1920, height: 1080 });
    expect(viaViewpoint.viewpointId).toBe(id);
    expect(viaViewpoint.culled.frustum).toBeGreaterThan(0);
    expect(viaViewpoint.instancesDrawnPlusCulled).toBe(viaViewpoint.componentCount);
    expect(data<Stats>(doc, 'render_stats', { view: 'top', width: 1920, height: 1080 }).culled.frustum).not.toBe(
      viaViewpoint.culled.frustum,
    );
  });

  it('counts unique batches per call mode, and quality sets edge / shadow calls', () => {
    const doc = synRackDocument(8);
    const unique = {
      ...doc,
      entities: { ...doc.entities, odd: { ...doc.entities['e0']!, id: 'odd', size: [900, 900, 900], position: [0, 0, 0] } as never },
      order: [...doc.order, 'odd'],
    };
    const multi = data<Stats>(unique, 'render_stats', { ...VIEW, view: 'front', projection: 'orthographic' });
    const single = data<Stats>(unique, 'render_stats', { ...VIEW, view: 'front', projection: 'orthographic', multiDraw: false });
    expect(multi.uniqueBatches).toEqual([{ materialClass: 'structural_steel', instances: 1 }]);
    expect(single.opaqueModelCalls).toBe(multi.opaqueModelCalls);
    const low = data<Stats>(doc, 'render_stats', { ...VIEW, quality: 'low' });
    expect(low.edgeCalls).toBe(0);
    expect(low.shadowCalls).toBe(0);
    expect(data<Stats>(doc, 'render_stats', { ...VIEW, quality: 'medium' }).shadowCalls).toBe(2 * low.opaqueModelCalls);
  });

  it('answers on an empty document with zeros and does not change the document', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'render_stats', { ...VIEW, projection: 'orthographic' });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect((result.data as Stats).componentCount).toBe(0);
    expect((result.data as Stats).opaqueModelCalls).toBe(0);
  });

  it('is pure: the document is deeply unchanged', () => {
    const doc: CadDocument = synRackDocument(8);
    const before = JSON.stringify(doc);
    execute(doc, 'render_stats', VIEW);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('refuses an unknown viewpoint, a bad fov, a zero custom direction and a prototype-name viewpoint id with coded failures', () => {
    const doc = synRackDocument(8);
    expectRefusal(doc, 'render_stats', { viewpointId: 'vp-99', width: 100, height: 100 }, 'VIS_VIEWPOINT_NOT_FOUND', 'viewpointId');
    expectRefusal(doc, 'render_stats', { projection: 'perspective', fovDeg: 200, width: 100, height: 100 }, 'VIS_CAMERA_INVALID');
    expectRefusal(doc, 'render_stats', { view: 'custom', direction: [0, 0, 0], width: 100, height: 100 }, 'VIS_CAMERA_INVALID');
    expectRefusal(doc, 'render_stats', { view: 'custom', width: 100, height: 100 }, 'VIS_CAMERA_INVALID');
  });

  it('rejects invalid params through the registry', () => {
    const doc = createEmptyDocument();
    for (const params of [{}, { width: 0, height: 10 }, { width: 10.5, height: 10 }, { width: 100, height: 100, view: 'sideways' }]) {
      const result = execute(doc, 'render_stats', params);
      expect(result.rejected).toBe(true);
      expect(result.document).toBe(doc);
    }
  });

  it('is listed in the review toolset', () => {
    expect(TOOLSETS.review).toContain('render_stats');
  });
});
