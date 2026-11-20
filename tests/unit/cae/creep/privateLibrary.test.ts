/** PHY-11 VC-CRP-66 (FR-CRP-20): a creep law from a private material library never shows its coefficients in creep_report, nor in a saved file. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { MaterialLibraryEntry } from '@core/model/materialLibrary';
import type { CadDocument } from '@core/model/types';
import { creepCube, holdFrd, solveCube } from './support';

const PRELOAD = 1e-3;
const REF = { libraryId: 'nims-fit', version: '3', sha256: 'a'.repeat(64) };
const ENTRY: MaterialLibraryEntry = {
  ...REF,
  title: 'Company creep fits',
  storage: 'private',
  licence: 'licensed-no-redistribution',
  exportMarking: { regime: 'none' },
};

/** The VC-CRP-40 cube, solved, with its material turned into a record of library `entry` (the record is not part of the input hash). */
function solvedWithRecord(entry: MaterialLibraryEntry | null): ReturnType<typeof solveCube> & { analysisId: string } {
  const c = creepCube({ probes: [{ name: 'centre', quantity: 'ceeq' }] });
  const material = c.doc.materials['norton'];
  if (material === undefined) throw new Error('fixture material missing');
  const doc: CadDocument = {
    ...c.doc,
    materials: {
      ...c.doc.materials,
      norton: {
        ...material,
        record: {
          id: 'norton',
          designation: 'Norton steel',
          specs: [],
          licence: entry?.licence ?? 'company-proprietary',
          exportMarking: { regime: 'none' },
          libraryRef: REF,
        },
      },
    },
    ...(entry !== null ? { materialLibraries: { [entry.libraryId]: entry } } : {}),
  };
  return { ...solveCube({ ...c, doc }, holdFrd(PRELOAD), doc), analysisId: c.analysisId };
}

interface LawRow {
  readonly A?: unknown;
  readonly n?: unknown;
  readonly m?: unknown;
  readonly coefficients?: string;
  readonly redacted?: boolean;
  readonly library?: Record<string, unknown>;
  readonly basis?: string;
  readonly source?: string;
}
const lawsOf = (data: unknown): readonly LawRow[] => (data as { laws: readonly LawRow[] }).laws;

describe('creep_report private-library redaction (VC-CRP-66)', () => {
  it('a private-library law shows provenance and the redaction marker, no A / n / m and no quick-check value; is pure', () => {
    const { doc, ctx, analysisId } = solvedWithRecord(ENTRY);
    const before = structuredClone(doc);
    const result = execute(doc, 'creep_report', { analysisId }, ctx);
    expect(result.error).toBeUndefined();
    expect(doc).toEqual(before);
    const [law] = lawsOf(result.data);
    expect(law).toMatchObject({
      redacted: true,
      library: {
        libraryId: 'nims-fit',
        version: '3',
        storage: 'private',
        licence: 'licensed-no-redistribution',
        title: 'Company creep fits',
      },
      basis: 'company',
      source: 'synthetic test fixture',
    });
    expect(law?.coefficients).toMatch(/^private/);
    expect(law).not.toHaveProperty('A');
    expect(law).not.toHaveProperty('n');
    expect(law).not.toHaveProperty('m');
    const data = result.data as { redacted?: boolean; quickCheck: Record<string, unknown>; maxCeeq: { value: number } };
    expect(data.redacted).toBe(true);
    expect(data.quickCheck).toEqual({ check: 'norton_constant_stress', available: false, redacted: true, reason: expect.any(String) });
    expect(data.maxCeeq.value).toBeCloseTo(0.32, 9);
    expect(JSON.stringify(result.data)).not.toContain('1e-10');
    expect(result.summary).toContain("law coefficients withheld (private library 'nims-fit')");
  });

  it('a pin to an undeclared library is private too (fail-closed)', () => {
    const { doc, ctx, analysisId } = solvedWithRecord(null);
    const [law] = lawsOf(execute(doc, 'creep_report', { analysisId }, ctx).data);
    expect(law).toMatchObject({
      redacted: true,
      library: { libraryId: 'nims-fit', storage: 'undeclared', licence: 'company-proprietary' },
    });
  });

  it('a law of an embedded (public) library keeps its coefficients and the quick check', () => {
    const { doc, ctx, analysisId } = solvedWithRecord({ ...ENTRY, storage: 'embedded', licence: 'open-data' });
    const result = execute(doc, 'creep_report', { analysisId }, ctx);
    const [law] = lawsOf(result.data);
    expect(law).toMatchObject({ A: { value: 1e-10, unit: 'MPa^-n s^-(m+1)' }, n: 5, m: 0 });
    expect(law).not.toHaveProperty('redacted');
    expect(result.data).not.toHaveProperty('redacted');
    expect((result.data as { quickCheck: { ratioFeToClosedForm: number } }).quickCheck.ratioFeToClosedForm).toBeCloseTo(1, 6);
  });

  it('an embedded library with a licensed-no-redistribution licence is redacted', () => {
    const { doc, ctx, analysisId } = solvedWithRecord({ ...ENTRY, storage: 'embedded' });
    expect(lawsOf(execute(doc, 'creep_report', { analysisId }, ctx).data)[0]).toMatchObject({ redacted: true });
  });

  it('save, reload without the library: no law coefficients in the file; creep_report answers available: false (MAT_LIBRARY_UNRESOLVED)', () => {
    const { doc, ctx, analysisId } = solvedWithRecord(ENTRY);
    const saved = serializeDocument(doc);
    // the fixture adds the law before the material becomes a record, so the history holds it; a library record is read-only (MAT_RECORD_READONLY)
    const materials = JSON.stringify((JSON.parse(saved) as { document: { materials: unknown } }).document.materials);
    expect(materials).not.toContain('creep_norton');
    expect(materials).not.toContain('1e-10');
    const reloaded = deserializeDocument(saved);
    expect(reloaded.materials['norton']?.record?.unresolved).toBeDefined();
    const result = execute(reloaded, 'creep_report', { analysisId }, ctx);
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('MAT_LIBRARY_UNRESOLVED');
    expect(result.error?.remediation).toContain('resolve_material_libraries');
    expect(result.data).toMatchObject({
      available: false,
      code: 'MAT_LIBRARY_UNRESOLVED',
      materials: [{ materialId: 'norton', reason: 'provider missing', library: { libraryId: 'nims-fit' } }],
    });
    expect(result.document).toBe(reloaded);
  });
});

describe('check_creep on an unresolved private-library stub', () => {
  it('names MAT_LIBRARY_UNRESOLVED (not CRP_LAW_MISSING) for the part', () => {
    const { doc, ctx, analysisId } = solvedWithRecord(ENTRY);
    const reloaded = deserializeDocument(serializeDocument(doc));
    const items = (execute(reloaded, 'check_creep', { analysisId }, ctx).data as { items: readonly { code: string; severity: string }[] })
      .items;
    expect(items).toContainEqual(expect.objectContaining({ code: 'MAT_LIBRARY_UNRESOLVED', severity: 'error' }));
    expect(items.map((item) => item.code)).not.toContain('CRP_LAW_MISSING');
  });
});

describe('privateLibraryOf / unresolvedPartMaterials', () => {
  it('null for an unknown material or one without a record; groups the parts of one unresolved material; skips parts without a material', async () => {
    const { privateLibraryOf, unresolvedPartMaterials } = await import('@cae/creep/privateLaw');
    const { doc } = solvedWithRecord(ENTRY);
    const plain = creepCube().doc;
    expect(privateLibraryOf(plain, 'missing')).toBeNull();
    expect(privateLibraryOf(plain, 'norton')).toBeNull();
    const reloaded = deserializeDocument(serializeDocument(doc));
    const [box = ''] = reloaded.order;
    const entity = reloaded.entities[box];
    if (entity === undefined) throw new Error('fixture entity missing');
    const twin: CadDocument = {
      ...reloaded,
      entities: { ...reloaded.entities, twin: { ...entity, id: 'twin' }, bare: { ...entity, id: 'bare', materialId: undefined } },
    };
    expect(unresolvedPartMaterials(twin, [box, 'twin', 'bare', 'ghost'])).toEqual([
      {
        materialId: 'norton',
        parts: [box, 'twin'],
        reason: 'provider missing',
        library: expect.objectContaining({ libraryId: 'nims-fit' }),
      },
    ]);
  });
});
