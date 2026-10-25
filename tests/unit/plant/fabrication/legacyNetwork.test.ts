/**
 * Plant 05 ISO M1: the legacy network (§5.3) through `export_pcf`: a building polyline pipe gets derived long-radius elbows (B16.9 centre-to-end 152.4 at DN100),
 * flagged; too-short segments, open ends, non-standard angles, level elevation; and the `export_pcf` refusals.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { legacyNetwork } from '@aec/plant/fabrication/legacyNetwork';
import type { PipingNetwork } from '@aec/plant/fabrication/model';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Document, cs150Line, addTie } from '../piping/rteFixtures';

interface File {
  name: string;
  content: string;
  componentCount: number;
  countsByType: Record<string, number>;
  source: string;
  missingSkey: string[];
  warnings: Array<{ code: string; severity: string; ids: string[] }>;
}
const files = (doc: CadDocument, params: Record<string, unknown> = {}): File[] => data<{ files: File[] }>(doc, 'export_pcf', params).files;

const SC09 = [
  [1000, 3000, 1500],
  [5000, 3000, 1500],
  [5000, 6000, 1500],
  [5000, 6000, 4000],
];

/** The CS150 document (a mm document) with a legacy pipe; returns the document and the pipe id. */
function legacy(
  points: number[][],
  extra: Record<string, unknown> = {},
  base: CadDocument = cs150Document(),
): { doc: CadDocument; pipeId: string } {
  const result = ok(base, 'add_pipe_run', { points, dn: 100, line: 'L-1', service: 'cooling water', ...extra });
  return { doc: result.document, pipeId: result.affected[0] as string };
}

const network = (doc: CadDocument, lineId = 'L-1'): Pick<PipingNetwork, 'components' | 'warnings' | 'attributes'> =>
  legacyNetwork(doc, lineId) ?? { components: [], warnings: [], attributes: {} };

describe('legacy pipe -> network: the SC-RTE-09 polyline', () => {
  const s = legacy(SC09);
  const net = network(s.doc);

  it('three pipes (3847.6, 2695.2, 2347.6) and two derived LR 90 elbows with their centre at the point of intersection', () => {
    expect(net.components.map((component) => component.type)).toEqual(['PIPE', 'ELBOW', 'PIPE', 'ELBOW', 'PIPE']);
    const [first, elbow, second, , third] = net.components;
    expect(first?.ends.map((end) => end.xyz)).toEqual([
      [1000, 3000, 1500],
      [4847.6, 3000, 1500],
    ]);
    expect(elbow).toMatchObject({ centre: [5000, 3000, 1500], skey: 'ELBW', derived: true });
    expect(elbow?.ends.map((end) => end.xyz)).toEqual([
      [4847.6, 3000, 1500],
      [5000, 3152.4, 1500],
    ]);
    const length = (component?: (typeof net.components)[number]): number =>
      Math.hypot(
        ...((component?.ends[1]?.xyz ?? [0, 0, 0]).map((v, i) => v - (component?.ends[0]?.xyz[i] ?? 0)) as [number, number, number]),
      );
    expect([length(first), length(second), length(third)].map((value) => Math.round(value * 10) / 10)).toEqual([3847.6, 2695.2, 2347.6]);
  });

  it('is flagged: one ISO_LEGACY_FITTINGS_DERIVED naming the elbows, two ISO_OPEN_END (no from / to)', () => {
    expect(net.warnings.map((warning) => warning.code).sort()).toEqual(['ISO_LEGACY_FITTINGS_DERIVED', 'ISO_OPEN_END', 'ISO_OPEN_END']);
    expect(net.warnings.find((warning) => warning.code === 'ISO_LEGACY_FITTINGS_DERIVED')?.ids).toEqual([
      `${s.pipeId}/elbow-1`,
      `${s.pipeId}/elbow-2`,
    ]);
  });

  it('export_pcf writes it: source legacy, PIPE 3 + ELBOW 2, no MATERIALS (a legacy pipe has no item codes), SKEY ELBW, derived warnings listed', () => {
    const file = files(s.doc, { lineIds: ['L-1'] })[0] as File;
    expect(file.source).toBe('legacy');
    expect(file.name).toBe('L-1.pcf');
    expect(file.countsByType).toEqual({ PIPE: 3, ELBOW: 2 });
    expect(file.missingSkey).toEqual([]);
    expect(file.content).toContain('PIPELINE-REFERENCE L-1\n    PROJECT-IDENTIFIER Untitled-project\n');
    expect(file.content).toContain('ELBOW\n    COMPONENT-IDENTIFIER 2\n');
    expect(file.content).toContain('    CENTRE-POINT 5000.0 3000.0 1500.0\n    SKEY ELBW\n');
    expect(file.content).not.toContain('MATERIALS');
    expect(file.warnings.map((warning) => warning.code)).toContain('ISO_LEGACY_FITTINGS_DERIVED');
  });

  it('read back, the preview has the same pipe lengths', () => {
    const file = files(s.doc)[0] as File;
    const preview = data<{ pipeLengthsMm: number[]; totalPipeLengthMm: number }>(createEmptyDocument(), 'import_pcf', {
      text: file.content,
      preview: true,
    });
    expect(preview.pipeLengthsMm.map((value) => Math.round(value * 10) / 10)).toEqual([3847.6, 2695.2, 2347.6]);
    expect(preview.totalPipeLengthMm).toBeCloseTo(8890.4, 6);
  });

  it('from / to on the pipe closes the open ends', () => {
    const closed = legacy(SC09, { from: 'P-101', to: 'V-101' });
    expect(network(closed.doc).warnings.map((warning) => warning.code)).toEqual(['ISO_LEGACY_FITTINGS_DERIVED']);
  });
});

describe('legacy pipe -> network: angles, short segments, levels', () => {
  it('a 45 degree turn is a derived ELBOW with the catalogue 45 degree centre-to-end (about 63 mm at DN100)', () => {
    const net = network(
      legacy([
        [0, 0, 0],
        [2000, 0, 0],
        [3414.2135623731, 1414.2135623731, 0],
      ]).doc,
    );
    const elbow = net.components.find((component) => component.type === 'ELBOW');
    expect(elbow?.skey).toBe('ELBW');
    const reach = Math.abs((elbow?.centre?.[0] ?? 0) - (elbow?.ends[0]?.xyz[0] ?? 0));
    expect(reach).toBeGreaterThan(62);
    expect(reach).toBeLessThan(64);
  });

  it('a 60 degree turn is a derived BEND without a SKEY (R x tan(30 degrees) = 88.0); strictSkey refuses it, the default lists it', () => {
    const s = legacy([
      [0, 0, 0],
      [2000, 0, 0],
      [3000, 1732.0508075689, 0],
    ]);
    const bend = network(s.doc).components.find((component) => component.type === 'BEND');
    expect(bend).toMatchObject({ derived: true });
    expect(bend?.skey).toBeUndefined();
    expect(2000 - (bend?.ends[0]?.xyz[0] ?? 0)).toBeCloseTo(152.4 * Math.tan(Math.PI / 6), 6);
    const file = files(s.doc)[0] as File;
    expect(file.missingSkey).toEqual([`${s.pipeId}/bend-1`]);
    expect(file.content).toContain('BEND\n');
    expectRefusal(s.doc, 'export_pcf', { strictSkey: true }, 'ISO_SKEY_MISSING', 'strictSkey');
  });

  it('bends closer than their centre-to-ends: ISO_SEGMENT_TOO_SHORT (error), the impossible pipe is not emitted', () => {
    const s = legacy([
      [0, 0, 0],
      [1000, 0, 0],
      [1000, 200, 0],
      [2000, 200, 0],
    ]);
    const net = network(s.doc);
    const short = net.warnings.find((warning) => warning.code === 'ISO_SEGMENT_TOO_SHORT');
    expect(short).toMatchObject({ severity: 'error', ids: [s.pipeId, `${s.pipeId}/elbow-1`, `${s.pipeId}/elbow-2`] });
    expect(net.components.map((component) => component.type)).toEqual(['PIPE', 'ELBOW', 'ELBOW', 'PIPE']);
  });

  it('bends exactly one centre-to-end apart touch: no pipe between, no finding', () => {
    const net = network(
      legacy([
        [0, 0, 0],
        [1000, 0, 0],
        [1000, 304.8, 0],
        [2000, 304.8, 0],
      ]).doc,
    );
    expect(net.components.map((component) => component.type)).toEqual(['PIPE', 'ELBOW', 'ELBOW', 'PIPE']);
    expect(net.warnings.some((warning) => warning.code === 'ISO_SEGMENT_TOO_SHORT')).toBe(false);
  });

  it('a straight vertex is not a fitting: one pipe through it', () => {
    const net = network(
      legacy([
        [0, 0, 0],
        [1000, 0, 0],
        [2000, 0, 0],
        [2000, 1000, 0],
      ]).doc,
    );
    expect(net.components.map((component) => component.type)).toEqual(['PIPE', 'ELBOW', 'PIPE']);
    expect(net.components[0]?.ends[1]?.xyz).toEqual([1847.6, 0, 0]);
  });

  it('z is the level elevation plus the point z', () => {
    const levelled = apply(cs150Document(), 'add_level', { name: 'Upper', elevation: 3000, height: 3000, makeActive: true });
    const net = network(
      legacy(
        [
          [0, 0, 500],
          [2000, 0, 500],
        ],
        {},
        levelled,
      ).doc,
    );
    expect(net.components[0]?.ends.map((end) => end.xyz[2])).toEqual([3500, 3500]);
  });

  it('a size the catalogue does not know uses 1.5 x DN (DN 123 -> 184.5) and is flagged unverified', () => {
    const net = network(
      legacy(
        [
          [0, 0, 0],
          [5000, 0, 0],
          [5000, 5000, 0],
        ],
        { dn: 123, diameter: 130 },
      ).doc,
    );
    const elbow = net.components.find((component) => component.type === 'ELBOW');
    expect(elbow?.unverified).toBe(true);
    expect(5000 - (elbow?.ends[0]?.xyz[0] ?? 0)).toBeCloseTo(184.5, 6);
  });

  it('pipes with the same line number are one network in document order; a pipe without a line number is its own line', () => {
    const first = legacy([
      [0, 0, 0],
      [1000, 0, 0],
    ]);
    const second = legacy(
      [
        [0, 1000, 0],
        [1000, 1000, 0],
      ],
      {},
      first.doc,
    );
    expect(network(second.doc).components).toHaveLength(2);
    const bare = ok(cs150Document(), 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [1000, 0, 0],
      ],
      dn: 100,
    });
    const id = bare.affected[0] as string;
    expect(files(bare.document, { lineIds: [id] })[0]?.name).toBe(`${id}.pcf`);
  });

  it('a pipe whose polyline collapses to a point has no components', () => {
    expect(
      network(
        legacy([
          [0, 0, 0],
          [0, 0, 0.01],
        ]).doc,
      ).components,
    ).toEqual([]);
  });
});

describe('export_pcf: selection and refusals', () => {
  it('an empty document has no piping; an unknown line is named', () => {
    const empty = createEmptyDocument();
    expectRefusal(empty, 'export_pcf', {}, 'ISO_NO_PIPING');
    expectRefusal(empty, 'export_pcf', { lineIds: ['nope'] }, 'ISO_LINE_NOT_FOUND', 'lineIds');
    expect(legacyNetwork(empty, 'nope')).toBeNull();
  });

  it('a routed line without a run is ISO_NO_PIPING and names the line', () => {
    const bare = cs150Line(100, '6002');
    expectRefusal(bare.doc, 'export_pcf', { lineIds: [bare.lineId] }, 'ISO_NO_PIPING', 'lineIds');
  });

  it('routed, imported and legacy lines export together, in that order; the legacy one never shadows a routed line', () => {
    const line = cs150Line(100, '6001');
    const a = addTie(line.doc, 'MX-A', [0, 0, 0], [1, 0, 0]);
    const routed = apply(a.doc, 'route_pipe', { lineId: line.lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 3000 }] });
    const withLegacy = legacy(
      [
        [0, 5000, 0],
        [2000, 5000, 0],
      ],
      { line: 'L-9' },
      routed,
    ).doc;
    const names = files(withLegacy).map((file) => file.name);
    expect(names).toEqual(['100-P-6001-CS150.pcf', 'L-9.pcf']);
    expect(files(withLegacy).map((file) => file.source)).toEqual(['route', 'legacy']);
  });

  it('is read-only: the same document comes back', () => {
    const s = legacy(SC09);
    expect(execute(s.doc, 'export_pcf', {}).document).toBe(s.doc);
  });
});
