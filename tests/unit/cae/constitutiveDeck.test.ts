import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { buildDeckContext } from '@cae/decks/context';
import { constitutiveMaterialCards, deckConstitutiveViews } from '@cae/decks/constitutive';
import { writeInp } from '@cae/decks/inpWriter';
import { caseOf, withCase } from '@cae/shared/access';
import { parseFrd } from '@cae/results/frdReader';
import { GPa, MPa, NL1_VALIDITY, ONE, T293, addModel, defineSet } from '../physics/materials/materialFixtures';
import { X0_NODES, X2_NODES, barDocument, barMesh, mustRun } from './deckFixtures';

const J2 = (yieldStress: number): Record<string, unknown> => ({
  kind: 'j2_plasticity',
  isotropic: { kind: 'perfect', yieldStress: MPa(yieldStress) },
  kinematic: { kind: 'none' },
});

const ELASTIC = { kind: 'elastic_isotropic', E: GPa(210), nu: ONE(0.3) };

interface PlasticBar {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly boxId: string;
  readonly constraints: Record<string, string>;
}

/** The steel bar of the deck fixtures with a second, default constitutive set `nl` (elastic + J2 perfect plasticity, yield 100 MPa). */
function plasticBar(basis = 'A'): PlasticBar {
  const bar = barDocument();
  let doc = addModel(bar.doc, 'steel', 'elasticv', ELASTIC, { validity: T293, basis });
  doc = addModel(doc, 'steel', 'j2', J2(100), { validity: NL1_VALIDITY, basis });
  doc = defineSet(doc, 'steel', { id: 'nl', elastic: 'elasticv', plastic: 'j2' }, true);
  return { doc, analysisId: bar.analysisId, boxId: bar.boxId, constraints: bar.constraints };
}

const supportSets = (constraints: Record<string, string>): Record<string, number[]> => ({
  [`C_${constraints['x0']}`]: X0_NODES,
  [`C_${constraints['nodeA']}`]: [1],
  [`C_${constraints['nodeB']}`]: [3],
});

const deckOf = (bar: PlasticBar): string => {
  const written = writeInp(bar.doc, bar.analysisId, barMesh(bar.doc, bar.analysisId, bar.boxId, supportSets(bar.constraints)));
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  return written.text;
};

const exportedCards = (bar: PlasticBar, name: string): { lines: string[]; header: string; unverified: boolean } => {
  const exported = execute(bar.doc, 'export_material_cards', { material: 'steel', set: 'nl', target: 'calculix', name });
  const data = exported.data as { lines: string[]; header: string; unverified: boolean };
  return data;
};

describe('constitutive sets in the CalculiX deck (MaterialCardWriter hook)', () => {
  it('writes the same material block as export_material_cards (single implementation) plus the density', () => {
    const bar = plasticBar();
    const text = deckOf(bar);
    const exported = exportedCards(bar, 'M_1');
    expect(exported.lines.some((line) => line.startsWith('*PLASTIC'))).toBe(true);
    const start = text.indexOf(exported.lines[0] ?? '');
    expect(start).toBeGreaterThan(0);
    expect(text).toContain(`** material M_1 = 'steel'\n${exported.header}\n${exported.lines.join('\n')}\n*DENSITY\n`);
    expect(text).not.toContain('*MATERIAL, NAME=M_1');
    expect(text).toContain('*SOLID SECTION, ELSET=P_box_1_1, MATERIAL=M_1');
  });

  it('keeps elastic-only decks byte-identical: no constitutive hook output', () => {
    const bar = barDocument();
    const text = deckOf({ ...bar });
    expect(text).toContain("** material M_1 = 'steel'\n*MATERIAL, NAME=M_1\n*ELASTIC\n210000, 0.3\n*DENSITY\n");
    expect(text).not.toContain('llull material');
    const ctx = buildDeckContext(bar.doc, bar.analysisId, barMesh(bar.doc, bar.analysisId, bar.boxId, {}));
    expect(ctx).not.toBeNull();
    if (ctx !== null) {
      expect(constitutiveMaterialCards(ctx, bar.boxId)).toBeNull();
      expect(deckConstitutiveViews(ctx)).toEqual([]);
    }
  });

  it('propagates unverified / reviewRequired from the view into the deck header', () => {
    const verified = plasticBar('A');
    expect(deckOf(verified)).toContain('unverified=none');
    expect(deckOf(verified)).not.toContain('** UNVERIFIED');
    const unverified = plasticBar('unspecified');
    const text = deckOf(unverified);
    const exported = exportedCards(unverified, 'M_1');
    expect(exported.unverified).toBe(true);
    expect(text).toContain(exported.header);
    expect(text).toContain("** UNVERIFIED: elastic 'elasticv': basis unspecified; plastic 'j2': basis unspecified");
    const mesh = barMesh(unverified.doc, unverified.analysisId, unverified.boxId, {});
    const ctx = buildDeckContext(unverified.doc, unverified.analysisId, mesh);
    const views = ctx === null ? [] : deckConstitutiveViews(ctx);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ recordId: 'steel', setId: 'nl', unitSystem: 'N-mm-t-s', unverified: true, reviewRequired: false });
    expect(Object.keys(views[0]?.laws ?? {})).toEqual(['elastic', 'plastic']);
    expect(views[0]?.unverifiedReasons).toContain("plastic 'j2': basis unspecified");
  });

  it('flags reviewRequired for a fitted model nobody reviewed', () => {
    const bar = plasticBar('A');
    const model = bar.doc.materials['steel']?.materialModels?.find((candidate) => candidate.id === 'j2');
    expect(model).toBeDefined();
    if (model === undefined) return;
    const fitted = {
      ...model,
      fit: { kind: 'j2_plasticity', fittedRange: [], residual: 0, objective: 'absolute', iterations: 1, dataProvenance: undefined },
    };
    const doc: CadDocument = {
      ...bar.doc,
      materials: {
        ...bar.doc.materials,
        steel: {
          ...(bar.doc.materials['steel'] as NonNullable<(typeof bar.doc.materials)[string]>),
          materialModels: (bar.doc.materials['steel']?.materialModels ?? []).map((candidate) =>
            candidate.id === 'j2' ? (fitted as unknown as typeof candidate) : candidate,
          ),
        },
      },
    };
    const mesh = barMesh(doc, bar.analysisId, bar.boxId, supportSets(bar.constraints));
    const written = writeInp(doc, bar.analysisId, mesh);
    expect('text' in written && written.text).toContain('** REVIEW REQUIRED');
  });

  it('refuses a law CalculiX cannot write with MATL_EXPORT_UNSUPPORTED', () => {
    const bar = plasticBar();
    const withModel = addModel(
      bar.doc,
      'steel',
      'prony',
      { kind: 'visco_prony', shear: [{ g: 0.3, tau: { value: 1, unit: 's' } }] },
      { validity: T293, basis: 'A' },
    );
    const retried = defineSet(withModel, 'steel', { id: 'vis', elastic: 'elasticv', viscoelastic: 'prony' }, true);
    const written = writeInp(retried, bar.analysisId, barMesh(retried, bar.analysisId, bar.boxId, supportSets(bar.constraints)));
    expect('code' in written && written.code).toBe('MATL_EXPORT_UNSUPPORTED');
    expect('code' in written && written.ids).toEqual([bar.boxId]);
  });

  it('refuses a missing-validity model and a unit system other than N-mm-t-s', () => {
    const noValidity = barDocument();
    let doc = addModel(noValidity.doc, 'steel', 'j2', J2(100), { basis: 'A' });
    doc = defineSet(doc, 'steel', { id: 'nl', elastic: 'elastic', plastic: 'j2' }, true);
    const mesh = barMesh(doc, noValidity.analysisId, noValidity.boxId, supportSets(noValidity.constraints));
    const missing = writeInp(doc, noValidity.analysisId, mesh);
    expect('code' in missing && missing.code).toBe('MATL_VALIDITY_MISSING');

    const bar = plasticBar();
    const analysis = caseOf(bar.doc, bar.analysisId);
    expect(analysis).toBeDefined();
    if (analysis === undefined) return;
    const metric = withCase(bar.doc, { ...analysis, unitSystem: 'N-m-kg-s' });
    const written = writeInp(metric, bar.analysisId, { ...barMesh(metric, bar.analysisId, bar.boxId, {}), unitSystem: 'N-m-kg-s' });
    expect('code' in written && written.code).toBe('MATL_EXPORT_UNSUPPORTED');
  });

  it('refuses a set whose elastic law is missing the validity combination: creep without elastic', () => {
    const bar = plasticBar();
    const broken: CadDocument = {
      ...bar.doc,
      materials: {
        ...bar.doc.materials,
        steel: {
          ...(bar.doc.materials['steel'] as NonNullable<(typeof bar.doc.materials)[string]>),
          constitutiveSets: [{ id: 'nl', plastic: 'j2' }],
          defaultConstitutiveSet: 'nl',
        },
      },
    };
    const written = writeInp(broken, bar.analysisId, barMesh(broken, bar.analysisId, bar.boxId, supportSets(bar.constraints)));
    expect('code' in written && written.code).toBe('MATL_COMBINATION_INVALID');
  });

  it('writes a hyperelastic-only set (no elastic law) through the hook', () => {
    const bar = barDocument();
    let doc = addModel(
      bar.doc,
      'steel',
      'neo',
      { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: { value: 0.001, unit: '1/MPa' } },
      { validity: [{ variable: 'stretch', unit: '1', data: [0.5, 2] }], basis: 'A' },
    );
    doc = defineSet(doc, 'steel', { id: 'rubber', hyperelastic: 'neo' }, true);
    const written = writeInp(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, supportSets(bar.constraints)));
    expect('text' in written && written.text).toContain('*HYPERELASTIC,NEO HOOKE');
  });
});

const CCX = process.env['LLULL_CCX'] ?? 'ccx';
const hasCcx = spawnSync(CCX, ['-v']).error === undefined;

describe.skipIf(!hasCcx)('CalculiX single-element read of the constitutive deck', () => {
  it('perfect plasticity (yield 100 MPa) caps the uniaxial stress of a pulled bar at the yield', () => {
    const bar = plasticBar();
    const pull = execute(bar.doc, 'add_fea_constraint', {
      analysisId: bar.analysisId,
      name: 'pull',
      kind: 'displacement',
      dofs: { ux: 0.002 },
      target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
    });
    const doc = mustRun(pull.document, 'add_fea_load', { analysisId: bar.analysisId, name: 'g', kind: 'gravity', vector: [0, 0, 0] });
    const sets = { ...supportSets(bar.constraints), [`C_${pull.affected[0]}`]: X2_NODES };
    const written = writeInp(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, sets));
    if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
    const dir = mkdtempSync(join(tmpdir(), 'llull-ccx-'));
    try {
      writeFileSync(join(dir, 'job.inp'), written.text);
      const ran = spawnSync(CCX, ['-i', 'job'], { cwd: dir, encoding: 'utf8' });
      if (ran.status !== 0) throw new Error(`ccx failed: ${ran.stdout}\n${ran.stderr}`);
      const steps = parseFrd(readFileSync(join(dir, 'job.frd'), 'utf8'));
      for (const values of Object.values(steps[0]?.fields['STRESS']?.values ?? {}))
        expect(Math.abs((values[0] ?? 0) - 100) / 100).toBeLessThan(1e-3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
