/**
 * Plant 01 PSC / 02 RTE / 05 ISO: the spectacle (figure-8) blind as a catalogue component type. The row is a DECLARED TEST INPUT (a user-imported catalogue; the bundled
 * catalogue has no spectacle blind and none of these numbers is a standard's value): thickness 20, closed disc 228.6, open ring 168.3, web 60, handle 150.
 * Hand calculation, DN100 CL150 (weld-neck flange Y = 76, spiral-wound gasket 3 mm): the blind centred at 2000 on a +X leg, state closed:
 * plate faces x 1990 / 2010, gaskets 1987..1990 and 2010..2013, flange faces 1987 / 2013, flange backs 1911 / 2089 (occupies 2 x 89 = 178 mm).
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { documentProjection } from '@core/plugins/host';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { pipingClashBodies } from '@aec/plant/piping/clashBodies';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { pipingErrors } from '@aec/plant/piping/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { extrasDocument } from '../fabrication/routeExtraFixtures';

const cite = { citation: 'declared test input, not from a standard (spectacle blind)' };
const spectacleCatalog = {
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'test-spectacle',
  licence: 'company-proprietary',
  families: [
    {
      id: 'spectacle-rf',
      type: 'spectacleBlind',
      standard: 'company test table',
      ends: ['FL'],
      unit: 'mm',
      sizes: [
        {
          nps: 4,
          class: 150,
          facing: 'RF',
          thickness: 20,
          discDiameterClosed: 228.6,
          discDiameterOpen: 168.3,
          webLength: 60,
          handleLength: 150,
          provenance: cite,
        },
      ],
    },
  ],
};

/** CS150 + test cap / blind catalogue + the spectacle blind catalogue named in the spec with a DN100 CL150 RF component (`row` false: no catalogue). */
function spectacleDocument(row = true, withoutDim?: string): CadDocument {
  if (!row) return extrasDocument();
  const catalog = JSON.parse(JSON.stringify(spectacleCatalog)) as typeof spectacleCatalog;
  if (withoutDim !== undefined) delete (catalog.families[0]?.sizes[0] as Record<string, unknown>)[withoutDim];
  const doc = apply(extrasDocument(), 'import_piping_catalog', { catalog });
  const spec = doc.plant?.spec?.specs['CS150']?.at(-1);
  return apply(doc, 'edit_pipe_spec', {
    specId: 'CS150',
    ops: [
      { op: 'setHeader', fields: { catalogs: [...(spec?.catalogs ?? []), 'test-spectacle'] } },
      {
        op: 'addComponent',
        component: { id: 'SPB', type: 'spectacleBlind', fromNps: 4, toNps: 4, facing: 'RF', class: 150, catalogRef: 'spectacle-rf' },
      },
    ],
  });
}

function openRun(base: CadDocument): { doc: CadDocument; runId: string; lineId: string } {
  const created = ok(base, 'create_pipeline', { service: 'P', sequence: '3301', spec: 'CS150', dn: 100 });
  const lineId = created.affected[0] as string;
  const routed = ok(created.document, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs: [{ direction: '+X', length: 5000 }] });
  return { doc: routed.document, runId: routed.affected[0] as string, lineId };
}

const runOf = (doc: CadDocument, runId: string): PipeRun => (doc.plant?.piping as PipingModel).runs[runId] as PipeRun;
const derivedOf = (doc: CadDocument, runId: string): Extract<ReturnType<typeof deriveRun>, { ok: true }> => {
  const derived = deriveRun(doc, runOf(doc, runId));
  if (!derived.ok) throw new Error(derived.message);
  return derived;
};
const insert = (state?: 'open' | 'closed'): Record<string, unknown> => ({
  type: 'spectacleBlind',
  tag: 'SB-1',
  at: { leg: 0, centreDistance: 2000 },
  ...(state === undefined ? {} : { state }),
});
const withBlind = (state?: 'open' | 'closed'): { doc: CadDocument; runId: string; lineId: string } => {
  const base = openRun(spectacleDocument());
  const result = ok(base.doc, 'insert_inline_component', { runId: base.runId, ...insert(state) });
  return { ...base, doc: result.document };
};

describe('spectacleBlind inline between two flanges', () => {
  it('places flange, gasket, plate, gasket, flange: faces 1990 / 2010, flange faces 1987 / 2013 (hand)', () => {
    const { doc, runId } = withBlind();
    const derived = derivedOf(doc, runId);
    const plate = derived.parts.find((part) => part.typeKey === 'spectacleBlind');
    expect(plate?.kind).toBe('inline');
    expect(plate?.state).toBe('closed');
    expect(plate?.tag).toBe('SB-1');
    expect(plate?.ports.map((port) => port.position[0])).toEqual([expect.closeTo(1990, 9), expect.closeTo(2010, 9)]);
    expect(derived.parts.filter((part) => part.kind === 'gasket')).toHaveLength(2);
    expect(derived.parts.filter((part) => part.kind === 'boltSet')).toHaveLength(1);
    const flanges = derived.parts.filter((part) => part.kind === 'flange');
    expect(flanges).toHaveLength(2);
    const faces = flanges
      .map((flange) => flange.ports.find((port) => port.endType === 'FL')?.position[0])
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(faces).toEqual([expect.closeTo(1987, 9), expect.closeTo(2013, 9)]);
    const inline = derived.inline.find((item) => item.type === 'spectacleBlind');
    expect(inline?.state).toBe('closed');
    expect(inline?.lengthMm).toBeCloseTo(26, 9);
    const joint = derived.joints.find((candidate) => candidate.accessories?.includes(plate?.id as string));
    expect(joint?.kind).toBe('flanged');
    expect(joint?.accessories).toHaveLength(4);
    expect(derived.legs[0]?.cutLengthsMm).toHaveLength(2);
  });

  it('stores the state (default closed) and re-derives it: open draws the ring in the line', () => {
    const open = withBlind('open');
    expect(runOf(open.doc, open.runId).inline?.[0]?.state).toBe('open');
    expect(derivedOf(open.doc, open.runId).parts.find((part) => part.typeKey === 'spectacleBlind')?.state).toBe('open');
    expect(runOf(withBlind().doc, open.runId).inline?.[0]?.state).toBe('closed');
    const entities = Object.values(open.doc.entities).filter((entity) => entity.id.includes('/inline-'));
    expect(entities.map((entity) => entity.id).some((id) => id.endsWith('/spare'))).toBe(true);
  });

  it('refuses by name when the spec has no spectacle blind row, or the row lacks a dimension (document unchanged)', () => {
    const base = openRun(spectacleDocument(false));
    const none = expectRefusal(base.doc, 'insert_inline_component', { runId: base.runId, ...insert() }, 'RTE_SPEC_NO_COMPONENT');
    expect(none.document).toBe(base.doc);
    expect(none.summary).toContain('spectacle blind');
    const thin = openRun(spectacleDocument(true, 'webLength'));
    const lacking = expectRefusal(thin.doc, 'insert_inline_component', { runId: thin.runId, ...insert() }, 'RTE_SPEC_NO_COMPONENT');
    expect(lacking.summary).toContain('webLength');
    expectRefusal(
      base.doc,
      'route_pipe',
      {
        lineId: base.lineId,
        from: { point: [0, 3000, 0] },
        legs: [{ direction: '+X', length: 4000 }],
        inline: [{ ...insert(), at: { leg: 0, centreDistance: 2000 } }],
      },
      'RTE_SPEC_NO_COMPONENT',
    );
  });

  it('refuses a state on another type, and an inline spectacle blind that does not fit', () => {
    const base = openRun(spectacleDocument());
    expectRefusal(
      base.doc,
      'insert_inline_component',
      { runId: base.runId, type: 'valveGate', at: { leg: 0, centreDistance: 2000 }, state: 'open' },
      'RTE_SIZE_MISMATCH',
    );
    expect(
      execute(base.doc, 'insert_inline_component', { runId: base.runId, ...insert(), at: { leg: 0, centreDistance: 20 } }).rejected,
    ).toBe(true);
  });

  it('route_pipe takes it inline in one call, is pure, and survives a save / load and replay_history', () => {
    const base = spectacleDocument();
    const line = ok(base, 'create_pipeline', { service: 'P', sequence: '3302', spec: 'CS150', dn: 100 });
    const params = {
      lineId: line.affected[0],
      from: { point: [0, 0, 0] },
      legs: [{ direction: '+X', length: 5000 }],
      inline: [insert('open')],
    };
    expectPure(line.document, () => execute(line.document, 'route_pipe', params));
    const routed = ok(line.document, 'route_pipe', params);
    const runId = routed.affected[0] as string;
    expect(pipingErrors(routed.document.plant?.piping)).toEqual([]);
    const loaded = deserializeDocument(serializeDocument(routed.document));
    expect(loaded.plant).toEqual(routed.document.plant);
    expect(derivedOf(loaded, runId).parts.find((part) => part.typeKey === 'spectacleBlind')?.state).toBe('open');
    const replayed = execute(routed.document, 'replay_history', {}).document;
    expect(replayed.plant).toEqual(routed.document.plant);
  });

  it('is counted in the takeoff, listed as skipped (no PCF keyword) with its flanges and gaskets written, and exported as IFCPIPEFITTING .OBSTRUCTION.', () => {
    const { doc, lineId } = withBlind();
    const counts = (ok(doc, 'piping_takeoff', {}).data as { counts: Record<string, number> }).counts;
    expect(counts['spectacleBlind']).toBe(1);
    expect(counts['flangedJoints']).toBe(1);
    type Pcf = { files: Array<{ content: string; skipped: Array<{ reason: string }> }> };
    const file = data<Pcf>(doc, 'export_pcf', { lineIds: [lineId] }).files[0];
    expect(file?.content).not.toContain('SPECTACLE');
    expect(file?.skipped.map((entry) => entry.reason).join(' ')).toContain('spectacle blind (closed) has no PCF component');
    expect((file?.content ?? '').split('FLANGE\n').length - 1).toBe(2);
    expect((file?.content ?? '').split('GASKET\n').length - 1).toBe(2);
    type Ifc = { ifc: string; piping: { productCount: number } };
    const [before, after] = [data<Ifc>(openRun(spectacleDocument()).doc, 'export_ifc', {}), data<Ifc>(doc, 'export_ifc', {})];
    // two flanges, two gaskets, the plate and one more pipe piece (the leg is cut in two)
    expect(after.piping.productCount - before.piping.productCount).toBe(6);
    expect(after.ifc.split('.OBSTRUCTION.').length - 1).toBe(1);
    expect(after.ifc).toContain("'spectacleBlind'");
  });

  it('has a BCF IfcGuid for the plate entity and its spare disc (both in the one IFC product)', () => {
    const { doc } = withBlind();
    const ids = Object.keys(doc.entities).filter((id) => id.includes('/inline-'));
    const project = documentProjection('ifcGuids');
    const guids = ids.map((id) => project?.(doc, id, 'IFC4') ?? []);
    expect(ids.length).toBe(2);
    expect(guids[0]).toHaveLength(1);
    expect(guids[1]).toEqual(guids[0]);
  });

  it('is a clash body: a solid box of the larger disc (228.6) and the plate thickness (20) about the pipe axis', () => {
    const { doc } = withBlind();
    const body = pipingClashBodies(doc).find((candidate) => candidate.id.includes('/inline-') && candidate.kind === 'solid');
    expect(body).toBeDefined();
    expect(JSON.stringify(body?.box)).toContain('114.3');
  });
});

describe('spectacleBlind as a run end closure', () => {
  it('set_run_end_cap closure spectacleBlind closes the end (outer face at the run end), state kept; cap false removes it', () => {
    const { doc, runId } = openRun(spectacleDocument());
    const closed = ok(doc, 'set_run_end_cap', { runId, end: 'end', closure: 'spectacleBlind', state: 'open' });
    expect(closed.data).toMatchObject({ closure: 'spectacleBlind', state: 'open', capLengthMm: 20 });
    expect(runOf(closed.document, runId).end).toMatchObject({ spectacle: 'open' });
    const plate = derivedOf(closed.document, runId).parts.find((part) => part.typeKey === 'spectacleBlind');
    expect(plate?.state).toBe('open');
    expect(plate?.centre?.[0]).toBe(5000);
    expect(plate?.ports[0]?.position[0]).toBeCloseTo(4980, 9);
    const again = execute(closed.document, 'set_run_end_cap', { runId, end: 'end', closure: 'spectacleBlind', state: 'open' });
    expect(again.affected).toEqual([]);
    const flipped = ok(closed.document, 'set_run_end_cap', { runId, end: 'end', closure: 'spectacleBlind' });
    expect(runOf(flipped.document, runId).end).toMatchObject({ spectacle: 'closed' });
    const open = ok(flipped.document, 'set_run_end_cap', { runId, end: 'end', cap: false });
    expect(runOf(open.document, runId).end).toEqual(runOf(doc, runId).end);
    const blind = ok(closed.document, 'set_run_end_cap', { runId, end: 'end', closure: 'blindFlange' });
    expect(runOf(blind.document, runId).end.spectacle).toBeUndefined();
  });

  it('route_pipe startClosure / endClosure spectacleBlind with states; a state without the closure, a port end or a spec without the row is refused', () => {
    const base = spectacleDocument();
    const line = ok(base, 'create_pipeline', { service: 'P', sequence: '3303', spec: 'CS150', dn: 100 });
    const lineId = line.affected[0] as string;
    const params = {
      lineId,
      from: { point: [0, 0, 0] },
      legs: [{ direction: '+X', length: 5000 }],
      startClosure: 'spectacleBlind',
      endClosure: 'spectacleBlind',
      endState: 'open',
    };
    expectPure(line.document, () => execute(line.document, 'route_pipe', params));
    const routed = ok(line.document, 'route_pipe', params);
    const run = runOf(routed.document, routed.affected[0] as string);
    expect(run.start).toMatchObject({ spectacle: 'closed' });
    expect(run.end).toMatchObject({ spectacle: 'open' });
    expect(routed.data).toMatchObject({ closures: { start: 'spectacleBlind', startState: 'closed', endState: 'open' } });
    expect(pipingErrors(routed.document.plant?.piping)).toEqual([]);
    expectRefusal(
      line.document,
      'route_pipe',
      { ...params, startClosure: undefined, startState: 'open', endClosure: 'cap' },
      'RTE_CAP_INVALID',
    );
    expectRefusal(
      routed.document,
      'set_run_end_cap',
      { runId: routed.affected[0] as string, end: 'end', state: 'open' },
      'RTE_CAP_INVALID',
    );
    const plain = openRun(spectacleDocument(false));
    expectRefusal(plain.doc, 'set_run_end_cap', { runId: plain.runId, end: 'end', closure: 'spectacleBlind' }, 'RTE_SPEC_NO_COMPONENT');
  });

  it('a spectacle end cannot be connected to: its port id is refused as closed, and a stored file with a bad spectacle value fails validation', () => {
    const { doc, runId, lineId } = openRun(spectacleDocument());
    const closed = ok(doc, 'set_run_end_cap', { runId, end: 'end', closure: 'spectacleBlind' }).document;
    expectRefusal(
      closed,
      'route_pipe',
      { lineId, from: { portId: `${runId}:end` }, legs: [{ direction: '+Y', length: 500 }] },
      'RTE_CAP_INVALID',
    );
    const raw = JSON.parse(JSON.stringify(closed.plant?.piping)) as { runs: Record<string, { end: Record<string, unknown> }> };
    (raw.runs[runId] as { end: Record<string, unknown> }).end['spectacle'] = 'half';
    expect(pipingErrors(raw)).toEqual([expect.stringContaining('spectacle must be "open" or "closed"')]);
  });
});
