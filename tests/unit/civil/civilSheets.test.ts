/** export_civil_plan_sheet / export_plan_profile_sheet: content, true scale, clipping, purity. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { metricDocument, surveyedDocument } from './fixtures';

interface SheetData {
  text: string;
  fileName: string;
  scale: number;
  counts: { lines: number; polylines: number; points: number; texts: number };
  layers: Array<{ name: string; count: number }>;
  clipped: number;
  fits?: boolean;
}

const flat = (): number => 100;

function site(): CadDocument {
  const base = surveyedDocument(flat, 21, 20);
  const named = execute(base, 'set_project_info', { name: 'Site <A&B>' }).document;
  const aligned = execute(named, 'add_alignment', {
    points: [
      [50, 200],
      [150, 200],
    ],
    surfaceId: 'surface-1',
  }).document;
  return execute(aligned, 'set_alignment_profile', {
    alignmentId: 'alignment-1',
    pvis: [
      { station: 0, elevation: 100 },
      { station: 100, elevation: 101 },
    ],
  }).document;
}

function sheet(doc: CadDocument, params: unknown): SheetData {
  return execute(doc, 'export_civil_plan_sheet', params).data as SheetData;
}

function polylinePoints(text: string, stroke: string): number[][][] {
  return [...text.matchAll(/<polyline class="civil-line" points="([^"]+)"[^>]*?stroke="([^"]+)"/g)]
    .filter((match) => match[2] === stroke)
    .map((match) => (match[1] ?? '').split(' ').map((pair) => pair.split(',').map(Number)));
}

describe('export_civil_plan_sheet', () => {
  it('draws title block, 1:500, north arrow, scale bar, legend and entity counts', () => {
    const doc = site();
    const result = execute(doc, 'export_civil_plan_sheet', { paper: 'A0', scale: 500 });
    const data = result.data as SheetData;
    expect(result.affected).toEqual([]);
    expect(data.scale).toBe(500);
    expect(data.fileName).toMatch(/_civil_plan_A0_1-500\.svg$/);
    for (const needle of [
      'id="title-block"',
      '1:500',
      'id="north-arrow"',
      'id="scale-bar"',
      'id="legend"',
    ]) {
      expect(data.text).toContain(needle);
    }
    expect(data.text).toContain('Site &lt;A&amp;B&gt;');
    expect(data.text).not.toContain('Site <A&B>');
    expect(data.text.match(/class="civil-point"/g)?.length).toBe(data.counts.points);
    expect(data.counts.points).toBeGreaterThan(300);
    expect(sheet(doc, { paper: 'A3', scale: 2000 }).counts.points).toBe(21 * 21);
    expect(data.counts.polylines).toBeGreaterThan(0);
    expect(data.counts.texts).toBeGreaterThan(0);
    expect(data.layers.map((layer) => layer.name)).toContain('C-ROAD-CNTR');
  });

  it('is pure', () => {
    const doc = site();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'export_civil_plan_sheet', { paper: 'A3', scale: 500 });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.document).toBe(doc);
  });

  it('draws at true scale: a 100 m centreline is 200 mm at 1:500', () => {
    const data = sheet(site(), { paper: 'A1', scale: 500, layers: ['C-ROAD-CNTR'] });
    const [run] = polylinePoints(data.text, '#d04a4a');
    expect(run).toBeDefined();
    const first = run?.[0] ?? [0, 0];
    const last = run?.[run.length - 1] ?? [0, 0];
    expect(
      Math.hypot((last[0] ?? 0) - (first[0] ?? 0), (last[1] ?? 0) - (first[1] ?? 0)),
    ).toBeCloseTo(200, 1);
    expect(data.layers.map((layer) => layer.name)).toEqual(['C-ROAD-CNTR']);
  });

  it('clips to the viewport and counts what falls outside', () => {
    const full = sheet(site(), { paper: 'A3', scale: 500 });
    const zoomed = sheet(site(), { paper: 'A3', scale: 100, center: [0, 0] });
    expect(zoomed.clipped).toBeGreaterThan(full.clipped);
    expect(zoomed.counts.points).toBeLessThan(full.counts.points);
    const viewport =
      /<clipPath id="civil-viewport"><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(
        zoomed.text,
      );
    const [x, y, w, h] = (viewport?.slice(1) ?? []).map(Number);
    for (const run of polylinePoints(zoomed.text, '#a88b63')) {
      for (const [px = 0, py = 0] of run) {
        expect(px).toBeGreaterThanOrEqual((x ?? 0) - 0.01);
        expect(px).toBeLessThanOrEqual((x ?? 0) + (w ?? 0) + 0.01);
        expect(py).toBeGreaterThanOrEqual((y ?? 0) - 0.01);
        expect(py).toBeLessThanOrEqual((y ?? 0) + (h ?? 0) + 0.01);
      }
    }
  });

  it('auto-fits the scale and adds grid ticks with grid coordinates when calibrated', () => {
    const plain = sheet(site(), { paper: 'A4' });
    expect(plain.scale).toBeGreaterThan(0);
    expect(plain.text).not.toContain('class="grid-tick"');
    const calibrated = execute(site(), 'set_site_calibration', {
      localOrigin: [0, 0],
      gridOrigin: [652000, 6862000],
      rotationDeg: 10,
    }).document;
    const data = sheet(calibrated, { paper: 'A3', scale: 500 });
    expect(data.text).toContain('class="grid-tick"');
    expect(data.text).toMatch(/E 652\d{3}\s+N 686\d{4}/);
  });

  it('fails without civil entities, bad scale or unknown layers', () => {
    const empty = metricDocument();
    for (const [doc, params] of [
      [empty, { paper: 'A3' }],
      [site(), { paper: 'A3', scale: 0 }],
      [site(), { paper: 'A3', layers: ['NOPE'] }],
    ] as const) {
      const result = execute(doc, 'export_civil_plan_sheet', params);
      expect(result.data).toBeUndefined();
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
  });
});

describe('export_plan_profile_sheet', () => {
  it('combines the plan strip and the long section with aligned stations', () => {
    const doc = site();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'export_plan_profile_sheet', {
      alignmentId: 'alignment-1',
      paper: 'A3',
      scale: 500,
      verticalExaggeration: 5,
    });
    const data = result.data as SheetData;
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.affected).toEqual([]);
    for (const needle of [
      'id="title-block"',
      '1:500',
      'id="north-arrow"',
      'class="long-section"',
      'Long section',
    ]) {
      expect(data.text).toContain(needle);
    }
    expect(data.text).toContain('PLAN - ');
    expect(data.text).toContain('0+000.00');
    const ticks = [...data.text.matchAll(/class="station-tick" x1="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks[0]).toBeCloseTo(24 + 90 * 0.25, 1);
    const interval = (
      execute(doc, 'describe_civil', {}).document.civil?.objects['alignment-1'] as {
        stationInterval: number;
      }
    ).stationInterval;
    const spacing = (ticks[1] ?? 0) - (ticks[0] ?? 0);
    expect(spacing / (interval * 2)).toBeCloseTo(Math.round(spacing / (interval * 2)), 2);
    expect(data.fileName).toMatch(/_plan_profile_A3_1-500\.svg$/);
    expect(data.fits).toBe(true);
  });

  it('auto-fits the scale and fails on unknown alignment, missing profile or bad numbers', () => {
    const doc = site();
    expect(
      (execute(doc, 'export_plan_profile_sheet', { alignmentId: 'alignment-1' }).data as SheetData)
        .scale,
    ).toBeGreaterThan(0);
    const bare = execute(surveyedDocument(flat, 21, 20), 'add_alignment', {
      points: [
        [50, 200],
        [150, 200],
      ],
    }).document;
    for (const [target, params] of [
      [doc, { alignmentId: 'nope' }],
      [bare, { alignmentId: 'alignment-1' }],
      [doc, { alignmentId: 'alignment-1', scale: -5 }],
      [doc, { alignmentId: 'alignment-1', verticalExaggeration: 0 }],
    ] as const) {
      const result = execute(target, 'export_plan_profile_sheet', params);
      expect(result.data).toBeUndefined();
      expect(result.document).toBe(target);
    }
  });
});
