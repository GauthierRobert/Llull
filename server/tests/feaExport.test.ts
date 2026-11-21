/** fea_export (FR-CRP-20): a deck of a case whose part has a private-library creep law is never exported; the VTU and public laws are unaffected. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { FeaToolResult } from '@protocol/index';
import { runFeaExport } from '../src/fea/feaExport';
import { caeHooks } from '../src/fea/caeHooks';
import { createFeArtifactStore } from '../src/fea/artifactStore';

const SOURCE = { citation: 'synthetic test fixture' };

function step(doc: CadDocument, name: string, params: unknown): { doc: CadDocument; affected: readonly string[] } {
  const result = execute(doc, name, params);
  if (result.rejected === true) throw new Error(result.summary);
  return { doc: result.document, affected: result.affected };
}

/** A creep case on a cube of material 'norton' (elastic + Norton set); `record`: the material is a record of a private licensed library. */
function creepCase(record: boolean): { doc: CadDocument; analysisId: string } {
  const box = step(createEmptyDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
  const cube = box.affected[0] ?? '';
  let doc = step(box.doc, 'create_material', { name: 'norton', density: 0.0078, color: '#9aa0a6', metalness: 1, roughness: 0.4 }).doc;
  doc = step(doc, 'add_material_model', {
    material: 'norton',
    id: 'el',
    model: { kind: 'elastic_isotropic', E: { value: 210000, unit: 'MPa' }, nu: { value: 0.3, unit: '1' } },
    basis: 'company',
    source: SOURCE,
  }).doc;
  doc = step(doc, 'add_material_model', {
    material: 'norton',
    id: 'creep',
    model: { kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 's', hardening: 'time' },
    basis: 'company',
    source: SOURCE,
  }).doc;
  doc = step(doc, 'define_constitutive_set', {
    material: 'norton',
    set: { id: 'cr', elastic: 'el', creep: 'creep' },
    makeDefault: true,
  }).doc;
  doc = step(doc, 'assign_material', { materialName: 'norton', entityIds: [cube] }).doc;
  const created = step(doc, 'create_analysis', { name: 'c', analysisType: 'creep' });
  const analysisId = created.affected[0] ?? '';
  doc = step(created.doc, 'set_part_idealization', { analysisId, entityId: cube }).doc;
  if (!record) return { doc, analysisId };
  const material = doc.materials['norton'];
  if (material === undefined) throw new Error('fixture material missing');
  const ref = { libraryId: 'nims-fit', version: '1', sha256: 'b'.repeat(64) };
  return {
    analysisId,
    doc: {
      ...doc,
      materials: {
        ...doc.materials,
        norton: {
          ...material,
          record: {
            id: 'norton',
            designation: 'N',
            specs: [],
            licence: 'licensed-no-redistribution',
            exportMarking: { regime: 'none' },
            libraryRef: ref,
          },
        },
      },
      materialLibraries: {
        'nims-fit': { ...ref, title: 'fits', storage: 'private', licence: 'licensed-no-redistribution', exportMarking: { regime: 'none' } },
      },
    },
  };
}

const run = (doc: CadDocument, analysisId: string, format?: 'calculix_inp' | 'nastran_bdf' | 'vtu'): FeaToolResult => {
  const store = createFeArtifactStore(mkdtempSync(path.join(tmpdir(), 'llull-feaexport-')));
  const host = { getDoc: () => doc, applyCommand: () => ({ summary: '', affected: [], isError: true }) };
  return runFeaExport(analysisId, host, { store, hooks: caeHooks }, format === undefined ? {} : { format });
};

describe('fea_export of a private-library creep law', () => {
  it('refuses the CalculiX and Nastran decks with CRP_LAW_PRIVATE and no coefficient in the answer', () => {
    const { doc, analysisId } = creepCase(true);
    for (const format of [undefined, 'nastran_bdf'] as const) {
      const result = run(doc, analysisId, format);
      expect(result.isError).toBe(true);
      expect(result.data).toEqual({ code: 'CRP_LAW_PRIVATE' });
      expect(result.affected).toEqual(['norton']);
      expect(JSON.stringify(result)).not.toContain('1e-10');
      expect(JSON.stringify(result)).not.toContain('*CREEP');
    }
  });

  it('the VTU and a public law go on to the mesh check (no CRP_LAW_PRIVATE)', () => {
    const priv = creepCase(true);
    expect((run(priv.doc, priv.analysisId, 'vtu').data as { code?: string }).code).not.toBe('CRP_LAW_PRIVATE');
    const pub = creepCase(false);
    const result = run(pub.doc, pub.analysisId);
    expect(result.isError).toBe(true);
    expect((result.data as { code?: string }).code).not.toBe('CRP_LAW_PRIVATE');
  });
});
