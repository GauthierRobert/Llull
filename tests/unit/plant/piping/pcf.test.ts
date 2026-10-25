/**
 * Plant 02 RTE V1 part 2: the PCF writer (`export_pcf`). The reference files in tests/golden/__snapshots__ are checked by hand against the stub
 * dimensions (LR 90 A 152, NPS 4 pipe OD 114.3 x 6.02, WN flange 76 through the hub, gasket 3, tee C = M = 105): coordinates, bore, end types, the
 * elbow CENTRE-POINT = the point of intersection, the tee BRANCH1-POINT at M from the header axis.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { sha256Hex } from '@lib/sha256';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Line, routedPumpToVesselWithTee } from './rteFixtures';

interface File {
  name: string;
  content: string;
  sha256: string;
  componentCount: number;
  countsByType: Record<string, number>;
  skipped: Array<{ partId: string; reason: string }>;
  missingSkey: string[];
  bolts: Array<{ partId: string; studs: number; diameterMm: number | null }>;
  openEnds: unknown[];
}
const exported = (doc: CadDocument, params: Record<string, unknown> = {}): { files: File[]; count: number } =>
  data<{ files: File[]; count: number }>(doc, 'export_pcf', params);

/** A DN100 line from a butt-weld tie-in A at the origin facing +X: +X 3000, then +Z 2000 (open end). */
function smallLine(): { doc: CadDocument; lineId: string } {
  const line = cs150Line(100, '6001');
  const a = addTie(line.doc, 'PCF-A', [0, 0, 0], [1, 0, 0]);
  const doc = apply(a.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 3000 },
      { direction: '+Z', length: 2000 },
    ],
  });
  return { doc, lineId: line.lineId };
}

describe('export_pcf: one small line (hand-checked golden)', () => {
  const s = smallLine();

  it('matches the reference file: pipe 2848, LR 90 elbow with its CENTRE-POINT at the intersection, pipe 1848 to the open end', async () => {
    const result = exported(s.doc);
    expect(result.count).toBe(1);
    expect(result.files[0]?.name).toBe('100-P-6001-CS150.pcf');
    await expect(result.files[0]?.content).toMatchFileSnapshot('../../../golden/__snapshots__/piping_pcf_small_line.pcf');
  });

  it('structure: header in the fixed order, no TAB, lines under 1025 characters, ids 1..3, one MATERIALS block, sha256 of the text', () => {
    const file = exported(s.doc).files[0] as File;
    const lines = file.content.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      'ISOGEN-FILES ISOGEN.FLS',
      'UNITS-BORE MM',
      'UNITS-CO-ORDS MM',
      'UNITS-WEIGHT KGS',
      'UNITS-BOLT-DIA MM',
      'UNITS-BOLT-LENGTH MM',
    ]);
    expect(file.content).not.toContain('\t');
    expect(lines.every((line) => line.length <= 1024)).toBe(true);
    expect([...file.content.matchAll(/COMPONENT-IDENTIFIER (\d+)\n/g)].map((match) => match[1])).toEqual(['1', '2', '3']);
    expect(file.countsByType).toEqual({ PIPE: 2, ELBOW: 1 });
    expect(file.componentCount).toBe(3);
    expect(file.content.match(/^MATERIALS$/gm)).toHaveLength(1);
    expect(file.sha256).toBe(sha256Hex(file.content));
    expect(file.missingSkey).toEqual([]);
    expect(file.openEnds).toHaveLength(1);
  });

  it('is deterministic: the same document gives the same bytes', () => {
    expect(exported(s.doc).files[0]?.content).toBe(exported(s.doc).files[0]?.content);
  });

  it('is pure and read-only', () => {
    expectPure(s.doc, () => execute(s.doc, 'export_pcf', {}));
    expect(execute(s.doc, 'export_pcf', {}).document).toBe(s.doc);
  });

  it('lineIds selects the line; an unknown line and a line without a run are refused with a code', () => {
    expect(exported(s.doc, { lineIds: [s.lineId] }).count).toBe(1);
    expectRefusal(s.doc, 'export_pcf', { lineIds: ['line-99'] }, 'ISO_LINE_NOT_FOUND', 'lineIds');
    const empty = cs150Line(100, '6002');
    expectRefusal(empty.doc, 'export_pcf', { lineIds: [empty.lineId] }, 'ISO_NO_PIPING', 'lineIds');
    expectRefusal(empty.doc, 'export_pcf', {}, 'ISO_NO_PIPING', 'lineIds');
  });

  it('refuses a line whose run no longer derives (nothing is exported)', () => {
    const withoutSpec = { ...s.doc, plant: { ...s.doc.plant, spec: undefined } } as unknown as CadDocument;
    const result = execute(withoutSpec, 'export_pcf', {});
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toMatch(/^RTE_/);
    expect(result.document).toBe(withoutSpec);
  });
});

describe('export_pcf: a pump-to-vessel line with a valve and a tee', () => {
  const scene = routedPumpToVesselWithTee();
  const valve = apply(scene.doc, 'insert_inline_component', {
    runId: scene.runId,
    type: 'valveGate',
    tag: 'XV-1001',
    at: { leg: 3, centreDistance: 800 },
    stemDirection: [0, -1, 0],
  });

  it('writes every record kind: flanges, gaskets, bolt sets, pipes, elbows, the tee with BRANCH1-POINT, the valve with its spindle direction', async () => {
    const file = exported(valve).files[0] as File;
    expect(file.countsByType).toMatchObject({
      FLANGE: expect.any(Number),
      GASKET: expect.any(Number),
      BOLT: expect.any(Number),
      TEE: 1,
      ELBOW: 4,
      VALVE: 1,
    });
    expect(file.content).toMatch(
      /TEE\n {4}COMPONENT-IDENTIFIER \d+\n {4}UNIQUE-COMPONENT-IDENTIFIER run-[\d.]+\/tee-1\n {4}END-POINT 0\.0 1395\.0 2500\.0 100 BW\n {4}END-POINT 0\.0 1605\.0 2500\.0 100 BW\n {4}CENTRE-POINT 0\.0 1500\.0 2500\.0\n {4}BRANCH1-POINT 105\.0 1500\.0 2500\.0 100 BW\n {4}SKEY TEBW/,
    );
    expect(file.content).toContain('SPINDLE-DIRECTION SOUTH');
    expect(file.content).toMatch(
      /BOLT\n {4}COMPONENT-IDENTIFIER \d+\n {4}UNIQUE-COMPONENT-IDENTIFIER [^\n]+\n {4}ERECTION-ITEM\n {4}ITEM-CODE CS150-B-STUD-100/,
    );
    expect(file.bolts.length).toBeGreaterThanOrEqual(2);
    expect(file.bolts[0]?.studs).toBeGreaterThan(0);
    // the valve has no confirmed SKEY: it is listed, never invented
    expect(file.missingSkey.some((id) => id.includes('/valve-'))).toBe(true);
    expect(file.content).not.toMatch(/SKEY V/);
    await expect(file.content).toMatchFileSnapshot('../../../golden/__snapshots__/piping_pcf_pump_to_vessel.pcf');
  });

  it('exports the branch run in the same file (one PCF per line) after the header parts', () => {
    const file = exported(scene.doc).files[0] as File;
    const header = file.content.indexOf(`UNIQUE-COMPONENT-IDENTIFIER ${scene.runId}/tee-1`);
    expect(header).toBeGreaterThan(0);
    expect(file.content.lastIndexOf(`UNIQUE-COMPONENT-IDENTIFIER ${scene.branchRunId}/pipe-1`)).toBeGreaterThan(header);
  });

  it('every part id is unique and the item codes of the MATERIALS block are exactly the ones the records use', () => {
    const file = exported(valve).files[0] as File;
    const ids = [...file.content.matchAll(/UNIQUE-COMPONENT-IDENTIFIER (\S+)/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const [records = '', materials = ''] = file.content.split('MATERIALS\n');
    const used = new Set([...records.matchAll(/ITEM-CODE (\S+)/g)].map((match) => match[1]));
    const listed = new Set([...materials.matchAll(/^ITEM-CODE (\S+)/gm)].map((match) => match[1]));
    expect(listed).toEqual(used);
  });
});

describe('export_pcf: header attributes', () => {
  it('a hot insulated, traced line carries INSULATION-SPEC and TRACING-SPEC; the project name is the PROJECT-IDENTIFIER', () => {
    const base = cs150Line(80, '7001');
    const hot = apply(base.doc, 'update_pipeline', {
      lineId: base.lineId,
      designTempC: 180,
      insulation: { code: 'H', thickness: 'fromSpec' },
    });
    const traced = apply(hot, 'set_heat_tracing', { lineId: base.lineId, type: 'steam', tracers: 1 });
    const a = addTie(traced, 'H-A', [0, 0, 0], [1, 0, 0], { dn: 80 });
    const b = addTie(a.doc, 'H-B', [4000, 0, 0], [-1, 0, 0], { dn: 80 });
    const named = apply(b.doc, 'set_project_info', { name: 'Unit 4 Hot Oil' });
    const routed = apply(named, 'route_pipe', { lineId: base.lineId, from: { portId: a.id }, to: { portId: b.id } });
    const text = exported(routed).files[0]?.content ?? '';
    expect(text).toContain('    INSULATION-SPEC H50\n');
    expect(text).toContain('    TRACING-SPEC STEAM\n');
    expect(text).toContain('    PROJECT-IDENTIFIER Unit-4-Hot-Oil\n');
  });
});
