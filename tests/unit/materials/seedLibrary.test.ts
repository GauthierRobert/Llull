/** 08 MAT M4 / VC-MAT-18: the seed library is generated from the VERIFIED dataset entries only and every value is traceable. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import { BASES } from '@core/model/propertyModel';
import { call, dataOf, mmDocument, step } from './support';

const root = process.cwd();
const read = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const seed = read('packages/domain-aero/data/seed.llull-matlib.json') as Record<string, unknown>;
const lock = read('packages/domain-aero/data/sources.lock.json') as {
  sources: Record<string, { sha256: string | null; unpinned?: { reason: string }; milHdbk5J?: boolean; url: string }>;
};
const dataset = read('docs/aerospace/08-materials-standards-libraries/validation/materials_dataset.json') as {
  materials: Array<Record<string, unknown>>;
  fastenerMaterialAllowables: Array<Record<string, unknown>>;
};

/** Sources whose primary file could not be fetched (HTTP 403 from the build sandbox): the ONLY unpinned ones allowed. */
const UNPINNED = ['S13', 'S15', 'S16', 'S21', 'S22', 'S26', 'S38'];
const EXCLUDED_SOURCES = ['S10', 'S12'];

interface SeedModel {
  id: string;
  basis: string;
  provenance: { sourceId?: string; citation?: string; locator?: string };
}
const materials = seed['materials'] as Array<{ id: string; superseded?: unknown; propertyModels: SeedModel[] }>;
const models = materials.flatMap((material) => material.propertyModels.map((model) => ({ material: material.id, model })));

describe('seed library (VC-MAT-18)', () => {
  it('is a valid llull material library', () => {
    const parsed = parseMaterialLibrary(seed);
    expect(parsed.ok).toBe(true);
    expect(seed['storage']).toBe('embedded');
    expect(seed['licence']).toBe('vendor-catalogue');
  });

  it('gives every value a basis, a sourceId present in sources.lock.json, a citation and a locator', () => {
    expect(models.length).toBeGreaterThan(0);
    for (const { material, model } of models) {
      const where = `${material}.${model.id}`;
      expect(BASES as readonly string[], where).toContain(model.basis);
      expect(model.provenance.sourceId, where).toBeDefined();
      expect(Object.keys(lock.sources), where).toContain(model.provenance.sourceId);
      expect(model.provenance.citation, where).toBeTruthy();
      expect(model.provenance.locator, where).toBeTruthy();
      expect(Object.keys(seed['sources'] as object), where).toContain(model.provenance.sourceId);
    }
  });

  it('pins each source by sha256, or states why not; only the sources whose file could not be fetched are unpinned', () => {
    const unpinned = Object.entries(lock.sources)
      .filter(([, source]) => source.sha256 === null)
      .map(([id]) => id)
      .sort();
    expect(unpinned).toEqual(UNPINNED);
    for (const [id, source] of Object.entries(lock.sources)) {
      if (source.sha256 === null) expect(source.unpinned?.reason, id).toBeTruthy();
      else expect(source.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(source.url, id).toMatch(/^https:\/\//);
    }
  });

  it('sets superseded on every material that cites a MIL-HDBK-5J source, and only on those', () => {
    for (const material of materials) {
      const fromMil = material.propertyModels.some((model) => lock.sources[model.provenance.sourceId ?? '']?.milHdbk5J === true);
      expect(material.superseded !== undefined, material.id).toBe(fromMil);
    }
  });

  it('bundles exactly the verified, redistributable dataset values and nothing else', () => {
    let expected = 0;
    const count = (entries: Record<string, unknown>): void => {
      for (const entry of Object.values(entries)) {
        const value = entry as { status?: string; source?: string };
        if (value?.status === 'verified' && !EXCLUDED_SOURCES.includes(value.source ?? '')) expected += 1;
      }
    };
    for (const material of dataset.materials) {
      count((material['physical'] ?? {}) as Record<string, unknown>);
      count((material['mechanical'] ?? {}) as Record<string, unknown>);
    }
    for (const row of dataset.fastenerMaterialAllowables) count(row);
    expect(models.length).toBe(expected);
    const cited = new Set(models.map(({ model }) => model.provenance.sourceId));
    for (const excluded of EXCLUDED_SOURCES) expect(cited.has(excluded)).toBe(false);
  });

  it('is current: the committed files equal a fresh build of the dataset', () => {
    expect(() => execFileSync('node', ['scripts/build-seed-library.mjs', '--check'], { cwd: root, stdio: 'pipe' })).not.toThrow();
  });

  it('marks a value read from MIL-HDBK-5J as superseded and refuses an unverified or unmapped value (generator)', () => {
    const script = `
      const { buildSeed } = await import(${JSON.stringify(resolve(root, 'scripts/build-seed-library.mjs'))});
      const entry = (status, source) => ({ value: 65, unit: 'ksi', basis: 'A', status, source });
      const make = (mechanical) => ({ materials: [{ id: 'm', designation: 'x', specs: [], physical: {}, mechanical }], fastenerMaterialAllowables: [] });
      const mil = buildSeed(make({ Ftu_L: entry('verified', 'S38') })).library.materials[0];
      const none = buildSeed(make({ Ftu_L: entry('secondary_unconfirmed', 'S38'), Fty_L: entry('tbd', 'S38') })).library.materials.length;
      let unmapped = '';
      try { buildSeed(make({ Zzz_L: entry('verified', 'S38') })); } catch (error) { unmapped = String(error.message); }
      process.stdout.write(JSON.stringify({ superseded: mil.superseded, none, unmapped }));
    `;
    const out = JSON.parse(execFileSync('node', ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' })) as {
      superseded: { by: string };
      none: number;
      unmapped: string;
    };
    expect(out.superseded.by).toBe('MMPDS');
    expect(out.none).toBe(0);
    expect(out.unmapped).toContain('no property mapping');
  });
});

describe('seed library installed through import_material_library', () => {
  it('imports as read-only records whose values carry basis, sourceId and locator; S-basis is not flagged unverified, typical is', () => {
    const doc = step(mmDocument(), 'import_material_library', { library: seed });
    expect(doc.materialLibraries?.['llull-aero-seed']?.licence).toBe('vendor-catalogue');
    expect(Object.keys(doc.materials)).toEqual(expect.arrayContaining(materials.map((material) => material.id)));
    const fsu = call(doc, 'get_material_allowable', { material: 'nas6203_bolt_alloy_steel', property: 'Fsu', basis: 'S' });
    expect(dataOf(fsu)).toMatchObject({
      available: true,
      value: 95,
      unit: 'ksi',
      basis: 'S',
      unverified: false,
      reviewRequired: true,
      provenance: { sourceId: 'S22' },
    });
    const ftu = call(doc, 'get_material_allowable', {
      material: 'ti6al4v_annealed',
      property: 'Ftu',
      basis: 'typical',
      thickness: { value: 0.1, unit: 'in' },
    });
    expect(dataOf(ftu)).toMatchObject({ value: 134, basis: 'typical', unverified: true });
    const asA = call(doc, 'get_material_allowable', { material: 'nas6203_bolt_alloy_steel', property: 'Fsu', basis: 'A' });
    expect(asA.error?.code).toBe('MAT_ALLOWABLE_NOT_AVAILABLE');
  });
});
