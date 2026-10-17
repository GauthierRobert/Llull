import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { surveyedDocument } from './fixtures';

function designedRoad(ground: (x: number, y: number) => number = () => 100): { doc: CadDocument; id: string } {
  const base = surveyedDocument(ground, 21, 20);
  const aligned = execute(base, 'add_alignment', {
    points: [
      [50, 200],
      [250, 200],
    ],
    surfaceId: 'surface-1',
  });
  const id = (aligned.data as { alignmentId: string }).alignmentId;
  const profile = execute(aligned.document, 'set_alignment_profile', {
    alignmentId: id,
    pvis: [
      { station: 0, elevation: 100 },
      { station: 200, elevation: 100 },
    ],
  });
  return { doc: execute(profile.document, 'set_road_section', { alignmentId: id }).document, id };
}

const svgOf = (doc: CadDocument, name: string, params: Record<string, unknown>): string =>
  (execute(doc, name, params).data as { svg: string }).svg;

describe('civil SVG exports', () => {
  it('plan-profile sheet has no duplicated attributes on any element', () => {
    const { doc, id } = designedRoad();
    const svg = svgOf(doc, 'export_plan_profile_sheet', { alignmentId: id });
    expect(svg).toContain('class="road-edge"');
    for (const element of svg.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      const names = [...element.matchAll(/\s([a-zA-Z:-]+)="/g)].map((m) => m[1]);
      expect(new Set(names).size, element).toBe(names.length);
    }
  });

  it('prints a real 1:N scale in the long section, cross sections and plan-profile sheet', () => {
    const { doc, id } = designedRoad();
    const long = svgOf(doc, 'export_long_section', { alignmentId: id });
    const horizontal = /Scale H 1:(\d+) {2}V 1:(\d+)/.exec(long);
    expect(Number(horizontal?.[1])).toBeGreaterThan(100);
    expect(Number(horizontal?.[2])).toBe(Math.round(Number(horizontal?.[1]) / 10));
    expect(svgOf(doc, 'export_cross_sections', { alignmentId: id })).toMatch(/scale 1:[1-9]\d* H = V/);
    const sheet = execute(doc, 'export_plan_profile_sheet', { alignmentId: id, scale: 500 });
    expect((sheet.data as { svg: string }).svg).not.toMatch(/1:0\b/);
    expect((sheet.data as { svg: string }).svg).toContain('H 1:500');
  });

  it('returns every civil drawing under data.svg (rasterizable) and keeps data.text', () => {
    const { doc, id } = designedRoad();
    for (const [name, params] of [
      ['export_long_section', { alignmentId: id }],
      ['export_cross_sections', { alignmentId: id }],
      ['export_plan_profile_sheet', { alignmentId: id }],
      ['export_civil_plan_sheet', {}],
    ] as const) {
      const data = execute(doc, name, params).data as { svg: string; text: string };
      expect(data.svg.startsWith('<svg'), name).toBe(true);
      expect(data.text).toBe(data.svg);
    }
  });

  it('export_civil_plan_sheet defaults to A3 paper', () => {
    const { doc } = designedRoad();
    const result = execute(doc, 'export_civil_plan_sheet', {});
    expect((result.data as { paper: string }).paper).toBe('A3');
    expect((result.data as { fileName: string }).fileName).toContain('_A3_');
  });

  it('long section data band keeps columns apart and off the row labels', () => {
    const { doc, id } = designedRoad();
    const svg = svgOf(doc, 'export_long_section', { alignmentId: id, interval: 30 });
    const stationCells = [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+"[^>]*text-anchor="(\w+)"[^>]*>(\d\+\d{3}\.\d{2})<\/text>/g)];
    expect(stationCells.length).toBeGreaterThan(2);
    expect(stationCells[0]?.[2]).toBe('start');
    expect(stationCells[stationCells.length - 1]?.[2]).toBe('end');
    const positions = stationCells.map((cell) => Number(cell[1]));
    for (let i = 1; i < positions.length; i++) expect((positions[i] as number) - (positions[i - 1] as number)).toBeGreaterThanOrEqual(60);
  });

  it('cross sections colour cut and fill differently and carry a legend', () => {
    const { doc, id } = designedRoad((_x, y) => 100 + (y - 200) * 0.05);
    const svg = svgOf(doc, 'export_cross_sections', { alignmentId: id, interval: 100 });
    expect(svg).toContain('fill="#e07b00" fill-opacity');
    expect(svg).toContain('fill="#2a9d5c" fill-opacity');
    expect(svg).toContain('Cut (ground above design)');
    expect(svg).toContain('Fill (ground below design)');
  });
});
