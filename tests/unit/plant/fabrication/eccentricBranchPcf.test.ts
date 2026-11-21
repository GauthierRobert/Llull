/**
 * Plant 05 ISO-M6e / 02 RTE: a tee or olet downstream of an eccentric reducer sits on the shifted axis, and the PCF carries the shifted co-ordinates.
 * Hand check (CS150, NPS 6 OD 168.3 -> NPS 4 OD 114.3): eccentric offset e = (168.3 - 114.3) / 2 = 27 mm toward the flat (top = +Z).
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { execute } from '@core/commands/registry';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Document, cs150Line } from '../piping/rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

/** DN150 line from a tie-in at the origin: 4000 mm along +X with a 6x4 eccentric reducer at 2000 (flat on top), then a 1000 mm riser. */
function routed(): { doc: CadDocument; runId: string } {
  const line = cs150Line(150, '3001');
  const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 150 });
  const result = ok(tie.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: tie.id },
    legs: [
      { direction: '+X', length: 4000 },
      { direction: '+Z', length: 1000 },
    ],
    inline: [{ type: 'reducerEccentric', tag: 'RE-1', dn2: 100, flat: 'top', at: { leg: 0, centreDistance: 2000 } }],
  });
  return { doc: result.document, runId: (result.data as { runId: string }).runId };
}

interface PcfFile {
  content: string;
  name: string;
}

const records = (content: string, type: string): string[][] =>
  content
    .split('\n')
    .reduce<string[][]>((all, line) => {
      if (/^[A-Z]/.test(line)) all.push([line.trim()]);
      else all.at(-1)?.push(line.trim());
      return all;
    }, [])
    .filter((record) => record[0] === type);

describe('tee downstream of an eccentric reducer (branch axis on the shifted leg)', () => {
  const base = routed();
  const withTee = ok(base.doc, 'add_branch', {
    runId: base.runId,
    at: { leg: 0, distance: 3000 },
    dn: 100,
    legs: [{ direction: '+Z', length: 500 }],
  });

  it('places the tee centre and the branch outlet 27 mm above the stored axis, and the PCF says so', () => {
    expect(withTee.affected.length).toBeGreaterThan(0);
    const pcf = data<{ files: PcfFile[] }>(withTee.document, 'export_pcf', {}).files[0] as PcfFile;
    const tee = records(pcf.content, 'TEE')[0] ?? [];
    const centre = tee.find((line) => line.startsWith('CENTRE-POINT'));
    expect(centre).toBe('CENTRE-POINT 3000.0 0.0 27.0');
    const branch = tee.find((line) => line.startsWith('BRANCH1-POINT')) ?? '';
    const z = Number(branch.split(' ')[3]);
    expect(z).toBeGreaterThan(27);
    expect(branch.startsWith('BRANCH1-POINT 3000.0 0.0 ')).toBe(true);
    for (const end of tee.filter((line) => line.startsWith('END-POINT'))) expect(end.split(' ')[3]).toBe('27.0');
  });

  it('the branch pipe starts on the outlet face (shifted 27 mm along the branch) and the line has no open end besides its own ends', () => {
    const derived = deriveRun(withTee.document, piping(withTee.document).runs[base.runId] as PipeRun);
    expect(derived.ok).toBe(true);
    const tee = derived.ok ? derived.parts.find((part) => part.kind === 'tee') : undefined;
    expect(tee?.centre?.[2]).toBeCloseTo(27, 9);
    const outlet: readonly number[] = tee?.ports[2]?.position ?? [];
    const branchRunId = Object.keys(piping(withTee.document).runs).find((id) => id !== base.runId) as string;
    const branch = deriveRun(withTee.document, piping(withTee.document).runs[branchRunId] as PipeRun);
    expect(branch.ok).toBe(true);
    const pipe = branch.ok ? branch.parts.find((part) => part.kind === 'pipe') : undefined;
    expect(pipe?.ports[0]?.position[2]).toBeCloseTo(outlet[2] as number, 6);
    expect(pipe?.ports[0]?.position[0]).toBeCloseTo(3000, 6);
  });

  it('a branch perpendicular to the offset is still refused (document unchanged), and a branch before the reducer is not shifted', () => {
    expectRefusal(
      base.doc,
      'add_branch',
      { runId: base.runId, at: { leg: 0, distance: 3000 }, dn: 100, legs: [{ direction: '-Y', length: 500 }] },
      'RTE_BRANCH_ON_FITTING',
    );
    const before = ok(base.doc, 'add_branch', {
      runId: base.runId,
      at: { leg: 0, distance: 1000 },
      dn: 150,
      legs: [{ direction: '+Z', length: 500 }],
    });
    const pcf = data<{ files: PcfFile[] }>(before.document, 'export_pcf', {}).files[0] as PcfFile;
    expect(records(pcf.content, 'TEE')[0]?.find((line) => line.startsWith('CENTRE-POINT'))).toBe('CENTRE-POINT 1000.0 0.0 0.0');
  });

  it('an olet on the DN150 header after a reducer (flat top, +27) and an expander (flat bottom, +27) sits 54 mm above the stored axis', () => {
    const line = cs150Line(150, '3002');
    const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 150 });
    const header = ok(tie.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: tie.id },
      legs: [
        { direction: '+X', length: 5000 },
        { direction: '+Z', length: 1000 },
      ],
      inline: [
        { type: 'reducerEccentric', tag: 'RE-1', dn2: 100, flat: 'top', at: { leg: 0, centreDistance: 1500 } },
        { type: 'reducerEccentric', tag: 'RE-2', dn2: 150, flat: 'bottom', at: { leg: 0, centreDistance: 2500 } },
      ],
    });
    const runId = (header.data as { runId: string }).runId;
    const olet = ok(header.document, 'add_branch', {
      runId,
      at: { leg: 0, distance: 4000 },
      dn: 50,
      legs: [{ direction: '+Z', length: 500 }],
    });
    const derived = deriveRun(olet.document, piping(olet.document).runs[runId] as PipeRun);
    const part = derived.ok ? derived.parts.find((candidate) => candidate.kind === 'olet') : undefined;
    expect(part?.centre?.[2]).toBeCloseTo(54, 9);
    expect(part?.ports[0]?.position[2]).toBeCloseTo(54 + 84.15, 6);
    const pcf = data<{ files: PcfFile[] }>(olet.document, 'export_pcf', {}).files[0] as PcfFile;
    const record = records(pcf.content, 'OLET')[0] ?? [];
    expect(record.find((line) => line.startsWith('CENTRE-POINT'))).toBe('CENTRE-POINT 4000.0 0.0 54.0');
    expect(record.find((line) => line.startsWith('BRANCH1-POINT'))?.startsWith('BRANCH1-POINT 4000.0 0.0 ')).toBe(true);
    expect(Number((record.find((line) => line.startsWith('BRANCH1-POINT')) ?? '').split(' ')[3])).toBeGreaterThan(54 + 84.15);
  });

  it('add_branch downstream of the reducer is pure and reports both the shifted centre and the stored point', () => {
    const params = { runId: base.runId, at: { leg: 0, distance: 3000 }, dn: 100, legs: [{ direction: '+Z', length: 500 }] };
    expectPure(base.doc, () => execute(base.doc, 'add_branch', params));
    const out = data<{ position: number[]; storedPosition: number[] }>(base.doc, 'add_branch', params);
    expect(out.position[2]).toBeCloseTo(27, 9);
    expect(out.position[0]).toBe(3000);
    expect(out.storedPosition).toEqual([3000, 0, 0]);
  });

  it('is pure', () => {
    expectPure(withTee.document, () => data(withTee.document, 'export_pcf', {}));
  });
});

/** A DN150 header with a 6x4 eccentric reducer at 2000 and a riser; the branch tee is added at `distance` of leg 0. */
function header(flat: 'top' | 'bottom', direction: string | number[] = '+X'): { doc: CadDocument; runId: string } {
  const line = cs150Line(150, '3003');
  const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 150 });
  const result = ok(tie.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: tie.id },
    legs: [
      { direction, length: 4000 },
      { direction: '+Z', length: 1000 },
    ],
    inline: [{ type: 'reducerEccentric', tag: 'RE-1', dn2: 100, flat, at: { leg: 0, centreDistance: 2000 } }],
  });
  return { doc: result.document, runId: (result.data as { runId: string }).runId };
}

const tee = (runId: string): Record<string, unknown> => ({
  runId,
  at: { leg: 0, distance: 3000 },
  dn: 100,
  legs: [{ direction: '+Z', length: 500 }],
});

const branchRunOf = (doc: CadDocument, headerId: string): string => Object.keys(piping(doc).runs).find((id) => id !== headerId) as string;

describe('flat on the bottom, history and re-derivation', () => {
  it('a flat-bottom reducer puts the tee centre at z -27 and the branch pipe on the outlet at z 78 (hand: -27 + M 105)', () => {
    const h = header('bottom');
    const added = ok(h.doc, 'add_branch', tee(h.runId));
    const derived = deriveRun(added.document, piping(added.document).runs[h.runId] as PipeRun);
    const part = derived.ok ? derived.parts.find((candidate) => candidate.kind === 'tee') : undefined;
    expect(part?.centre?.[2]).toBeCloseTo(-27, 9);
    expect(part?.ports[2]?.position[2]).toBeCloseTo(78, 6);
    const branch = deriveRun(added.document, piping(added.document).runs[branchRunOf(added.document, h.runId)] as PipeRun);
    const pipe = branch.ok ? branch.parts.find((candidate) => candidate.kind === 'pipe') : undefined;
    expect(pipe?.ports[0]?.position[2]).toBeCloseTo(78, 6);
  });

  it('insert_inline_component upstream of an existing branch re-derives it: the outlet moves to [3000, 0, 132] and the branch pipe follows', () => {
    const line = cs150Line(150, '3004');
    const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 150 });
    const routed = ok(tie.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: tie.id },
      legs: [
        { direction: '+X', length: 4000 },
        { direction: '+Z', length: 1000 },
      ],
    });
    const runId = (routed.data as { runId: string }).runId;
    const withBranch = ok(routed.document, 'add_branch', tee(runId));
    const inserted = ok(withBranch.document, 'insert_inline_component', {
      runId,
      type: 'reducerEccentric',
      dn2: 100,
      flat: 'top',
      at: { leg: 0, centreDistance: 2000 },
    });
    const derived = deriveRun(inserted.document, piping(inserted.document).runs[runId] as PipeRun);
    const part = derived.ok ? derived.parts.find((candidate) => candidate.kind === 'tee') : undefined;
    expect(part?.ports[2]?.position).toEqual([3000, 0, 132]);
    const branch = deriveRun(inserted.document, piping(inserted.document).runs[branchRunOf(inserted.document, runId)] as PipeRun);
    const pipe = branch.ok ? branch.parts.find((candidate) => candidate.kind === 'pipe') : undefined;
    expect(pipe?.ports[0]?.position[2]).toBeCloseTo(132, 6);
  });

  it('replay_history re-mints the shifted branch identically (plant slice and entities)', () => {
    const h = header('top');
    const added = ok(h.doc, 'add_branch', tee(h.runId));
    const replayed = execute(added.document, 'replay_history', {}).document;
    expect(replayed.plant).toEqual(added.document.plant);
    expect(Object.keys(replayed.entities).sort()).toEqual(Object.keys(added.document.entities).sort());
  });

  it('the branch run counts its centreline from the shifted outlet: leg 0 is 500 - 27 = 473 mm (the shift along the branch is subtracted)', () => {
    const h = header('top');
    const added = ok(h.doc, 'add_branch', tee(h.runId));
    const runId = branchRunOf(added.document, h.runId);
    const takeoff = data<{ legs: Array<{ lengthMm: number }>; centrelineLengthMm: number }>(added.document, 'piping_takeoff', { runId });
    expect(takeoff.legs[0]?.lengthMm).toBeCloseTo(500 - 27, 6);
    expect(takeoff.centrelineLengthMm).toBeCloseTo(500 - 27, 6);
  });
});

describe('a sloped header leg', () => {
  it('a vertical branch off a 1 % sloped leg is taken up within the angle tolerance with a warning naming the residual', () => {
    const h = header('top', [1, 0, 0.01]);
    const added = ok(h.doc, 'add_branch', tee(h.runId));
    const derived = deriveRun(added.document, piping(added.document).runs[h.runId] as PipeRun);
    expect(derived.ok).toBe(true);
    const warning = derived.ok
      ? derived.warnings.find((item) => item.message.includes('sideways residual') && item.ids.length > 1)
      : undefined;
    expect(warning?.code).toBe('RTE_ECCENTRIC_OFFSET');
  });
});

describe('export -> route import', () => {
  it("llull's own PCF of a header with an eccentric reducer and a tee re-imports as a route and re-exports the same file", () => {
    const h = header('top');
    const added = ok(h.doc, 'add_branch', tee(h.runId));
    const lineId = Object.keys(piping(added.document).lines)[0] as string;
    const text = (data<{ files: PcfFile[] }>(added.document, 'export_pcf', { lineIds: [lineId] }).files[0] as PcfFile).content;
    const imported = execute(cs150Document(), 'import_pcf', { text, as: 'route', spec: 'CS150' });
    expect(imported.rejected, imported.summary).toBeUndefined();
    const again = (data<{ files: PcfFile[] }>(imported.document, 'export_pcf', {}).files[0] as PcfFile).content;
    const bare = (value: string): string => value.replace(/^ {4}UNIQUE-COMPONENT-IDENTIFIER .*\n/gm, '');
    expect(bare(again)).toBe(bare(text));
  });

  it('olets before, between and after the reducer and expander, and on the riser, re-import as a route and re-exports the same file (olet matched on the shifted axis)', () => {
    const line = cs150Line(150, '3005');
    const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 150 });
    const routedHeader = ok(tie.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: tie.id },
      legs: [
        { direction: '+X', length: 5000 },
        { direction: '+Z', length: 1000 },
      ],
      inline: [
        { type: 'reducerEccentric', tag: 'RE-1', dn2: 100, flat: 'top', at: { leg: 0, centreDistance: 1500 } },
        { type: 'reducerEccentric', tag: 'RE-2', dn2: 150, flat: 'bottom', at: { leg: 0, centreDistance: 2500 } },
      ],
    });
    const runId = (routedHeader.data as { runId: string }).runId;
    // Olets on the unshifted part (1000), between the reducer and the expander (2000, +27: a DN100 header only has an equal tee in CS150), after both (4000, +54) and on the riser after the elbow.
    const at = [
      { leg: 0, distance: 1000, direction: '+Z' },
      { leg: 0, distance: 2000, direction: '+Z', dn: 100 },
      { leg: 0, distance: 4000, direction: '+Z' },
      { leg: 1, distance: 500, direction: '+Y' },
    ];
    let added = routedHeader;
    for (const place of at)
      added = ok(added.document, 'add_branch', {
        runId,
        at: { leg: place.leg, distance: place.distance },
        dn: (place as { dn?: number }).dn ?? 50,
        legs: [{ direction: place.direction, length: 500 }],
      });
    const lineId = Object.keys(piping(added.document).lines)[0] as string;
    const text = (data<{ files: PcfFile[] }>(added.document, 'export_pcf', { lineIds: [lineId] }).files[0] as PcfFile).content;
    const centres = (content: string, type: string): string[] =>
      records(content, type)
        .map((record) => record.find((line) => line.startsWith('CENTRE-POINT')) ?? '')
        .sort();
    expect(centres(text, 'TEE')).toEqual(['CENTRE-POINT 2000.0 0.0 27.0']);
    expect(centres(text, 'OLET')).toEqual(
      ['CENTRE-POINT 1000.0 0.0 0.0', 'CENTRE-POINT 4000.0 0.0 54.0', 'CENTRE-POINT 5000.0 0.0 500.0'].sort(),
    );
    const imported = execute(cs150Document(), 'import_pcf', { text, as: 'route', spec: 'CS150' });
    expect(imported.rejected, imported.summary).toBeUndefined();
    const again = (data<{ files: PcfFile[] }>(imported.document, 'export_pcf', {}).files[0] as PcfFile).content;
    for (const type of ['TEE', 'OLET']) expect(centres(again, type)).toEqual(centres(text, type));
    // The same components with the same co-ordinates; only the order of the branch pipes (and so their numbering) differs, so compare the record sets.
    const set = (value: string): string[] =>
      value
        .replace(/^ {4}(UNIQUE-)?COMPONENT-IDENTIFIER .*\n/gm, '')
        .split(/\n(?=[A-Z])/)
        .sort();
    expect(set(again)).toEqual(set(text));
  });
});
