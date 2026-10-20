/** 09 PLM M5 (VC-PLM-15): characteristic numbering over the 03 GD&T PMI items, balloons on sheets, and the AS9102 FAI skeleton (S3 steps 5-6). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { plateKernel } from '../../helpers/pmiPlateKernel';
import { T, approveAll } from './fixtures';
import { agentContext, run } from './scenarioRunner';

interface Step {
  command: string;
  params: Record<string, unknown>;
}
const plan = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../docs/aerospace/03-gdt-mbd-pmi/validation/draft_plan_gdt_plate.json'), 'utf8'),
) as Step[];

beforeEach(() => setGeometryKernel(plateKernel()));
afterEach(() => setGeometryKernel(null));

/** The GD&T plate (datums, size, position, flatness, perpendicularity, texture, one sheet) as a managed part LL-4000 in_work. */
function plate(): CadDocument {
  const actions = plan.filter((s) => s.command !== 'export_step_ap242' && s.command !== 'update_sheet' && s.command !== 'export_sheet_svg');
  const built = execute(createEmptyDocument(), 'build_project', { actions, onError: 'continue' }).document;
  return run(built, 'set_item_identity', {
    partNumber: 'LL-4000',
    name: 'GD&T plate',
    itemType: 'part',
    policy: { humanSignatureRequired: false },
    at: T,
    by: 'u-1',
  }).document;
}

const characteristics = (doc: CadDocument): NonNullable<NonNullable<CadDocument['plm']>['characteristics']> =>
  doc.plm?.characteristics ?? {};
const numbered = (doc: CadDocument): [string, number][] =>
  Object.entries(characteristics(doc))
    .map(([id, c]): [string, number] => [id, c.charNo])
    .sort((a, b) => a[1] - b[1]);

/** The plate numbered, released as A, then revised to B in_work (ECO-2). */
function releasedA(): CadDocument {
  const numberedPlate = run(plate(), 'assign_characteristic_ids', {}).document;
  const review = run(numberedPlate, 'submit_for_review', { at: T, by: 'u-1' }).document;
  const eco = run(review, 'create_change_order', { id: 'ECO-1', purpose: 'initial-release', at: T, by: 'u-1' }).document;
  return run(approveAll(eco), 'release_item', { changeOrder: 'ECO-1', at: T, by: 'u-1' }).document;
}

function revisedB(): CadDocument {
  const eco = run(releasedA(), 'create_change_order', {
    id: 'ECO-2',
    classification: 'minor',
    classificationJustification: 'j',
    at: T,
    by: 'u-1',
  }).document;
  return run(eco, 'revise_item', { changeOrder: 'ECO-2', at: T, by: 'u-1' }).document;
}

/** Revision B in_work whose surface texture names a special process (a Form 2 row). */
function revisedBWithProcess(): CadDocument {
  const b = revisedB();
  const texture = Object.values(b.pmi?.items ?? {}).find((item) => item.kind === 'surface_texture');
  return run(b, 'update_pmi', { pmiId: texture?.id as string, process: 'ANODIZE MIL-A-8625' }).document;
}

describe('assign_characteristic_ids (FR-PLM-26)', () => {
  it('numbers every dimension, tolerance frame and texture 1..n in creation order; datums are not characteristics', () => {
    const doc = plate();
    const result = run(doc, 'assign_characteristic_ids', { scheme: 'sequential' });
    const pmi = result.document.pmi;
    const items = (pmi?.order ?? []).map((id) => pmi?.items[id]);
    const expected = items.filter((item) => item !== undefined && !item.kind.startsWith('datum')).length;
    expect(expected).toBeGreaterThan(4);
    expect(numbered(result.document).map(([, n]) => n)).toEqual(Array.from({ length: expected }, (_, index) => index + 1));
    const kinds = new Set(Object.values(characteristics(result.document)).map((c) => c.sourceRef.kind));
    expect(kinds).toEqual(new Set(['dimension', 'gdt']));
    expect(Object.values(characteristics(result.document)).every((c) => c.introducedIn === 'A' && c.requirementText !== '')).toBe(true);
    expect(result.summary).toContain(`numbered ${expected} new characteristic(s)`);
    expect(result.affected).toEqual([]);
    expect(doc.plm?.characteristics).toBeUndefined();
  });

  it('is idempotent: a second run changes nothing and keeps every number', () => {
    const first = run(plate(), 'assign_characteristic_ids', {}).document;
    const again = run(first, 'assign_characteristic_ids', {});
    expect(again.document).toBe(first);
    expect(again.summary).toContain('nothing new');
  });

  it('includeNotes numbers notes; a new item gets the next number, existing numbers never change (stable across regeneration)', () => {
    const first = run(plate(), 'assign_characteristic_ids', {}).document;
    const before = numbered(first);
    const withNote = run(first, 'add_pmi_note', { text: 'BREAK ALL SHARP EDGES' }).document;
    const second = run(withNote, 'assign_characteristic_ids', { includeNotes: true }).document;
    expect(numbered(second).slice(0, before.length)).toEqual(before);
    expect(numbered(second).at(-1)?.[1]).toBe(before.length + 1);
    expect(Object.values(characteristics(second)).find((c) => c.sourceRef.kind === 'note')?.requirementText).toContain(
      'BREAK ALL SHARP EDGES',
    );
    const replayed = run(second, 'replay_history', {}).document;
    expect(numbered(replayed)).toEqual(numbered(second));
  });

  it('a deleted item retires its number; the number is never reused; a reappearing id takes it back', () => {
    const first = run(plate(), 'assign_characteristic_ids', {}).document;
    const [victim, victimNo] = numbered(first)[1] as [string, number];
    const deleted = run(first, 'delete_pmi', { pmiId: victim }).document;
    const retired = run(deleted, 'assign_characteristic_ids', {});
    expect(characteristics(retired.document)[victim]).toMatchObject({ charNo: victimNo, retiredIn: 'A' });
    expect(retired.summary).toContain(`retired ${victimNo}`);
    const added = run(run(retired.document, 'add_pmi_note', { text: 'N1' }).document, 'assign_characteristic_ids', {
      includeNotes: true,
    }).document;
    expect(Math.max(...numbered(added).map(([, n]) => n))).toBe(numbered(first).length + 1);
    const back = { ...added, pmi: first.pmi } as CadDocument;
    expect(characteristics(run(back, 'assign_characteristic_ids', {}).document)[victim]?.retiredIn).toBeUndefined();
  });

  it('records designators and the sheet that shows the item explicitly; refuses unknown sheets, ids and non-managed or PMI-less documents', () => {
    const doc = plate();
    const sheet = Object.keys(doc.drawings?.sheets ?? {})[0] as string;
    const [first] = (doc.pmi?.order ?? []).filter((id) => !doc.pmi?.items[id]?.kind.startsWith('datum')) as [string];
    const marked = run(doc, 'assign_characteristic_ids', { designators: { [first]: 'KEY' } }).document;
    expect(characteristics(marked)[first]?.designator).toBe('KEY');
    expect(run(doc, 'assign_characteristic_ids', { sheetId: 'nope' }).error?.code).toBe('PLM_PARAM_INVALID');
    expect(run(doc, 'assign_characteristic_ids', { designators: { 'pmi-x': 'K' } }).error?.code).toBe('PLM_PARAM_INVALID');
    expect(run(createEmptyDocument(), 'assign_characteristic_ids', {}).error?.code).toBe('PLM_NOT_MANAGED');
    const noPmi = run(createEmptyDocument(), 'set_item_identity', {
      partNumber: 'LL-1',
      name: 'n',
      itemType: 'part',
      policy: { humanSignatureRequired: false },
    }).document;
    const none = run(noPmi, 'assign_characteristic_ids', {});
    expect(none.document).toBe(noPmi);
    expect(none.summary).toContain('no PMI items');
    const onSheet = run(run(doc, 'update_sheet', { sheetId: sheet, pmiMode: 'auto' }).document, 'assign_characteristic_ids', {
      sheetId: sheet,
    }).document;
    expect(Object.values(characteristics(onSheet)).every((c) => c.sheetId === sheet)).toBe(true);
  });

  it('is not a human act (an agent can prepare the numbering), and the PLM record only changes', () => {
    const doc = plate();
    const result = run(doc, 'assign_characteristic_ids', {}, agentContext());
    expect(result.rejected).toBeUndefined();
    expect(result.document.entities).toBe(doc.entities);
    expect(result.document.pmi).toBe(doc.pmi);
  });

  it('works on a released revision (the register is PLM data) without tripping the release lock', () => {
    const doc = releasedA();
    const extra = run(doc, 'assign_characteristic_ids', { includeNotes: true });
    expect(extra.rejected).toBeUndefined();
    expect(extra.document.plm?.item.revisions['A']?.contentHash).toBe(doc.plm?.item.revisions['A']?.contentHash);
  });
});

describe('balloons on sheets', () => {
  it('draws each active characteristic number beside its callout, never a retired one', () => {
    const doc = plate();
    const sheet = Object.keys(doc.drawings?.sheets ?? {})[0] as string;
    const auto = run(doc, 'update_sheet', { sheetId: sheet, pmiMode: 'auto' }).document;
    const svgOf = (d: CadDocument): string => (execute(d, 'export_sheet_svg', { sheetId: sheet }).data as { svg: string }).svg;
    expect(svgOf(auto)).not.toContain('data-char-no');
    const numberedDoc = run(auto, 'assign_characteristic_ids', {}).document;
    const svg = svgOf(numberedDoc);
    const count = Object.keys(characteristics(numberedDoc)).length;
    expect(svg.match(/data-char-no="\d+"/g)?.length).toBeGreaterThan(0);
    expect(svg.match(/data-char-no="\d+"/g)?.length).toBeLessThanOrEqual(count);
    const [victim, no] = numbered(numberedDoc)[0] as [string, number];
    expect(svg).toContain(`id="balloon-${no}"`);
    const retired = run(run(numberedDoc, 'delete_pmi', { pmiId: victim }).document, 'assign_characteristic_ids', {}).document;
    expect(svgOf(retired)).not.toContain(`id="balloon-${no}"`);
  });
});

describe('fai_report_skeleton (FR-PLM-27, S3 step 6)', () => {
  const faiParams = { revision: 'A', faiType: 'full', format: 'json' } as const;
  type Fai = {
    form1: Record<string, unknown>;
    form2: { rows: Record<string, unknown>[] };
    form3: {
      rows: { charNo: number; requirement: string; results: unknown; referenceLocation: unknown }[];
      retiredSinceBaseline?: number[];
    };
    csv?: string;
  };
  const fai = (doc: CadDocument, params: unknown): Fai => run(doc, 'fai_report_skeleton', params).data as Fai;

  it('a full FAI lists every characteristic with a null result and prefills Forms 1 and 2', () => {
    const doc = releasedA();
    const data = fai(doc, faiParams);
    expect(data.form1).toMatchObject({
      partNumber: 'LL-4000',
      partName: 'GD&T plate',
      drawingRevision: 'A',
      fullOrPartial: 'full',
      detailOrAssembly: 'detail',
      reportId: 'FAI-LL-4000-A-1',
      serialNumber: null,
      faiComplete: null,
      approvedBy: null,
    });
    expect(data.form3.rows.length).toBe(Object.keys(characteristics(doc)).length);
    expect(data.form3.rows.every((row) => row.results === null && row.requirement !== '')).toBe(true);
    expect(data.form3.rows.map((row) => row.charNo)).toEqual(data.form3.rows.map((_, index) => index + 1));
    expect(data.form2.rows).toEqual([]);
    expect(fai(revisedBWithProcess(), { revision: 'B', faiType: 'full', format: 'json' }).form2.rows[0]).toMatchObject({
      materialOrProcessName: 'ANODIZE MIL-A-8625',
      specificationNumber: null,
    });
  });

  it('a partial FAI lists only what is new or changed since the baseline revision, and the numbers retired', () => {
    const b = revisedB();
    const [first] = numbered(b)[0] as [string, number];
    const edited = run(b, 'update_pmi', {
      pmiId: Object.keys(characteristics(b)).find((id) => b.pmi?.items[id]?.kind === 'surface_texture') as string,
      value: 0.8,
    }).document;
    const noted = run(edited, 'add_pmi_note', { text: 'NEW NOTE' }).document;
    const dropped = run(noted, 'delete_pmi', { pmiId: first }).document;
    const renumbered = run(dropped, 'assign_characteristic_ids', { includeNotes: true }).document;
    const data = fai(renumbered, {
      revision: 'B',
      faiType: 'partial',
      baselineRevision: 'A',
      reason: 'ECO-2 design change',
      format: 'json',
    });
    expect(data.form1).toMatchObject({
      fullOrPartial: 'partial',
      reasonForPartial: 'ECO-2 design change',
      baselineRevision: 'A',
      additionalChanges: 'ECO-2 (open)',
    });
    const total = Object.keys(characteristics(renumbered)).length;
    expect(data.form3.rows.length).toBe(2);
    expect(data.form3.rows.length).toBeLessThan(total);
    expect(data.form3.rows.some((row) => row.requirement.includes('NEW NOTE'))).toBe(true);
    expect(data.form3.retiredSinceBaseline).toContain(1);
    expect(data.form3.rows.every((row) => row.results === null)).toBe(true);
  });

  it('a partial FAI against a frozen baseline reads that snapshot; the CSV carries the same rows as one flat table', () => {
    const doc = releasedA();
    const csv = fai(doc, { ...faiParams, format: 'csv' }).csv ?? '';
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('form,row,field,value');
    expect(lines.filter((line) => line.startsWith('3,') && line.includes(',results,'))).toHaveLength(
      Object.keys(characteristics(doc)).length,
    );
    expect(lines.some((line) => line.startsWith('1,,partNumber,LL-4000'))).toBe(true);
    expect(fai(doc, faiParams).csv).toBeUndefined();
    const same = fai(doc, { revision: 'A', faiType: 'partial', baselineRevision: 'A', reason: 'r', format: 'json' });
    expect(same.form3.rows).toEqual([]);
  });

  it('quotes CSV fields that hold commas or quotes', () => {
    const doc = run(
      run(releasedA(), 'create_change_order', { id: 'ECO-9', classification: 'minor', classificationJustification: 'j' }).document,
      'revise_item',
      { changeOrder: 'ECO-9' },
    ).document;
    const noted = run(run(doc, 'add_pmi_note', { text: 'SEE "NOTE 1", AND 2' }).document, 'assign_characteristic_ids', {
      includeNotes: true,
    }).document;
    const csv = fai(noted, { revision: 'B', faiType: 'full', format: 'csv' }).csv ?? '';
    expect(csv).toContain('"SEE ""NOTE 1"", AND 2"');
  });

  it('refuses a foreign part number, an unknown revision, a partial without baseline or reason, and a non-managed document', () => {
    const doc = releasedA();
    expect(run(doc, 'fai_report_skeleton', { ...faiParams, partNumber: 'LL-9' }).error?.code).toBe('PLM_PARAM_INVALID');
    expect(run(doc, 'fai_report_skeleton', { ...faiParams, revision: 'Z' }).error?.code).toBe('PLM_REVISION_UNKNOWN');
    expect(run(doc, 'fai_report_skeleton', { revision: 'A', faiType: 'partial', format: 'json' }).error?.code).toBe('PLM_PARAM_INVALID');
    expect(
      run(doc, 'fai_report_skeleton', { revision: 'A', faiType: 'partial', baselineRevision: 'A', reason: ' ', format: 'json' }).error
        ?.code,
    ).toBe('PLM_PARAM_INVALID');
    expect(run(createEmptyDocument(), 'fai_report_skeleton', faiParams).error?.code).toBe('PLM_NOT_MANAGED');
  });

  it('is read-only, an agent may run it, and an externalized snapshot without a vault is reported, not guessed', () => {
    const doc = releasedA();
    const result = run(doc, 'fai_report_skeleton', faiParams, agentContext());
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const revision = doc.plm?.item.revisions['A'];
    const hollow = {
      ...doc,
      plm: {
        ...doc.plm,
        item: {
          ...doc.plm?.item,
          revisions: { ...doc.plm?.item.revisions, A: { ...revision, snapshot: { kind: 'vault', objectSha256: revision?.contentHash } } },
        },
      },
    } as unknown as CadDocument;
    expect(run(hollow, 'fai_report_skeleton', faiParams).error?.code).toBe('PLM_VAULT_OBJECT_MISSING');
    const objects = { has: () => true, get: () => (revision?.snapshot?.kind === 'inline' ? revision.snapshot.canonicalJson : null) };
    expect(run(hollow, 'fai_report_skeleton', faiParams, { ...agentContext(), objects }).rejected).toBeUndefined();
  });
});
