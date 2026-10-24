/**
 * Insulation (02 RTE §5.10, M3): the spec thickness table, the line record, the envelope diameter, the takeoff quantities and the insulation clash of
 * `check_clashes` (SC-RTE-07 numbers are hand calculations of the validation pack).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { parseSpecFile, specToFile } from '@aec/plant/spec/file';
import { createSpecLookup, isMiss } from '@aec/plant/piping/specLookup';
import { envelopeDiameter, resolveInsulation } from '@aec/plant/piping/insulation';
import { pipingErrors } from '@aec/plant/piping/validate';
import { pipingDocument } from '@aec/plant/piping/derive';
import { pipingPlugin } from '@aec/plant/piping/plugin';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Document, pumpToVessel, rteJson, routedPumpToVessel } from './rteFixtures';

const HOT = { service: 'HO', sequence: '4001', spec: 'CS150', dn: 80, designTempC: 180, insulation: { code: 'H', thickness: 'fromSpec' } };

interface Clash {
  a: string;
  b: string;
  kind: string;
  depth: number;
}
const clashes = (doc: CadDocument): Clash[] => data<{ clashes: Clash[] }>(doc, 'check_clashes', {}).clashes;

/** SC-RTE-07: DN80 hot line (180 C, insulation H from the spec) at z 3000 between two tie-ins 6000 apart, routed. */
function hotLine(): { doc: CadDocument; lineId: string; runId: string } {
  const base = cs150Document();
  const a = addTie(base, 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
  const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
  const created = ok(b.doc, 'create_pipeline', HOT);
  const lineId = created.affected[0] as string;
  const doc = apply(created.document, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } });
  return { doc, lineId, runId: doc.plant?.piping?.runOrder[0] as string };
}

const BEAM = { role: 'beam', start: [3000, -1000, 2830], end: [3000, 1000, 2830], profile: 'IPE200' };

describe('spec insulation table', () => {
  const spec = (): Record<string, unknown> => rteJson('spec_cs150.json');

  it('picks the tightest row that covers the size and the temperature: DN80 / 180 C -> 50, DN80 / 90 C -> 30, DN150 / 180 C -> 60', () => {
    const lookup = createSpecLookup(cs150Document(), 'CS150');
    if (isMiss(lookup)) throw new Error('spec missing');
    expect(lookup.insulation('H', 80, 180)).toMatchObject({ thicknessMm: 50, material: 'mineral wool', row: 'H dn<=100 T<=200C' });
    expect(lookup.insulation('H', 80, 90)).toMatchObject({ thicknessMm: 30, row: 'H dn<=100 T<=100C' });
    expect(lookup.insulation('H', 150, 180)).toMatchObject({ thicknessMm: 60, conductivityWmK: 0.0598535265 });
  });

  it('names what is missing: an unknown code (with the codes it has), a size or temperature the table does not cover', () => {
    const lookup = createSpecLookup(cs150Document(), 'CS150');
    if (isMiss(lookup)) throw new Error('spec missing');
    expect(lookup.insulation('C', 80, 20)).toMatchObject({ miss: 'RTE_SPEC_NO_COMPONENT', detail: expect.stringContaining('codes: H') });
    expect(lookup.insulation('H', 200, 100)).toMatchObject({ miss: 'RTE_SPEC_NO_COMPONENT', detail: expect.stringContaining('DN200') });
    expect(lookup.insulation('H', 80, 250)).toMatchObject({ miss: 'RTE_SPEC_NO_COMPONENT' });
  });

  it('a spec without a table says so', () => {
    const { insulation, ...bare } = spec();
    expect(insulation).toBeDefined();
    const doc = apply(cs150Document(), 'import_pipe_spec', { spec: { ...bare, id: 'NOINS' } });
    const lookup = createSpecLookup(doc, 'NOINS');
    if (isMiss(lookup)) throw new Error('spec missing');
    expect(lookup.insulation('H', 80, 100)).toMatchObject({
      miss: 'RTE_SPEC_NO_COMPONENT',
      detail: expect.stringContaining('no insulation table'),
    });
  });

  it('round-trips through the file form and rejects malformed rows with their path', () => {
    const parsed = parseSpecFile(spec());
    if (!('spec' in parsed)) throw new Error('spec file invalid');
    expect(parsed.spec.insulation).toHaveLength(3);
    const again = parseSpecFile(specToFile(parsed.spec));
    expect('spec' in again && again.spec.insulation).toEqual(parsed.spec.insulation);
    const broken = { ...spec(), insulation: [{ code: 'H', dnMax: 100, tempMaxC: 100, thicknessMm: -1, material: 'wool' }] };
    const result = parseSpecFile(broken);
    expect('issues' in result && result.issues[0]?.path).toContain('insulation');
  });

  it('resolveInsulation: explicit thickness is taken as given; fromSpec needs the design temperature', () => {
    const lookup = createSpecLookup(cs150Document(), 'CS150');
    if (isMiss(lookup)) throw new Error('spec missing');
    expect(resolveInsulation(lookup, 80, undefined, { code: 'H', thickness: 40, material: 'foam glass' })).toEqual({
      code: 'H',
      thicknessMm: 40,
      material: 'foam glass',
      source: 'explicit',
    });
    expect(resolveInsulation(lookup, 80, undefined, { code: 'H', thickness: 'fromSpec' })).toMatchObject({
      miss: 'RTE_SPEC_NO_COMPONENT',
      paths: ['designTempC'],
    });
    expect(envelopeDiameter(88.9, { thicknessMm: 50 })).toBe(188.9);
  });
});

describe('create_pipeline / update_pipeline with insulation and slope', () => {
  it('SC-RTE-07: H from the spec table is 50 mm (row named), line number 80-HO-4001-CS150-H50, envelope 188.9', () => {
    const result = ok(cs150Document(), 'create_pipeline', HOT);
    expect(result.data).toMatchObject({
      lineNumber: '80-HO-4001-CS150-H50',
      insulation: { code: 'H', thicknessMm: 50, material: 'mineral wool', source: 'spec', row: 'H dn<=100 T<=200C' },
      envelopeDiameterMm: 188.9,
    });
    expect(result.summary).toContain('spec table row H dn<=100 T<=200C');
  });

  it('refuses fromSpec without a design temperature, with an unknown code, and an unusable slope; nothing changes', () => {
    const doc = cs150Document();
    expectRefusal(doc, 'create_pipeline', { ...HOT, designTempC: undefined }, 'RTE_SPEC_NO_COMPONENT', 'designTempC');
    expectRefusal(doc, 'create_pipeline', { ...HOT, insulation: { code: 'Z', thickness: 'fromSpec' } }, 'RTE_SPEC_NO_COMPONENT');
    expectRefusal(doc, 'create_pipeline', { ...HOT, slope: { value: 120, unit: 'percent', fall: true } }, 'RTE_SLOPE_INVALID', 'slope');
    expectRefusal(doc, 'update_pipeline', { lineId: 'line-9', slope: { value: 1, unit: 'percent', fall: true } }, 'RTE_UNKNOWN_LINE');
  });

  it('update_pipeline reads the table again when the design temperature changes, keeps explicit thickness, sets and clears the slope', () => {
    const created = apply(cs150Document(), 'create_pipeline', HOT);
    const lineId = created.plant?.piping?.lineOrder[0] as string;
    const cooler = apply(created, 'update_pipeline', { lineId, designTempC: 90 });
    expect(cooler.plant?.piping?.lines[lineId]?.insulation).toMatchObject({ thicknessMm: 30, row: 'H dn<=100 T<=100C' });
    expect(cooler.plant?.piping?.lines[lineId]?.lineNumber).toBe('80-HO-4001-CS150-H30');
    const explicit = apply(created, 'update_pipeline', { lineId, insulation: { code: 'H', thickness: 75 } });
    const unchanged = apply(explicit, 'update_pipeline', { lineId, designTempC: 90 });
    expect(unchanged.plant?.piping?.lines[lineId]?.insulation).toMatchObject({ thicknessMm: 75, source: 'explicit' });
    const sloped = apply(created, 'update_pipeline', { lineId, slope: { value: 0.5, unit: 'percent', fall: true } });
    expect(sloped.plant?.piping?.lines[lineId]?.slope).toEqual({ value: 0.5, unit: 'percent', fall: true });
    expect(apply(sloped, 'update_pipeline', { lineId, slope: null }).plant?.piping?.lines[lineId]?.slope).toBeUndefined();
    expectRefusal(created, 'update_pipeline', { lineId, designTempC: 400 }, 'RTE_SPEC_NO_COMPONENT');
    expectRefusal(created, 'update_pipeline', { lineId, slope: { value: 60, unit: 'deg', fall: true } }, 'RTE_SLOPE_INVALID');
  });

  it('is pure and the stored line survives save and load', () => {
    const doc = cs150Document();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'create_pipeline', HOT);
    expect(JSON.stringify(doc)).toBe(before);
    const loaded = deserializeDocument(serializeDocument(result.document));
    expect(loaded.plant?.piping?.lines).toEqual(result.document.plant?.piping?.lines);
  });

  it('a corrupt insulation record or slope in a file is a validation error', () => {
    const doc = apply(cs150Document(), 'create_pipeline', HOT);
    const piping = JSON.parse(JSON.stringify(doc.plant?.piping)) as { lines: Record<string, Record<string, unknown>> };
    const id = Object.keys(piping.lines)[0] as string;
    (piping.lines[id] as Record<string, unknown>)['insulation'] = { code: 'H', thicknessMm: -2, source: 'spec' };
    (piping.lines[id] as Record<string, unknown>)['slope'] = { value: 500, unit: 'percent', fall: true };
    expect(pipingErrors(piping)).toEqual([expect.stringContaining('slope'), expect.stringContaining('insulation')]);
  });
});

describe('route_pipe and piping_takeoff report the insulation', () => {
  it('route_pipe data holds the insulation record and the envelope diameter; a bare line has none', () => {
    const s = hotLine();
    const run = s.doc.plant?.piping?.runs[s.runId];
    expect(run).toBeDefined();
    const bare = routedPumpToVessel().route;
    expect(bare).toMatchObject({ envelopeDiameterMm: null, insulation: null });
    const again = data<{ envelopeDiameterMm: number; insulation: { thicknessMm: number } }>(
      apply(s.doc, 'delete_pipe_run', { runId: s.runId }),
      'route_pipe',
      { lineId: s.lineId, from: { portId: s.doc.plant?.piping?.tieInOrder[0] }, to: { portId: s.doc.plant?.piping?.tieInOrder[1] } },
    );
    expect(again.envelopeDiameterMm).toBe(188.9);
    expect(again.insulation.thicknessMm).toBe(50);
  });

  it('takeoff: pipe length and the outer insulation area pi x 0.1889 m x 6 m = 3.5607 m2 on the straight DN80 run', () => {
    const s = hotLine();
    const takeoff = data<{
      insulation: Array<{ lineId: string; code: string; thicknessMm: number; pipeLengthMm: number; outerAreaM2: number; source: string }>;
    }>(s.doc, 'piping_takeoff', { runId: s.runId });
    expect(takeoff.insulation).toHaveLength(1);
    expect(takeoff.insulation[0]).toMatchObject({ lineId: s.lineId, code: 'H', thicknessMm: 50, pipeLengthMm: 6000, source: 'spec' });
    expect(takeoff.insulation[0]?.outerAreaM2).toBeCloseTo(Math.PI * 0.1889 * 6, 6);
    expect(data<{ insulation: unknown[] }>(routedPumpToVessel().doc, 'piping_takeoff', {}).insulation).toEqual([]);
  });
});

describe('check_clashes: pipe runs and their insulation', () => {
  it('SC-RTE-07: a beam that clears the bare pipe (25.55 mm) but not the insulation (24.45 mm) is one insulation clash, no hard clash', () => {
    const s = hotLine();
    const withBeam = apply(s.doc, 'add_steel_member', BEAM);
    const found = clashes(withBeam);
    expect(found.filter((clash) => clash.kind === 'hard')).toEqual([]);
    const insulation = found.filter((clash) => clash.kind === 'insulation');
    expect(insulation).toHaveLength(1);
    expect(insulation[0]?.b).toMatch(/^run-\d+(\.\d+)?\/pipe-1$/);
    // beam top 2830 + 100 = 2930; insulation bottom 3000 - 94.45 = 2905.55 -> 24.45
    expect(insulation[0]?.depth).toBeCloseTo(24.45, 6);
    expect(execute(withBeam, 'check_clashes', {}).summary).toContain('1 insulation clash(es)');
  });

  it('raising the beam into the bare pipe makes it a hard clash and the insulation clash of the same part disappears', () => {
    const s = hotLine();
    const low = apply(s.doc, 'add_steel_member', { ...BEAM, start: [3000, -1000, 2900], end: [3000, 1000, 2900] });
    const found = clashes(low);
    expect(found.map((clash) => clash.kind)).toEqual(['hard']);
    // beam top 3000, bare pipe bottom 2955.55 -> 44.45
    expect(found[0]?.depth).toBeCloseTo(44.45, 6);
  });

  it('an uninsulated line is judged on the bare pipe only, and a beam well clear reports nothing', () => {
    const bare = routedPumpToVessel();
    expect(clashes(bare.doc)).toEqual([]);
    const s = hotLine();
    const clear = apply(s.doc, 'add_steel_member', { ...BEAM, start: [3000, -1000, 2500], end: [3000, 1000, 2500] });
    expect(clashes(clear)).toEqual([]);
    const nowBare = apply(s.doc, 'update_pipeline', { lineId: s.lineId, insulation: null });
    const beam = apply(nowBare, 'add_steel_member', BEAM);
    expect(clashes(beam)).toEqual([]);
  });

  it('a run is not checked against the equipment its nozzles sit on or against the runs attached to it', () => {
    const s = pumpToVessel();
    expect(clashes(s)).toEqual([]);
    const routed = routedPumpToVessel();
    const tee = apply(routed.doc, 'add_branch', {
      runId: routed.runId,
      at: { leg: 1, distance: 1500 },
      dn: 100,
      legs: [{ direction: '+X', length: 1000 }],
    });
    expect(clashes(tee)).toEqual([]);
  });

  it('two runs of different lines crossing at one height are a hard clash between their pipe parts', () => {
    const first = hotLine();
    const bTie = addTie(first.doc, 'TP-X1', [3000, -1000, 3000], [0, 1, 0], { dn: 100 });
    const lineB = ok(bTie.doc, 'create_pipeline', { service: 'P', sequence: '5001', spec: 'CS150', dn: 100 });
    const crossed = apply(lineB.document, 'route_pipe', {
      lineId: lineB.affected[0],
      from: { portId: bTie.id },
      legs: [{ direction: '+Y', length: 2000 }],
    });
    const found = clashes(crossed);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((clash) => clash.a.includes('/pipe-') && clash.b.includes('/pipe-'))).toBe(true);
    expect(found.some((clash) => clash.kind === 'hard')).toBe(true);
  });

  it('a non-mm document and a document with no runs give no plant bodies', () => {
    const metres = apply(hotLine().doc, 'set_units', { units: 'm' });
    expect(
      clashes(apply(metres, 'add_steel_member', { ...BEAM, start: [3, -1, 2.83], end: [3, 1, 2.83] })).filter((clash) =>
        clash.a.startsWith('run-'),
      ),
    ).toEqual([]);
  });
});

describe('insulation read from the spec follows the spec', () => {
  const withTable = (doc: CadDocument, rows: unknown[] | undefined): CadDocument => {
    const spec = doc.plant?.spec;
    const latest = spec?.specs['CS150']?.[0];
    if (spec === undefined || latest === undefined) throw new Error('no spec');
    const { insulation, ...rest } = latest;
    void insulation;
    return {
      ...doc,
      plant: {
        ...doc.plant,
        spec: { ...spec, specs: { ...spec.specs, CS150: [rows === undefined ? rest : { ...latest, insulation: rows }] } },
      },
    } as CadDocument;
  };

  it('a revised table row re-reads the thickness of the spec-sourced line: the takeoff and the clash envelope follow (50 -> 55 mm)', () => {
    const s = hotLine();
    const rows = (s.doc.plant?.spec?.specs['CS150']?.[0]?.insulation ?? []).map((row) =>
      row.thicknessMm === 50 ? { ...row, thicknessMm: 55 } : row,
    );
    const edited = withTable(s.doc, rows);
    const result = pipingDocument.reconcile?.(s.doc, edited);
    const line = result?.document.plant?.piping?.lines[s.lineId];
    expect(line?.insulation).toMatchObject({ thicknessMm: 55, source: 'spec' });
    expect(result?.notes.join(' ')).toContain('50 -> 55 mm');
    expect(result?.affected).toContain(s.lineId);
    const doc = result?.document as CadDocument;
    expect(data<{ insulation: Array<{ thicknessMm: number }> }>(doc, 'piping_takeoff', {}).insulation[0]?.thicknessMm).toBe(55);
    // beam top 2930; envelope bottom 3000 - (44.45 + 55) = 2900.55 -> 29.45
    const found = clashes(apply(doc, 'add_steel_member', BEAM)).filter((clash) => clash.kind === 'insulation');
    expect(found[0]?.depth).toBeCloseTo(29.45, 6);
  });

  it('explicit thickness is left alone, an unchanged table changes nothing, and a vanished row keeps the thickness and says so', () => {
    const s = hotLine();
    const same = pipingDocument.reconcile?.(s.doc, withTable(s.doc, s.doc.plant?.spec?.specs['CS150']?.[0]?.insulation as unknown[]));
    expect(same?.notes.filter((note) => note.includes('insulation'))).toEqual([]);
    const gone = pipingDocument.reconcile?.(s.doc, withTable(s.doc, undefined));
    expect(gone?.document.plant?.piping?.lines[s.lineId]?.insulation?.thicknessMm).toBe(50);
    expect(gone?.notes.join(' ')).toContain('not re-read from the spec');
    const explicit = apply(s.doc, 'update_pipeline', { lineId: s.lineId, insulation: { code: 'H', thickness: 40 } });
    const kept = pipingDocument.reconcile?.(explicit, withTable(explicit, []));
    expect(kept?.document.plant?.piping?.lines[s.lineId]?.insulation?.thicknessMm).toBe(40);
  });

  it('the piping clash source is registered when the plugin is installed (onInstall), and registering again changes nothing', () => {
    const s = hotLine();
    const withBeam = apply(s.doc, 'add_steel_member', BEAM);
    const before = clashes(withBeam).length;
    expect(typeof pipingPlugin.onInstall).toBe('function');
    pipingPlugin.onInstall?.();
    expect(clashes(withBeam)).toHaveLength(before);
    expect(before).toBeGreaterThan(0);
  });
});

describe('edit_pipe_spec insulation rows, end to end', () => {
  const setRow = (thicknessMm: number): unknown => ({
    op: 'setInsulationRow',
    row: { code: 'H', dnMax: 100, tempMaxC: 200, thicknessMm, material: 'mineral wool', conductivityWmK: 0.0598535265 },
  });

  it('replacing the row 50 -> 55 mm refreshes the line, its number, the takeoff and the clash envelope; replay_history gives the same document', () => {
    const s = hotLine();
    const edited = ok(s.doc, 'edit_pipe_spec', { specId: 'CS150', ops: [setRow(55)] });
    expect(edited.summary).toContain('insulation re-read from the spec, 50 -> 55 mm');
    const line = edited.document.plant?.piping?.lines[s.lineId];
    expect(line?.insulation).toMatchObject({ thicknessMm: 55, source: 'spec' });
    expect(line?.lineNumber).toBe('80-HO-4001-CS150-H55');
    expect(edited.document.plant?.spec?.specs['CS150']?.[0]?.insulation).toHaveLength(3);
    expect(
      data<{ insulation: Array<{ thicknessMm: number; lineNumber: string }> }>(edited.document, 'piping_takeoff', {}).insulation[0],
    ).toMatchObject({ thicknessMm: 55, lineNumber: '80-HO-4001-CS150-H55' });
    const found = clashes(apply(edited.document, 'add_steel_member', BEAM)).filter((clash) => clash.kind === 'insulation');
    expect(found[0]?.depth).toBeCloseTo(29.45, 6);
    const replayed = execute(edited.document, 'replay_history', {}).document;
    expect(replayed.plant).toEqual(edited.document.plant);
    expect(Object.keys(replayed.entities).sort()).toEqual(Object.keys(edited.document.entities).sort());
  });

  it('keeps a material the user gave, and an explicit line number is not renumbered', () => {
    const base = cs150Document();
    const a = addTie(base, 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
    const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
    const created = ok(b.doc, 'create_pipeline', { ...HOT, insulation: { code: 'H', thickness: 'fromSpec', material: 'foam glass' } });
    const lineId = created.affected[0] as string;
    const second = ok(created.document, 'create_pipeline', { ...HOT, sequence: '4002', lineNumber: 'HOT-2' });
    const edited = ok(second.document, 'edit_pipe_spec', { specId: 'CS150', ops: [setRow(60)] });
    const lines = edited.document.plant?.piping?.lines;
    expect(lines?.[lineId]?.insulation).toMatchObject({ thicknessMm: 60, material: 'foam glass', materialExplicit: true });
    expect(lines?.[lineId]?.lineNumber).toBe('80-HO-4001-CS150-H60');
    expect(lines?.[second.affected[0] as string]).toMatchObject({
      lineNumber: 'HOT-2',
      insulation: { thicknessMm: 60, material: 'mineral wool' },
    });
    // update_pipeline's re-read keeps the material too.
    const cooler = apply(created.document, 'update_pipeline', { lineId, designTempC: 90 });
    expect(cooler.plant?.piping?.lines[lineId]?.insulation).toMatchObject({ thicknessMm: 30, material: 'foam glass' });
  });

  it('a renumbering that would collide keeps the number and says so', () => {
    const s = hotLine();
    const taken = apply(s.doc, 'create_pipeline', {
      service: 'HO',
      sequence: '4001',
      spec: 'CS150',
      dn: 80,
      lineNumber: '80-HO-4001-CS150-H55',
    });
    const edited = ok(taken, 'edit_pipe_spec', { specId: 'CS150', ops: [setRow(55)] });
    expect(edited.document.plant?.piping?.lines[s.lineId]?.lineNumber).toBe('80-HO-4001-CS150-H50');
    expect(edited.summary).toContain('number kept');
  });

  it('adds a row, removes a row, and refuses an unknown row or a malformed one with PSC_SPEC_INVALID; the document is unchanged', () => {
    const doc = cs150Document();
    const added = ok(doc, 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [{ op: 'setInsulationRow', row: { code: 'C', dnMax: 50, tempMaxC: 10, thicknessMm: 25, material: 'foam' } }],
    });
    expect(added.document.plant?.spec?.specs['CS150']?.[0]?.insulation).toHaveLength(4);
    const removed = apply(added.document, 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [{ op: 'removeInsulationRow', code: 'C', dnMax: 50, tempMaxC: 10 }],
    });
    expect(removed.plant?.spec?.specs['CS150']?.[0]?.insulation).toHaveLength(3);
    const all = apply(removed, 'edit_pipe_spec', {
      specId: 'CS150',
      ops: ['100', '200']
        .map((tempMaxC) => ({ op: 'removeInsulationRow', code: 'H', dnMax: 100, tempMaxC: Number(tempMaxC) }))
        .concat([{ op: 'removeInsulationRow', code: 'H', dnMax: 150, tempMaxC: 200 }]),
    });
    expect(all.plant?.spec?.specs['CS150']?.[0]?.insulation).toBeUndefined();
    expectRefusal(
      doc,
      'edit_pipe_spec',
      { specId: 'CS150', ops: [{ op: 'removeInsulationRow', code: 'Z', dnMax: 1, tempMaxC: 1 }] },
      'PSC_SPEC_INVALID',
      'ops.0.code',
    );
    expectRefusal(doc, 'edit_pipe_spec', { specId: 'CS150', ops: [setRow(-5)] }, 'PSC_SPEC_INVALID');
  });

  it('is pure', () => {
    const doc = cs150Document();
    const before = JSON.stringify(doc);
    execute(doc, 'edit_pipe_spec', { specId: 'CS150', ops: [setRow(70)] });
    expect(JSON.stringify(doc)).toBe(before);
  });
});
