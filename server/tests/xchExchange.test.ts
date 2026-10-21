/**
 * Aerospace 04 XCH on the live native kernel (OCCT 7.9.2): geometric validation properties (VC-XCH-01), AP242 export with embedded properties read by
 * the independent Part 21 reader (VC-XCH-02), schema / header / determinism (VC-XCH-03), assembly structure and units (VC-XCH-04, -12), import with the
 * product tree and the GVP check (VC-XCH-05/-06/-22/-23), IGES round trips (VC-XCH-10/-11) and hostile input (VC-XCH-14). Expected numbers are the
 * analytic references of the validation pack (`analytic_gvp_reference.json`) and the NIST files (fetched, never committed, see
 * docs/aerospace/01-exact-brep-kernel/validation/fetch_nist_step_files.py; skipped without them).
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { MM_PER_UNIT } from '@core/model/units';
import type { ShapeHandle } from '@core/geometry/kernelTypes';
import { canonicalizeStep21 } from '@lib/step21/canonical';
import { summarizeStep21 } from '@lib/step21/summary';
import { groupFileGvp } from '@core/commands/exchange/fileGvp';
import { describeNativeWhen, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
/** The ops this suite drives; an older native build without them skips the suites instead of failing. */
const XDE = ['writeExchange', 'importExchange'] as const;
const describeXde = describeNativeWhen({ capabilities: XDE, label: 'XCH exchange' });
const PACK = path.resolve(__dirname, '../../docs/aerospace/04-interop-ap242-jt-iges/validation');
const NIST = process.env['LLULL_NIST_STEP_DIR'] || path.join(os.homedir(), '.cache', 'llull', 'nist-pmi-step-files');
const TIMESTAMP = '2026-10-20T00:00:00';

interface Reference {
  readonly id: string;
  readonly volume: number;
  readonly area: number;
  readonly centroid: readonly number[];
  readonly unit: string;
  readonly plan: string;
}
const references = (JSON.parse(readFileSync(path.join(PACK, 'analytic_gvp_reference.json'), 'utf8')) as { cases: Reference[] }).cases;
const reference = (id: string): Reference => references.find((entry) => entry.id === id)!;

interface PmiView {
  readonly datums: readonly { label: string; faces: readonly number[] }[];
  readonly tolerances: readonly {
    characteristic: string;
    value: number;
    diameterZone: boolean;
    faces: readonly number[];
    datums: readonly string[];
  }[];
  readonly dimensions: readonly { type: string; value: number; faces: readonly number[]; tolerance?: { plus: number; minus: number } }[];
}

interface NistLikeReport {
  readonly report: {
    readonly exchange: {
      gvpCheck: { band: string };
      unitFactor: number | null;
      pmiUnmapped: number;
      products: { name: string; band: string; pmi?: PmiView }[];
    };
    readonly warnings: { code: string }[];
    readonly reviewRequired: { value: boolean; reasons: string[] };
  };
}

const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });
const run = (doc: CadDocument, name: string, params: Record<string, unknown> = {}): CommandResult => execute(doc, name, params, ctx());

function built(planFile: string): CadDocument {
  const actions = JSON.parse(readFileSync(path.join(PACK, planFile), 'utf8')) as unknown[];
  const result = execute(createEmptyDocument(), 'build_project', { actions }, ctx());
  const data = result.data as { ok: boolean; steps: { ok: boolean; summary: string }[] };
  expect(
    data.steps.filter((step) => !step.ok).map((step) => step.summary),
    planFile,
  ).toEqual([]);
  return result.document;
}

const relative = (value: number, expected: number): number => Math.abs(value - expected) / Math.max(Math.abs(expected), 1e-12);
const dataOf = <T>(result: CommandResult): T => result.data as T;

describeXde('XCH geometric validation properties and AP242 export (analytic parts)', () => {
  it('geometric_validation_properties reproduces the analytic volume, area and centroid of the 9 reference parts (VC-XCH-01)', () => {
    for (const expected of references) {
      const doc = built(expected.plan);
      const data = dataOf<{
        items: { volume: number; area: number; centroid: number[]; method: string }[];
        assemblies: { volume: number; area: number; centroid: number[] }[];
      }>(run(doc, 'geometric_validation_properties'));
      const all = [...data.items, ...data.assemblies];
      const volume = all.reduce((sum, entry) => sum + entry.volume, 0);
      const item = {
        volume,
        area: all.reduce((sum, entry) => sum + entry.area, 0),
        centroid: [0, 1, 2].map((axis) => all.reduce((sum, entry) => sum + entry.volume * entry.centroid[axis]!, 0) / volume),
      };
      expect(doc.units, expected.id).toBe(expected.unit);
      expect(relative(item.volume, expected.volume), `${expected.id} volume`).toBeLessThan(1e-9);
      expect(relative(item.area, expected.area), `${expected.id} area`).toBeLessThan(1e-9);
      item.centroid.forEach((value, axis) =>
        expect(Math.abs(value - expected.centroid[axis]!), `${expected.id} centroid`).toBeLessThan(1e-7),
      );
    }
  }, 120_000);

  it('export_step_ap242 embeds the same properties, read back by the independent Part 21 reader (VC-XCH-02, -03)', () => {
    const expected = reference('xch-plate-offset-hole');
    const result = run(built(expected.plan), 'export_step_ap242', { timestamp: TIMESTAMP, fileName: 'plate.stp' });
    const data = dataOf<{
      step: string;
      schemaName: string;
      selfCheck: { band: string; missing: string[] };
      provenance: { timestamp: string };
    }>(result);
    expect(data.schemaName).toContain('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF');
    expect(data.step).toContain("FILE_DESCRIPTION(('llull export'),'2;1');");
    expect(data.step).toContain(`FILE_NAME('plate.stp','${TIMESTAMP}'`);
    expect(data.selfCheck).toMatchObject({ band: 'green', missing: [] });
    const summary = summarizeStep21(data.step);
    expect(summary.lengthUnit).toEqual({ name: 'mm', mmPerUnit: 1 });
    const [group] = groupFileGvp(summary, 1).filter((entry) => entry.product === 'xch-plate-offset-hole');
    expect(relative(group!.volume!, expected.volume)).toBeLessThan(1e-9);
    expect(relative(group!.area!, expected.area)).toBeLessThan(1e-9);
    expect(Math.abs(group!.centroid![0] - expected.centroid[0]!)).toBeLessThan(1e-9 * 100);
    expect(result.document).toEqual(built(expected.plan));
  }, 120_000);

  it('writes the requested schema, refuses nothing it can write, and is byte-identical for the same input (VC-XCH-03)', () => {
    const doc = built(reference('xch-box').plan);
    const write = (schema: string): string =>
      dataOf<{ step: string }>(run(doc, 'export_step_ap242', { schema, timestamp: TIMESTAMP })).step;
    expect(write('ap214')).toContain('AUTOMOTIVE_DESIGN');
    expect(write('ap203')).toContain('CONFIG_CONTROL_DESIGN');
    const first = write('ap242');
    expect(write('ap242')).toBe(first);
    expect(write('ap242')).toBe(first);
    expect(canonicalizeStep21(first)).toBe(first);
    const without = dataOf<{ step: string; selfCheck?: unknown }>(
      run(doc, 'export_step_ap242', { includeValidationProperties: false, timestamp: TIMESTAMP }),
    );
    expect(without.step).not.toContain('geometric validation property');
    expect(without.selfCheck).toBeUndefined();
  }, 120_000);

  it('keeps the product structure of an assembly: one product, two occurrences, assembly GVP V 2000 c (50, 0, 0) (VC-XCH-04)', () => {
    const doc = built('plans/xch-assembly-2x.json');
    const data = dataOf<{ step: string; assembly: { products: number; occurrences: number }; gvp: { product: string; volume: number }[] }>(
      run(doc, 'export_step_ap242', { timestamp: TIMESTAMP }),
    );
    expect(data.assembly).toEqual({ products: 1, occurrences: 2 });
    expect(data.step.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)).toHaveLength(2);
    const groups = groupFileGvp(summarizeStep21(data.step), 1);
    const root = groups.find((group) => group.product === 'Assembly');
    expect(root?.volume).toBeCloseTo(2000, 9);
    expect(root?.centroid?.[0]).toBeCloseTo(50, 9);
    const flat = dataOf<{ step: string }>(run(doc, 'export_step_ap242', { assembly: 'flat', timestamp: TIMESTAMP }));
    expect(flat.step).not.toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  }, 120_000);

  it('writes an inch document in inches with the document numbers, and the import converts exactly (VC-XCH-12)', () => {
    const expected = reference('xch-inch-box');
    const doc = built(expected.plan);
    expect(doc.units).toBe('in');
    const data = dataOf<{ step: string; unit: string }>(run(doc, 'export_step_ap242', { timestamp: TIMESTAMP }));
    expect(data.unit).toBe('in');
    const summary = summarizeStep21(data.step);
    expect(summary.lengthUnit).toEqual({ name: 'inch', mmPerUnit: 25.4 });
    const [inches] = groupFileGvp(summary, 25.4).filter((group) => group.product !== null && group.product !== 'Assembly');
    expect(relative(inches!.volume!, expected.volume)).toBeLessThan(1e-9);
    const imported = run(createEmptyDocument(), 'import_step_exact', { text: data.step });
    const report = dataOf<{ report: { exchange: { unitFactor: number; gvpCheck: { band: string } } } }>(imported).report.exchange;
    expect(report.unitFactor).toBe(25.4);
    expect(report.gvpCheck.band).toBe('green');
  }, 120_000);

  it('round-trips every analytic part: export, import, same properties, green band (VC-XCH-01 round trip)', () => {
    for (const expected of references) {
      const doc = built(expected.plan);
      const step = dataOf<{ step: string }>(run(doc, 'export_step_ap242', { timestamp: TIMESTAMP })).step;
      const back = run(createEmptyDocument(), 'import_step_exact', { text: step, fileName: `${expected.id}.stp` });
      expect(back.affected.length, expected.id).toBeGreaterThan(0);
      const exchange = dataOf<{
        report: { exchange: { gvpCheck: { band: string }; products: { band: string; embedded?: { volume: number } }[] } };
      }>(back).report.exchange;
      expect(exchange.gvpCheck.band, expected.id).toBe('green');
      const gvp = dataOf<{ items: { volume: number; area: number }[]; assemblies: { volume: number; area: number }[] }>(
        run(back.document, 'geometric_validation_properties'),
      );
      const total = [...gvp.items, ...gvp.assemblies];
      const k = MM_PER_UNIT[expected.unit as keyof typeof MM_PER_UNIT];
      expect(
        relative(
          total.reduce((sum, item) => sum + item.volume, 0),
          expected.volume * k ** 3,
        ),
        `${expected.id} volume`,
      ).toBeLessThan(1e-9);
      expect(
        relative(
          total.reduce((sum, item) => sum + item.area, 0),
          expected.area * k ** 2,
        ),
        `${expected.id} area`,
      ).toBeLessThan(1e-9);
    }
  }, 240_000);

  /** `step` with the first volume validation property multiplied by `factor` (a sender that lies about its geometry). */
  const withVolumeScaled = (step: string, factor: number): string =>
    step.replace(/VOLUME_MEASURE\(\s*([-+0-9.Ee]+)\s*\)/, (_match, value: string) => `VOLUME_MEASURE(${Number(value) * factor})`);

  it('flags a sender whose validation properties disagree: yellow warns, red marks the bodies unverified and gates the export (VC-XCH-22, -23, -24)', () => {
    const step = dataOf<{ step: string }>(
      run(built(reference('xch-plate-offset-hole').plan), 'export_step_ap242', { timestamp: TIMESTAMP }),
    ).step;
    const yellow = run(createEmptyDocument(), 'import_step_exact', { text: withVolumeScaled(step, 1.005) });
    const yellowReport = dataOf<NistLikeReport>(yellow).report;
    expect(yellowReport.exchange.gvpCheck.band).toBe('yellow');
    expect(yellowReport.warnings.map((warning) => warning.code)).toContain('XCH_GVP_YELLOW');
    expect(yellowReport.reviewRequired.reasons).toContain('import_gvp_yellow');

    const red = run(createEmptyDocument(), 'import_step_exact', { text: withVolumeScaled(step, 1.5), fileName: 'liar.stp' });
    expect(red.affected).toHaveLength(1);
    const redReport = dataOf<NistLikeReport>(red).report;
    expect(redReport.exchange.gvpCheck.band).toBe('red');
    expect(redReport.warnings.map((warning) => warning.code)).toContain('XCH_GVP_RED');
    expect(redReport.reviewRequired).toMatchObject({ value: true });
    const provenance = red.document.exchange?.provenance[red.affected[0]!];
    expect(provenance).toMatchObject({ fileName: 'liar.stp', unverified: { value: true, reasons: ['import_gvp_red'] }, sourceUnit: 'mm' });

    const refused = run(red.document, 'export_step_ap242', { timestamp: TIMESTAMP });
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('XCH_UNVERIFIED_BODIES');
    const agent = run(red.document, 'export_step_ap242', { timestamp: TIMESTAMP, acceptUnverified: true });
    expect(agent.error?.code).toBe('XCH_HUMAN_GATE');
    expect(agent.data).toBeUndefined();
    const verified = dataOf<{ band: string; issues: { code: string }[]; unverified: { value: boolean } }>(
      run(createEmptyDocument(), 'verify_exchange_file', { text: withVolumeScaled(step, 1.5) }),
    );
    expect(verified.band).toBe('red');
    expect(verified.issues.map((issue) => issue.code)).toContain('XCH_GVP_RED');
    expect(verified.unverified.value).toBe(true);
  }, 240_000);

  it('imports an assembly as components and instances: a part used twice is one component (VC-XCH-04)', () => {
    const step = dataOf<{ step: string }>(run(built('plans/xch-assembly-2x.json'), 'export_step_ap242', { timestamp: TIMESTAMP })).step;
    const back = run(createEmptyDocument(), 'import_step_exact', { text: step });
    const components = Object.values(back.document.components);
    expect(components.map((component) => component.name).sort()).toEqual(['Assembly', 'Block']);
    const instances = Object.values(back.document.entities).filter((entity) => entity.kind === 'instance');
    expect(instances).toHaveLength(1);
    const assembly = components.find((component) => component.name === 'Assembly')!;
    const uses = Object.values(assembly.entities).filter((entity) => entity.kind === 'instance');
    expect(uses).toHaveLength(2);
    expect(uses.map((use) => use.position[0]).sort((a, b) => a - b)).toEqual([0, 100]);
    expect(new Set(uses.map((use) => (use as { componentId: string }).componentId)).size).toBe(1);
    const flat = run(createEmptyDocument(), 'import_step_exact', { text: step, assembly: false });
    expect(Object.keys(flat.document.components)).toEqual([]);
    expect(flat.affected).toHaveLength(2);
  }, 120_000);
});

describeXde('XCH verify_exchange_file and hostile input', () => {
  it('reads the file claims without a kernel and compares them with a kernel (VC-XCH-05 on an own file)', () => {
    const doc = built(reference('xch-torus').plan);
    const step = dataOf<{ step: string }>(run(doc, 'export_step_ap242', { timestamp: TIMESTAMP })).step;
    const bare = execute(createEmptyDocument(), 'verify_exchange_file', { text: step }, { ...defaultContext(), kernel: null });
    expect(dataOf<{ band: string; embeddedGvp: unknown[] }>(bare).band).toBe('not-checkable');
    expect(dataOf<{ embeddedGvp: unknown[] }>(bare).embeddedGvp.length).toBeGreaterThan(0);
    const checked = dataOf<{ band: string; unitFactor: number; issues: unknown[]; unverified: { value: boolean } }>(
      run(createEmptyDocument(), 'verify_exchange_file', { text: step }),
    );
    expect(checked).toMatchObject({ band: 'green', unitFactor: 1, issues: [], unverified: { value: false } });
  }, 120_000);

  it('refuses garbage, truncated and empty files without changing the document (VC-XCH-14)', () => {
    const doc = createEmptyDocument();
    const step = dataOf<{ step: string }>(run(built(reference('xch-box').plan), 'export_step_ap242', { timestamp: TIMESTAMP })).step;
    for (const text of ['garbage', step.slice(0, 300), step.slice(0, Math.floor(step.length / 2)), '\u0000\u0001ISO-10303-21;DATA;#1=X(']) {
      const imported = run(doc, 'import_step_exact', { text });
      expect(imported.document, text.slice(0, 20)).toBe(doc);
      expect(imported.affected).toEqual([]);
      expect(imported.error?.code).toMatch(/^KRN_/);
      const verified = run(doc, 'verify_exchange_file', { text });
      expect(verified.document).toBe(doc);
    }
    expect(run(doc, 'import_step_exact', { text: '   ' }).error?.code).toBe('KRN_STEP_UNREADABLE');
  }, 120_000);

  it('refuses an export of nothing and of a mesh-only selection with a code and no data', () => {
    const empty = run(createEmptyDocument(), 'export_step_ap242');
    expect(empty.rejected).toBe(true);
    expect(empty.error?.code).toBe('XCH_NO_SOLIDS');
    expect(empty.data).toBeUndefined();
  });
});

const nistFile = (name: string): string | null => (existsSync(path.join(NIST, name)) ? path.join(NIST, name) : null);
const NIST_MISSING = nistFile('nist_ctc_01_asme1_ap242-e1.stp') === null;
if (NIST_MISSING)
  console.warn(
    `[XCH NIST] skipped: ${NIST} is empty; run python3 -I docs/aerospace/01-exact-brep-kernel/validation/fetch_nist_step_files.py`,
  );

describeNativeWhen({ capabilities: XDE, unless: NIST_MISSING ? `${NIST} has no NIST files` : null, label: 'XCH NIST' })(
  'XCH NIST CAx-IF files (provenance: docs/aerospace/04-interop-ap242-jt-iges/validation/xch_corpus.json)',
  () => {
    const importNist = (file: string): { result: CommandResult; nist: NistLikeReport } => {
      const text = readFileSync(path.join(NIST, file), 'latin1');
      const result = run(createEmptyDocument(), 'import_step_exact', { text, fileName: file });
      return { result, nist: result.data as NistLikeReport };
    };

    it('CTC-01 AP242 e1: product tree, embedded GVP matches the geometry (green); only the unattached PMI and the imported PMI (review-required) ask for review (VC-XCH-05, -23)', () => {
      const { result, nist } = importNist('nist_ctc_01_asme1_ap242-e1.stp');
      expect(result.affected.length).toBeGreaterThan(0);
      expect(nist.report.exchange.gvpCheck.band).toBe('green');
      expect(nist.report.reviewRequired.reasons).toEqual(['pmi_unmapped', 'pmi_review_required']);
    }, 180_000);

    it('STC-06: an all-zero placeholder GVP is not checkable and the bodies are unverified (VC-XCH-22)', () => {
      const { result, nist } = importNist('nist_stc_06_asme1_ap242-e3.stp');
      expect(result.affected.length).toBeGreaterThan(0);
      expect(nist.report.reviewRequired.reasons).toContain('import_gvp_not_checkable');
      const flagged = Object.values(result.document.exchange?.provenance ?? {}).filter((entry) => entry.unverified.value);
      expect(flagged.length).toBeGreaterThan(0);
    }, 180_000);

    it('CTC-02 AP242 e2: the product-level GVP agrees with the XDE geometry (green); the import completes without review (VC-XCH-05)', () => {
      // 01 KRN measured this file red on the FIRST solid of the healed shape only; the whole product (every solid of the XDE tree) matches the sender to 5e-9.
      const { result, nist } = importNist('nist_ctc_02_asme1_ap242-e2.stp');
      expect(result.affected.length).toBeGreaterThan(0);
      expect(nist.report.exchange.gvpCheck.band).toBe('green');
      expect(nist.report.reviewRequired.reasons).not.toContain('import_gvp_red');
    }, 240_000);

    it('FTC-09 AP203 in inches: unit factor 25.4, GVP converted before the comparison (VC-XCH-12)', () => {
      const { nist } = importNist('nist_ftc_09_asme1_rd.stp');
      expect(nist.report.exchange.unitFactor).toBe(25.4);
      expect(nist.report.exchange.gvpCheck.band).toBe('green');
    }, 240_000);

    it('FTC-07 e2 declares inch in the representation context of its validation properties: ratio 25.4^3 is gone, green (VC-XCH-12)', () => {
      const { nist } = importNist('nist_ftc_07_asme1_ap242-e2.stp');
      expect(nist.report.exchange.unitFactor).toBe(25.4);
      expect(nist.report.exchange.gvpCheck.band).toBe('green');
    }, 240_000);

    it('every pinned NIST AP242 / AP203 file with a real GVP is green at group scope: no sender disagrees with its own geometry (VC-XCH-05)', () => {
      const green = [
        'nist_ctc_01_asme1_ap242-e1.stp',
        'nist_ctc_02_asme1_ap242-e2.stp',
        'nist_ctc_02_asme1_rc.stp',
        'nist_ctc_03_asme1_ap242-e2.stp',
        'nist_ctc_04_asme1_ap242-e2.stp',
        'nist_ctc_05_asme1_rd.stp',
        'nist_ftc_06_asme1_ap242-e2.stp',
        'nist_ftc_07_asme1_ap242-e2.stp',
        'nist_ftc_09_asme1_rd.stp',
        'nist_stc_08_asme1_ap242-e3.stp',
        'nist_stc_10_asme1_ap242-e2.stp',
      ];
      for (const file of green) expect(importNist(file).nist.report.exchange.gvpCheck.band, file).toBe('green');
    }, 900_000);

    it('a NIST file whose sender volume is overwritten by 1.5 is red: reviewRequired, unverified bodies, and every export path refuses (VC-XCH-21, -23, -24)', () => {
      const original = readFileSync(path.join(NIST, 'nist_ctc_01_asme1_ap242-e1.stp'), 'latin1');
      const volume = /VOLUME_MEASURE\(\s*([-+0-9.Ee]+)\s*\)/g;
      const tampered = original.replace(volume, (_match, value: string) => `VOLUME_MEASURE(${Number(value) * 1.5})`);
      expect(tampered).not.toBe(original);
      const result = run(createEmptyDocument(), 'import_step_exact', { text: tampered, fileName: 'ctc01-tampered.stp' });
      const report = dataOf<NistLikeReport>(result).report;
      expect(report.exchange.gvpCheck.band).toBe('red');
      expect(report.reviewRequired.reasons).toContain('import_gvp_red');
      expect(report.warnings.map((warning) => warning.code)).toContain('XCH_GVP_RED');
      for (const name of ['export_step_ap242', 'export_step_exact', 'export_iges']) {
        const refused = run(result.document, name, {});
        expect(refused.error?.code, name).toBe('XCH_UNVERIFIED_BODIES');
        expect(refused.data, name).toBeUndefined();
        const agent = run(result.document, name, { acceptUnverified: true });
        expect(agent.error?.code, name).toBe('XCH_HUMAN_GATE');
      }
      const verified = dataOf<{ band: string }>(run(createEmptyDocument(), 'verify_exchange_file', { text: tampered }));
      expect(verified.band).toBe('red');
    }, 240_000);

    it('tolerances and datum features XCAF cannot bind are recovered from the STEP entities and the text, with their true values (VC-XCH-07)', () => {
      const pmiOf = (file: string): PmiView[] =>
        importNist(file).nist.report.exchange.products.flatMap((product) => (product.pmi === undefined ? [] : [product.pmi]));
      const tolerances = (pmi: readonly PmiView[]): PmiView['tolerances'][number][] => pmi.flatMap((entry) => [...entry.tolerances]);
      // FTC-08 and STC-07 write their magnitudes as complex records (OCC reads 0) and bind position tolerances through unnamed features (XCAF drops them)
      const ftc08 = pmiOf('nist_ftc_08_asme1_ap242-e2.stp');
      expect(tolerances(ftc08)).toHaveLength(33);
      expect(tolerances(ftc08).filter((entry) => entry.value === 0)).toEqual([]);
      expect(ftc08.flatMap((entry) => entry.datums)).toHaveLength(11);
      const stc07 = pmiOf('nist_stc_07_asme1_ap242-e3.stp');
      expect(tolerances(stc07)).toHaveLength(22);
      expect(tolerances(stc07).filter((entry) => entry.characteristic === 'position')).toHaveLength(9);
      // ten surface profiles, most against A|B|C: each value stays on its own faces whatever order XCAF lists them in
      expect(tolerances(stc07).filter((entry) => entry.value === 0)).toEqual([]);
      const onFace8 = tolerances(stc07).filter((entry) => entry.characteristic === 'profile_surface' && entry.faces.join() === '8');
      expect(onFace8.map((entry) => [entry.value, entry.datums.join('')]).sort()).toEqual([
        [0.01, 'A'],
        [0.06, 'ABC'],
      ]);
      // CTC-02: the datum features reach faces through ITEM_IDENTIFIED_REPRESENTATION_USAGE; a modified perpendicularity keeps the file's 0.1 mm
      const ctc02 = pmiOf('nist_ctc_02_asme1_ap242-e2.stp');
      // A..D are datum targets (points), K lies on a sheet product the import folds away: the solid carries the five datum features E, F, G, H, J
      expect(ctc02.flatMap((entry) => entry.datums.map((datum) => datum.label)).sort()).toEqual(['E', 'F', 'G', 'H', 'J']);
      expect(ctc02.flatMap((entry) => entry.datums).every((datum) => datum.faces.length > 0)).toBe(true);
      expect(tolerances(ctc02).filter((entry) => entry.value === 0)).toEqual([]);
    }, 600_000);

    it('CTC-01: the semantic PMI the XDE reader attaches to faces matches the census categories (VC-XCH-07)', () => {
      const { result, nist } = importNist('nist_ctc_01_asme1_ap242-e1.stp');
      expect(result.affected.length).toBeGreaterThan(0);
      const pmi = nist.report.exchange.products.flatMap((product) => (product.pmi === undefined ? [] : [product.pmi]));
      expect(pmi).toHaveLength(1);
      const count = (characteristic: string): number =>
        pmi[0]!.tolerances.filter((entry) => entry.characteristic === characteristic).length;
      // nist_pmi_gvp_reference.json census of this file: 1 flatness, 1 perpendicularity, 2 position, 2 surface profile tolerances
      expect([count('flatness'), count('perpendicularity'), count('position'), count('profile_surface')]).toEqual([1, 1, 2, 2]);
      expect(pmi[0]!.tolerances.every((entry) => entry.faces.length > 0)).toBe(true);
      expect(pmi[0]!.dimensions.filter((entry) => entry.type === 'size_diameter').length).toBeGreaterThan(0);
      expect(nist.report.exchange.pmiUnmapped).toBeGreaterThan(0);
      expect(nist.report.warnings.map((warning) => warning.code)).toContain('XCH_PMI_UNMAPPED');
    }, 180_000);

    it('truncated NIST files never throw and never change the document (VC-XCH-14)', () => {
      const text = readFileSync(path.join(NIST, 'nist_ctc_01_asme1_ap242-e1.stp'), 'latin1');
      const doc = createEmptyDocument();
      for (const fraction of [0.05, 0.3, 0.6, 0.9]) {
        const result = run(doc, 'import_step_exact', { text: text.slice(0, Math.floor(text.length * fraction)) });
        expect(result.affected, String(fraction)).toEqual([]);
        expect(result.document).toBe(doc);
      }
    }, 240_000);
  },
);

describeXde('XCH semantic PMI on faces (AP242 transport hook for 03 GD&T)', () => {
  const plateShape = (): ShapeHandle =>
    kernels.occt.evaluate({
      op: 'solid',
      entity: {
        id: 'b',
        kind: 'box',
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        size: [10, 20, 30],
        layerId: 'layer-default',
        color: '#888888',
      } as never,
    })!;

  it('writes datums, tolerances and a toleranced dimension on faces and reads them back with the faces they name', () => {
    const pmi = {
      datums: [{ label: 'A', faces: [4] }],
      tolerances: [
        { characteristic: 'flatness', value: 0.05, diameterZone: false, faces: [5], datums: [] },
        { characteristic: 'position', value: 0.2, diameterZone: true, faces: [3], datums: ['A'] },
      ],
      dimensions: [{ type: 'location_linear_distance', value: 10, tolerance: { plus: 0.1, minus: 0.2 }, faces: [0], facesSecond: [1] }],
    };
    const step = kernels.occt.writeExchange!({
      format: 'step',
      schema: 'ap242',
      unit: 'mm',
      products: [{ key: 'p', name: 'Plate', solids: [{ shape: plateShape() }], pmi }],
      occurrences: [],
      header: { fileName: 'plate.stp', originatingSystem: 'llull', timestamp: TIMESTAMP },
    } as never);
    expect(step).toBeTypeOf('string');
    const census = summarizeStep21(step!).entityCensus;
    expect([census['FLATNESS_TOLERANCE'], census['POSITION_TOLERANCE'], census['DIMENSIONAL_LOCATION'], census['DATUM']]).toEqual([
      1, 1, 1, 1,
    ]);
    const back = run(createEmptyDocument(), 'import_step_exact', { text: step! });
    const product = dataOf<NistLikeReport>(back).report.exchange.products[0]!;
    expect(product.pmi?.datums).toEqual([{ label: 'A', faces: [4] }]);
    expect(product.pmi?.tolerances.find((entry) => entry.characteristic === 'position')).toMatchObject({
      value: 0.2,
      diameterZone: true,
      faces: [3],
      datums: ['A'],
    });
    expect(product.pmi?.dimensions[0]).toMatchObject({
      type: 'location_linear_distance',
      value: 10,
      faces: [0],
      tolerance: { plus: 0.1, minus: 0.2 },
    });
    expect(dataOf<NistLikeReport>(back).report.exchange.pmiUnmapped).toBe(0);
  }, 120_000);

  it('refuses PMI the writer cannot attach (unknown face, unknown datum, non-AP242 schema) without a file', () => {
    const write = (pmi: unknown, schema = 'ap242'): string | null =>
      kernels.occt.writeExchange!({
        format: 'step',
        schema,
        unit: 'mm',
        products: [{ key: 'p', name: 'Plate', solids: [{ shape: plateShape() }], pmi }],
        occurrences: [],
        header: { fileName: 'x.stp', originatingSystem: 'llull', timestamp: TIMESTAMP },
      } as never);
    const flat = { characteristic: 'flatness', value: 0.05, diameterZone: false, faces: [5], datums: [] };
    expect(write({ datums: [], tolerances: [flat], dimensions: [] })).toBeTypeOf('string');
    expect(write({ datums: [], tolerances: [{ ...flat, faces: [99] }], dimensions: [] })).toBeNull();
    expect(write({ datums: [], tolerances: [{ ...flat, datums: ['Z'] }], dimensions: [] })).toBeNull();
    expect(write({ datums: [], tolerances: [flat], dimensions: [] }, 'ap214')).toBeNull();
  }, 120_000);
});

describeXde('XCH IGES (OCCT IGES translator)', () => {
  const available = (): boolean => (kernels.occt?.info?.().capabilities ?? []).includes('igesExchange');

  it('export_iges then import_iges rebuilds the plate and the L-bracket within the provisional 1e-6 (VC-XCH-11)', () => {
    if (!available()) return console.warn('[XCH IGES] skipped: the kernel build has no TKDEIGES');
    for (const id of ['xch-plate-centre-hole', 'xch-l-bracket']) {
      const expected = reference(id);
      const written = run(built(expected.plan), 'export_iges');
      const data = dataOf<{ iges: string; selfCheck: { band: string }; entities: number }>(written);
      expect(data.selfCheck.band, id).toBe('green');
      expect(data.entities).toBeGreaterThan(0);
      const back = run(createEmptyDocument(), 'import_iges', { text: data.iges });
      expect(back.affected.length, id).toBe(1);
      const gvp = dataOf<{ items: { volume: number; area: number; centroid: number[] }[] }>(
        run(back.document, 'geometric_validation_properties'),
      ).items[0]!;
      expect(relative(gvp.volume, expected.volume), id).toBeLessThan(1e-6);
      expect(relative(gvp.area, expected.area), id).toBeLessThan(1e-6);
      const report = dataOf<{ iges: { unitFactor: number; openShells: number }; report: { reviewRequired: { value: boolean } } }>(back);
      expect(report.iges).toMatchObject({ unitFactor: 1, openShells: 0 });
      expect(report.report.reviewRequired.value).toBe(true);
      const provenance = Object.values(back.document.exchange?.provenance ?? {})[0];
      expect(provenance).toMatchObject({ format: 'iges', unverified: { value: true } });
    }
  }, 240_000);

  it('verify_exchange_file reads the IGES census and refuses a truncated file', () => {
    if (!available()) return console.warn('[XCH IGES] skipped: the kernel build has no TKDEIGES');
    const iges = dataOf<{ iges: string }>(run(built(reference('xch-box').plan), 'export_iges')).iges;
    const verified = dataOf<{ format: string; entities: number; unitFactor: number; census: Record<string, number> }>(
      run(createEmptyDocument(), 'verify_exchange_file', { text: iges }),
    );
    expect(verified).toMatchObject({ format: 'iges', unitFactor: 1 });
    expect(verified.census['186']).toBe(1);
    const cut = run(createEmptyDocument(), 'verify_exchange_file', { text: iges.slice(0, 600) });
    expect(cut.error?.code).toBe('KRN_STEP_UNREADABLE');
    const garbage = run(createEmptyDocument(), 'import_iges', { text: 'x'.repeat(200) });
    expect(garbage.affected).toEqual([]);
    expect(garbage.error?.code).toBe('KRN_STEP_UNREADABLE');
  }, 240_000);
});
