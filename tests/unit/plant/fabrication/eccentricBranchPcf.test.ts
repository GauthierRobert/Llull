/**
 * Plant 05 ISO-M6e / 02 RTE: a tee or olet downstream of an eccentric reducer sits on the shifted axis, and the PCF carries the shifted co-ordinates.
 * Hand check (CS150, NPS 6 OD 168.3 -> NPS 4 OD 114.3): eccentric offset e = (168.3 - 114.3) / 2 = 27 mm toward the flat (top = +Z).
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Line } from '../piping/rteFixtures';

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

  it('is pure', () => {
    expectPure(withTee.document, () => data(withTee.document, 'export_pcf', {}));
  });
});
