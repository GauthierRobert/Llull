/** 09 PLM M6 review fixes: schema order of dated_effectivity (checked against the PDM usage guide and the AP242 MIM), classification, own-key lookups, shapes and seals, QIF reader hardening, anchors. */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { getCommand } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { parseRecords } from '@lib/step21/records';
import { sha256Hex } from '@lib/sha256';
import { plmDocument } from '@plm/document';
import { own, sealResults } from '@plm/records';
import { readPdm } from '@plm/pdm/read';
import { readQifResults } from '@plm/qif/results';
import { parseXml } from '@plm/qif/xml';
import { checkRecords, loadSchema } from '../../helpers/expressSchema';
import { T, APPROVALS, inReview } from './fixtures';
import { baselinedAssembly } from './m6Fixtures';
import { run } from './scenarioRunner';

const exportStep = (doc: CadDocument, params: Record<string, unknown> = {}): string =>
  (run(doc, 'export_step_pdm', { organization: { id: 'O-1', name: 'Org' }, ...params }).data as { step: string }).step;

function withEffectivity(): CadDocument {
  const eco = run(inReview(), 'create_change_order', {
    id: 'ECO-0100',
    purpose: 'initial-release',
    effectivity: [{ kind: 'date', from: '2027-01-01', to: '2027-12-31' }],
    at: T,
    by: 'u-1',
  }).document;
  const approved = APPROVALS.reduce((next, approval) => run(next, 'record_approval', { ...approval, at: T }).document, eco);
  return run(approved, 'release_item', { changeOrder: 'ECO-0100', at: T, by: 'u-1' }).document;
}

/** Example 65 of the PDM usage guide (release 4.3, section 14.3.1.3), verbatim: version A [#3] and B [#10] with general validity periods. */
const GUIDE_EXAMPLE_65 = `#910=DATE_AND_TIME(#920, #930);
#920=CALENDAR_DATE(2000, 1, 7);
#930=LOCAL_TIME(0, 0, 0., #940);
#940=COORDINATED_UNIVERSAL_TIME_OFFSET(1, $, .AHEAD.);
#970=DATE_AND_TIME(#980, #990);
#980=CALENDAR_DATE(1999, 31, 3);
#990=LOCAL_TIME(0, 0, 0., #1000);
#1000=COORDINATED_UNIVERSAL_TIME_OFFSET(1, $, .AHEAD.);
#1010=DATE_AND_TIME(#1020, #1030);
#1020=CALENDAR_DATE(1999, 1, 4);
#1030=LOCAL_TIME(0, 0, 0., #1031);
#1031=COORDINATED_UNIVERSAL_TIME_OFFSET(1, $, .AHEAD.);
#1040=DATED_EFFECTIVITY('', #970, #910);
#1041=DATED_EFFECTIVITY('', $, #1010);
#1042=APPLIED_EFFECTIVITY_ASSIGNMENT(#1040, (#3));
#1043=APPLIED_EFFECTIVITY_ASSIGNMENT(#1041, (#10));
#1044=OBJECT_ROLE('actual', $);
#1045=ROLE_ASSOCIATION(#1044, #1042);
#1046=ROLE_ASSOCIATION(#1044, #1043);`;

describe('dated_effectivity attribute order (AP242 MIM: effectivity_end_date, then effectivity_start_date)', () => {
  it('writes the end date first and the start date second, and reads the guide example in the same order', () => {
    const text = exportStep(withEffectivity());
    const bodies = parseRecords(text).bodies;
    const [dated] = [...bodies.values()].filter((body) => body.startsWith('DATED_EFFECTIVITY('));
    const [end, start] = [...(dated ?? '').matchAll(/#(\d+)/g)].map((match) => bodies.get(Number(match[1])) ?? '');
    const date = (dateAndTime: string): string => bodies.get(Number(/CALENDAR_DATE|#(\d+),/.exec(dateAndTime)?.[1])) ?? '';
    expect(date(end ?? '')).toBe('CALENDAR_DATE(2027,31,12)');
    expect(date(start ?? '')).toBe('CALENDAR_DATE(2027,1,1)');
    expect(readPdm(text)).toMatchObject({ dateEffectivity: [{ from: '2027-01-01', to: '2027-12-31' }] });
  });

  it('reads effectivity records taken from the usage guide (not from our writer) in schema order', () => {
    const text = exportStep(baselinedAssembly());
    const current = /#(\d+)=PRODUCT_DEFINITION_FORMATION\('A',/.exec(text)?.[1];
    expect(current).toBeDefined();
    const guide = GUIDE_EXAMPLE_65.replace('(#10)', `(#${current})`);
    const merged = text.replace('ENDSEC;\nEND-ISO-10303-21;', `${guide}\nENDSEC;\nEND-ISO-10303-21;`);
    // #1041 is ('', $, #1010): no end date, start 1 April 1999 (CALENDAR_DATE is year, day, month). #1040 belongs to another version.
    expect(readPdm(merged)).toMatchObject({ dateEffectivity: [{ from: '1999-04-01', to: null }] });
  });

  it('every record conforms to the AP242 MIM long form (set LLULL_AP242_MIM to mim_lf.exp; skipped without it)', () => {
    const mim = process.env['LLULL_AP242_MIM'];
    if (mim === undefined || !existsSync(mim)) return;
    const doc = run(baselinedAssembly(), 'create_mbom', {
      id: 'M1',
      name: 'm',
      baseline: 'BL-PBL-0003',
      add: [{ partNumber: 'CONS-1', name: 'c', quantity: 1, kind: 'consumable', reason: 'r' }],
    }).document;
    for (const text of [exportStep(withEffectivity()), exportStep(doc, { mbom: 'M1' })]) {
      const { bodies } = parseRecords(text);
      const { checked, violations } = checkRecords(loadSchema(mim), bodies, bodies.keys());
      expect(violations).toEqual([]);
      expect(checked).toBeGreaterThan(20);
    }
  });
});

describe('PDM conformance details', () => {
  it('writes the security level from the item classification, the regime as the classification name, and "part" for MBOM-only products', () => {
    const doc = run(baselinedAssembly(), 'create_mbom', {
      id: 'M1',
      name: 'm',
      baseline: 'BL-PBL-0003',
      add: [{ partNumber: 'CONS-1', name: 'c', quantity: 1, kind: 'consumable', reason: 'r' }],
    }).document;
    const plm = doc.plm;
    const revision = plm?.item.revisions['A'];
    if (plm === undefined || revision === undefined) throw new Error('fixture');
    const marked: CadDocument = {
      ...doc,
      plm: {
        ...plm,
        item: {
          ...plm.item,
          revisions: { A: { ...revision, releasedMarking: { regime: 'ITAR', classification: 'confidential', statement: 'USML XIII' } } },
        },
      },
    };
    const text = exportStep(marked, { mbom: 'M1' });
    expect(text).toContain("SECURITY_CLASSIFICATION_LEVEL('confidential')");
    expect(text).toContain("SECURITY_CLASSIFICATION('ITAR','USML XIII'");
    expect(readPdm(text)).toMatchObject({ marking: { regime: 'ITAR', classification: 'confidential', statement: 'USML XIII' } });
    expect(readPdm(exportStep(baselinedAssembly()))).toMatchObject({ marking: { classification: null } });
    const consumable = /#(\d+)=PRODUCT\('CONS-1'/.exec(text)?.[1];
    const category = /PRODUCT_RELATED_PRODUCT_CATEGORY\('part',\$,\(([^)]*)\)\)/.exec(text)?.[1] ?? '';
    expect(category.split(',')).toContain(`#${consumable}`);
  });

  it('refuses an MBOM made from another revision than the one exported', () => {
    let doc = run(baselinedAssembly(), 'create_mbom', { id: 'M1', name: 'm', baseline: 'BL-PBL-0003' }).document;
    doc = run(doc, 'create_change_order', {
      id: 'ECO-2',
      classification: 'minor',
      classificationJustification: 'j',
      at: T,
      by: 'u-1',
    }).document;
    doc = run(doc, 'revise_item', { changeOrder: 'ECO-2', at: T, by: 'u-1' }).document;
    expect(run(doc, 'export_step_pdm', { mbom: 'M1', revision: 'A' }).rejected).toBeUndefined();
    expect(run(doc, 'export_step_pdm', { mbom: 'M1' })).toMatchObject({ rejected: true, error: { code: 'PLM_PARAM_INVALID' } });
  });
});

describe('ids that are Object.prototype members are not entries', () => {
  const doc = baselinedAssembly();
  // The registry already refuses reserved ids (CMD_RESERVED_ID); the commands themselves must hold on their own, so call them directly.
  const code = (command: string, params: Record<string, unknown>): string | undefined =>
    command === 'record_as_built'
      ? run(doc, command, params).error?.code
      : (getCommand(command)?.run(doc, params, undefined) as { error?: { code: string } } | undefined)?.error?.code;
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('%s', (id) => {
    // CMD_RESERVED_ID is the engine's own refusal of such ids; either way nothing is found.
    const calls: [string, Record<string, unknown>, string][] = [
      ['as_built_vs_as_designed', { serial: id }, 'PLM_SERIAL_UNKNOWN'],
      ['manufacturing_bom', { id }, 'PLM_MBOM_UNKNOWN'],
      ['create_mbom', { name: 'n', baseline: id }, 'PLM_BASELINE_UNKNOWN'],
      ['record_as_built', { serial: 'SN-1', partNumber: 'LL-3000', asDesignedBaseline: id, deviations: [] }, 'PLM_BASELINE_UNKNOWN'],
      [
        'record_as_built',
        { serial: 'SN-1', partNumber: 'LL-3000', asDesignedBaseline: 'BL-PBL-0003', mbom: id, deviations: [] },
        'PLM_PARAM_INVALID',
      ],
      ['export_step_pdm', { revision: id }, 'PLM_REVISION_UNKNOWN'],
      ['export_step_pdm', { mbom: id }, 'PLM_MBOM_UNKNOWN'],
      ['fai_report_skeleton', { revision: 'A', faiType: 'full', resultsId: id, format: 'json' }, 'PLM_RESULTS_UNKNOWN'],
      ['lotar_validation_properties', { revision: id }, 'PLM_REVISION_UNKNOWN'],
    ];
    for (const [command, params, domain] of calls) expect([domain, 'CMD_RESERVED_ID'], command).toContain(code(command, params));
  });
  it('record_as_built with serial "constructor" is a normal serial', () => {
    expect(
      run(doc, 'record_as_built', { serial: 'constructor', partNumber: 'LL-3000', asDesignedBaseline: 'BL-PBL-0003', deviations: [] })
        .rejected,
    ).toBeUndefined();
  });
});

describe('own', () => {
  it('finds own entries only', () => {
    const table = { a: 1 };
    expect([own(table, 'a'), own(table, 'constructor'), own(table, 'toString'), own(table, '__proto__'), own(undefined, 'a')]).toEqual([
      1,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('plm slice shape and seal validation on load', () => {
  const saved = (): { plm: Record<string, unknown> } => {
    const doc = run(baselinedAssembly(), 'record_as_built', {
      serial: 'SN-1',
      partNumber: 'LL-3000',
      asDesignedBaseline: 'BL-PBL-0003',
      deviations: [],
      at: T,
    }).document;
    return { plm: JSON.parse(JSON.stringify(doc.plm)) as Record<string, unknown> };
  };
  it('accepts what the commands wrote', () => {
    expect(plmDocument.validate(saved())).toEqual([]);
  });
  it('refuses malformed as-built records, MBOMs and result sets, and a result set whose seal no longer matches', () => {
    const base = saved();
    const asBuilt = base.plm['asBuilt'] as Record<string, Record<string, unknown>>;
    asBuilt['SN-1']!['deviations'] = 'none';
    expect(plmDocument.validate(base)[0]).toContain('is not an as-built record');
    asBuilt['other'] = asBuilt['SN-1']!;
    expect(plmDocument.validate(base).join('|')).toContain('plm.asBuilt.other is not a record stored under its own serial');
    const mbom = {
      id: 'M',
      name: 'n',
      baseline: 'b',
      lines: [{ partNumber: 'p', revision: 'A', quantity: -1, origin: 'ebom' }],
      omitted: [],
      sha256: 'x',
    };
    expect(plmDocument.validate({ plm: { ...saved().plm, mbom: { M: mbom } } })[0]).toContain('is not a manufacturing BOM');
    const results = {
      id: 'R',
      revision: 'A',
      importedBy: 'u',
      source: { sha256: 'h' },
      results: [{ charNo: 1.5, status: 'PASS' }],
      unmatched: [],
      missing: [],
    };
    expect(plmDocument.validate({ plm: { ...saved().plm, faiResults: { R: results } } })[0]).toContain('is not an imported result set');
    expect(plmDocument.validate({ plm: { ...saved().plm, faiResults: 'x' } })[0]).toContain('plm.faiResults must be an object');
  });
});

describe('result set seal', () => {
  it('is sealed and a hand edit is found on load', () => {
    const set = sealResults({
      id: 'R',
      revision: 'A',
      importedBy: 'u',
      source: { format: 'QIF 3.0 MeasurementResults', sha256: 'h', bytes: 1 },
      results: [{ charNo: 1, status: 'PASS', source: { element: 'e', qifId: '1' } }],
      unmatched: [],
      missing: [],
    });
    const base = JSON.parse(JSON.stringify(baselinedAssembly().plm)) as Record<string, unknown>;
    expect(plmDocument.validate({ plm: { ...base, faiResults: { R: set } } })).toEqual([]);
    const forged = { ...set, results: [{ ...set.results[0], status: 'FAIL' }] };
    expect(plmDocument.validate({ plm: { ...base, faiResults: { R: forged } } })[0]).toContain(
      'plm.faiResults.R does not hash to its seal',
    );
  });
});

describe('act payload names the QIF file', () => {
  it('carries the SHA-256 of the xml among the signed details', () => {
    const xml = '<QIFDocument/>';
    const payload = run(baselinedAssembly(), 'plm_act_payload', {
      command: 'import_qif_results',
      params: { xml, revision: 'A' },
      nonce: 'nonce-12345678',
    }).data as { details: { xmlSha256?: string } };
    expect(payload.details.xmlSha256).toBe(sha256Hex(xml));
  });
});

describe('the QIF reader, hardened', () => {
  it('does not let a long digit run cost more than a linear scan', () => {
    const xml = `<?xml version="1.0"?><QIFDocument xmlns="http://qifstandards.org/xsd/qif3"><Results><MeasurementResultsSet><MeasurementResults><MeasuredCharacteristics><CharacteristicMeasurements><DiameterCharacteristicMeasurement id="1"><Status><CharacteristicStatusEnum>PASS</CharacteristicStatusEnum></Status><CharacteristicItemId>2</CharacteristicItemId><Value>${'9'.repeat(7_000_000)}x</Value></DiameterCharacteristicMeasurement></CharacteristicMeasurements></MeasuredCharacteristics></MeasurementResults></MeasurementResultsSet></Results></QIFDocument>`;
    const start = performance.now();
    const read = readQifResults(xml);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(read).toMatchObject({ ok: false, message: expect.stringContaining('not a number') });
    const digitsOnly = xml.replace('x</Value>', '</Value>');
    expect(readQifResults(digitsOnly)).toMatchObject({ ok: false });
  });

  it('refuses references to characters XML forbids, an xml-stylesheet-like declaration, and mismatched qualified end tags; keeps __proto__ attributes as data', () => {
    for (const text of [
      '<a>&#1;</a>',
      '<a>&#xFFFE;</a>',
      '<a>&#xD800;</a>',
      '<?xml-stylesheet href="x"?><a/>',
      '<?xml?><a/>',
      '<p:a xmlns:p="u"></q:a>',
      '<p:a xmlns:p="u"></a>',
    ]) {
      const parsed = parseXml(text);
      expect(parsed.ok, text).toBe(false);
    }
    expect(parseXml('<a>&#x9;&#xA;&#xD;&#x20;&#xE000;&#x10000;</a>').ok).toBe(true);
    expect(parseXml('<?xml version="1.0"?>\n<a/>').ok).toBe(true);
    expect(parseXml('<p:a xmlns:p="u"></p:a>').ok).toBe(true);
    const parsed = parseXml('<a __proto__="x" constructor="y" toString="z"/>');
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.root.attrs['__proto__']).toBe('x');
    expect(parsed.root.attrs['constructor']).toBe('y');
    expect(Object.getPrototypeOf(parsed.root.attrs)).toBeNull();
    expect(Object.hasOwn(parsed.root.attrs, 'valueOf')).toBe(false);
  });
});

describe('anchors', () => {
  it('attach_release_package keeps one anchor per kind and never replaces it', () => {
    const doc = baselinedAssembly();
    const hash = doc.plm?.item.revisions['A']?.contentHash as string;
    const attach = (d: CadDocument, sha: string, kind?: string): ReturnType<typeof run> =>
      run(d, 'attach_release_package', {
        revision: 'A',
        manifestSha256: sha,
        documentContentHash: hash,
        ...(kind === undefined ? {} : { package: kind }),
      });
    const release = attach(doc, 'a'.repeat(64));
    expect(release.document.plm?.item.revisions['A']).toMatchObject({ packageSha256: 'a'.repeat(64) });
    const lotar = attach(release.document, 'b'.repeat(64), 'lotar');
    expect(lotar.document.plm?.item.revisions['A']).toMatchObject({ packageSha256: 'a'.repeat(64), lotarPackageSha256: 'b'.repeat(64) });
    expect(lotar.summary).toContain('lotar package');
    expect(attach(lotar.document, 'b'.repeat(64), 'lotar').rejected).toBeUndefined();
    expect(attach(lotar.document, 'c'.repeat(64), 'lotar')).toMatchObject({ rejected: true, error: { code: 'PLM_ID_EXISTS' } });
    expect(attach(lotar.document, 'c'.repeat(64))).toMatchObject({ rejected: true, error: { code: 'PLM_ID_EXISTS' } });
    expect(createEmptyDocument().plm).toBeUndefined();
  });
});
