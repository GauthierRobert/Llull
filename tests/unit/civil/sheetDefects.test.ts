import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument, type TextEntity } from '@core/model/types';
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
    const long = svgOf(doc, 'export_road_long_section', { alignmentId: id });
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
      ['export_road_long_section', { alignmentId: id }],
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
    const svg = svgOf(doc, 'export_road_long_section', { alignmentId: id, interval: 30 });
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

  it('plan-profile sheet keeps the long section clear of the title block and scale bar', () => {
    const base = surveyedDocument((x) => 100 + x / 10, 21, 20);
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
        { station: 0, elevation: 102 },
        { station: 200, elevation: 128 },
      ],
    });
    const svg = svgOf(profile.document, 'export_plan_profile_sheet', { alignmentId: id });
    const num = (tag: string, name: string): number => Number(new RegExp(`${name}="([\\d.]+)"`).exec(tag)?.[1]);
    const section = /<svg class="long-section"[^>]*>/.exec(svg)?.[0] ?? '';
    const block = /<g id="title-block"><rect[^>]*>/.exec(svg)?.[0] ?? '';
    const bar = [...(/<g id="scale-bar">.*?<\/g>/s.exec(svg)?.[0] ?? '').matchAll(/<rect[^>]*>/g)].map((m) => m[0]);
    const box = (tag: string): number[] => [
      num(tag, 'x'),
      num(tag, 'y'),
      num(tag, 'x') + num(tag, 'width'),
      num(tag, 'y') + num(tag, 'height'),
    ];
    const apart = (a: number[], b: number[]): boolean =>
      (a[2] ?? 0) <= (b[0] ?? 0) || (b[2] ?? 0) <= (a[0] ?? 0) || (a[3] ?? 0) <= (b[1] ?? 0) || (b[3] ?? 0) <= (a[1] ?? 0);
    const sectionBox = box(section.replace('<svg ', '<rect '));
    expect(bar.length).toBe(5);
    expect(apart(sectionBox, box(block))).toBe(true);
    for (const rect of bar) expect(apart(sectionBox, box(rect))).toBe(true);
  });

  it('civil plan sheet keeps pipe labels readable whatever the pipe direction', () => {
    let doc = execute(execute(createEmptyDocument(), 'set_units', { units: 'm' }).document, 'add_manhole', {
      location: [100, 0],
      invertElevation: 98,
      rimElevation: 100,
    }).document;
    doc = execute(doc, 'add_manhole', { location: [0, 0], invertElevation: 97, rimElevation: 100 }).document;
    doc = execute(doc, 'add_drainage_pipe', { fromId: 'manhole-1', toId: 'manhole-2' }).document;
    const label = doc.entities['pipe-1:label'];
    expect(label?.kind === 'text' && label.rotation[2]).toBeCloseTo(0, 9);
    const rotated = {
      ...doc,
      entities: {
        ...doc.entities,
        'pipe-1:label': { ...(label as TextEntity), rotation: [0, 0, Math.PI * 0.75] as [number, number, number] },
      },
    };
    const svg = svgOf(rotated, 'export_civil_plan_sheet', {});
    const angle = Number(/class="civil-text"[^>]*transform="rotate\((-?[\d.]+)/.exec(svg)?.[1]);
    expect(angle).toBeGreaterThan(-90);
    expect(angle).toBeLessThanOrEqual(90);
  });
});
