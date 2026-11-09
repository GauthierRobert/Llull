import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { type BondData, type PlanRun, checkBonding, oracle, run, runPlan } from './fixtures';

const SRC = { citation: 'test input (not a property claim)' };
const joint = (mohm: number, interfaces?: [string, string]): Record<string, unknown> => ({
  kind: 'joint',
  resistance: { value: mohm, unit: 'mohm' },
  source: SRC,
  ...(interfaces === undefined ? {} : { interfaces }),
});
const strap = (material = 'strap_61iacs'): Record<string, unknown> => ({
  kind: 'strap',
  material,
  length: { value: 150, unit: 'mm' },
  crossSection: { value: 10, unit: 'mm^2' },
});
const LIMIT = { value: 2.5, unit: 'mohm', ruleId: 'bond_class_R_test', source: SRC };

/** The validation plan up to (not including) its check_bonding step: box on structure, strap record, paths p1 (pass) and p2 (fail). */
const base = (): PlanRun => runPlan('eop_bonding_paths.plan.json', 'check_bonding');

const addPath = (
  doc: CadDocument,
  box: string,
  structure: string,
  params: Record<string, unknown>,
): { result: CommandResult; path: string } => {
  const result = execute(doc, 'define_bond_path', { name: 'extra', from: box, to: structure, elements: [strap()], ...params });
  return { result, path: result.affected[0] ?? '' };
};

const material = (doc: CadDocument, name: string): CadDocument =>
  run(doc, 'create_material', { name, density: 0.0028, color: '#cccccc', metalness: 1, roughness: 0.3 });

describe('check_bonding: the validation plan (AC-1, VC-EOP-06)', () => {
  const { doc, aliases } = base();
  const data = checkBonding(doc);
  const [p1, p2] = [aliases['p1'] ?? '', aliases['p2'] ?? ''];
  const row = (id: string): BondData['rows'][number] | undefined => data.rows.find((item) => item.pathId === id);

  it('sums joints and the strap R = rho L / A to the generator values', () => {
    expect(row(p1)?.totalOhm).toBeCloseTo(oracle('VC-EOP-06.a'), 12);
    expect(row(p2)?.totalOhm).toBeCloseTo(oracle('VC-EOP-06.c'), 12);
    expect(row(p1)?.totalMilliohm).toBeCloseTo(1.723959016, 8);
    const strapOhm = row(p1)?.elements[1]?.ohm ?? 0;
    expect(Math.abs(strapOhm - 0.000423959016393) / 0.000423959016393).toBeLessThan(1e-9);
  });

  it('shares sum to 1 and carry provenance', () => {
    const shares = row(p1)?.elements.map((element) => element.share ?? 0) ?? [];
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(row(p1)?.elements[1]?.provenance).toContain('R = rho L / A');
    expect(row(p1)?.elements[0]?.provenance).toContain('test input');
  });

  it('p1 passes and p2 fails with EOP_BOND_RESISTANCE_EXCEEDED; both need review and carry an unverified limit with its source', () => {
    expect(row(p1)).toMatchObject({
      status: 'pass',
      code: null,
      disposition: 'none',
      reviewRequired: true,
      limit: { unverified: true, ruleId: 'bond_class_R_test' },
    });
    expect(row(p2)).toMatchObject({
      status: 'fail',
      code: 'EOP_BOND_RESISTANCE_EXCEEDED',
      disposition: 'pending_human',
      reviewRequired: true,
    });
    expect(row(p2)?.limit?.source).toContain('unverified');
    expect(row(p1)?.unverifiedReasons.join(' ')).toContain('EOP_LIMIT_UNVERIFIED');
    expect(data.status).toBe('fail');
    expect(data.open).toEqual([p2]);
  });

  it('scopes to pathIds and refuses an unknown id without changing the document', () => {
    expect(checkBonding(doc, { pathIds: [p1] }).rows.map((item) => item.pathId)).toEqual([p1]);
    expect(checkBonding(doc, { pathIds: [p1] }).status).toBe('pass');
    const refused = execute(doc, 'check_bonding', { pathIds: ['bp-nope'] });
    expect(refused.error?.code).toBe('EOP_PATH_NOT_FOUND');
    expect(refused.document).toBe(doc);
  });

  it('is pure and read-only', () => {
    const before = structuredClone(doc);
    const result = execute(doc, 'check_bonding', {});
    expect(doc).toEqual(before);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('an empty document reports no paths', () => {
    const empty = execute(createEmptyDocument(), 'check_bonding', {});
    expect(empty.error).toBeUndefined();
    expect((empty.data as { rows: unknown[] }).rows).toEqual([]);
  });
});

describe('check_bonding: a path never passes on missing or contradicting data', () => {
  const { doc, aliases } = base();
  const [box, structure] = [aliases['box'] ?? '', aliases['structure'] ?? ''];

  it('a path without a limit is unknown with EOP_BOND_LIMIT_MISSING (never pass)', () => {
    const { result, path } = addPath(doc, box, structure, { elements: [joint(0.5), strap()] });
    const row = checkBonding(result.document, { pathIds: [path] }).rows[0];
    expect(row).toMatchObject({ status: 'unknown', code: 'EOP_BOND_LIMIT_MISSING' });
    expect(row?.totalOhm).not.toBeNull();
    expect(row?.limit).toBeUndefined();
  });

  it('a strap whose material has no resistivity model is unknown with EOP_RESISTIVITY_UNAVAILABLE and no total', () => {
    const { result, path } = addPath(material(doc, 'bare'), box, structure, { elements: [joint(0.5), strap('bare')], limit: LIMIT });
    const row = checkBonding(result.document, { pathIds: [path] }).rows[0];
    expect(row).toMatchObject({ status: 'unknown', code: 'EOP_RESISTIVITY_UNAVAILABLE', totalOhm: null });
    expect(row?.elements.every((element) => element.share === null)).toBe(true);
  });

  it('a temperature-dependent resistivity needs the path temperature (the refusal is surfaced) and uses it when given', () => {
    const model = {
      id: 'rho_t',
      property: 'electricalResistivity',
      unit: 'ohm*m',
      variables: [{ variable: 'T', unit: 'K' }],
      form: {
        kind: 'table1d',
        variable: 'T',
        points: [
          [250, 2e-8],
          [350, 3e-8],
        ],
        interpolation: 'linear',
      },
      validity: [{ variable: 'T', unit: 'K', data: [250, 350] }],
      basis: 'company',
      source: SRC,
      preferred: true,
    };
    const withTable = run(material(doc, 'tab'), 'define_property_model', { material: 'tab', model });
    const without = addPath(withTable, box, structure, { elements: [strap('tab')], limit: LIMIT });
    expect(checkBonding(without.result.document, { pathIds: [without.path] }).rows[0]?.findings[0]?.message).toContain(
      'PROP_VARIABLE_MISSING',
    );
    const warm = addPath(withTable, box, structure, { elements: [strap('tab')], limit: LIMIT, temperature: { value: 300, unit: 'K' } });
    expect(checkBonding(warm.result.document, { pathIds: [warm.path] }).rows[0]?.totalOhm).toBeCloseTo((2.5e-8 * 0.15) / 10e-6, 12);
  });

  it('an unverified-basis resistivity makes the row unverified with the reason', () => {
    const model = {
      id: 'rho',
      property: 'electricalResistivity',
      unit: 'ohm*m',
      variables: [],
      form: { kind: 'constant', value: 2e-8 },
      validity: [],
      basis: 'typical',
      source: SRC,
      preferred: true,
    };
    const withModel = run(material(doc, 'typ'), 'define_property_model', { material: 'typ', model });
    const { result, path } = addPath(withModel, box, structure, { elements: [strap('typ')], limit: LIMIT });
    const row = checkBonding(result.document, { pathIds: [path] }).rows[0];
    expect(row?.unverified).toBe(true);
    expect(row?.unverifiedReasons.some((reason) => reason.startsWith('strap typ'))).toBe(true);
  });

  it('joined solids that do not touch are unknown (EOP_JOINT_NO_CONTACT); touching ones pass', () => {
    const far = execute(doc, 'add_box', { size: [10, 10, 10], position: [900, 900, 900] });
    const farId = far.affected[0] ?? '';
    const apart = addPath(far.document, box, structure, { elements: [joint(0.5, [box, farId])], limit: LIMIT });
    expect(checkBonding(apart.result.document, { pathIds: [apart.path] }).rows[0]).toMatchObject({
      status: 'unknown',
      code: 'EOP_JOINT_NO_CONTACT',
    });
    const touching = addPath(doc, box, structure, { elements: [joint(0.5, [box, structure])], limit: LIMIT });
    expect(checkBonding(touching.result.document, { pathIds: [touching.path] }).rows[0]?.status).toBe('pass');
  });

  it('a solid a path names cannot be deleted (guard); a missing one in a loaded slice is reported unknown', () => {
    const { result } = addPath(doc, box, structure, { elements: [joint(0.5, [box, structure])], limit: LIMIT });
    const deleted = execute(result.document, 'delete_entity', { ids: [box] });
    expect(deleted.rejected === true || deleted.error !== undefined).toBe(true);
    expect(deleted.document).toBe(result.document);
    const entities = Object.fromEntries(Object.entries(result.document.entities).filter(([id]) => id !== box));
    const rows = checkBonding({ ...result.document, entities }).rows;
    expect(rows.some((item) => item.findings.some((finding) => finding.code === 'EOP_ENTITY_MISSING'))).toBe(true);
  });
});

describe('check_bonding: coatings on the bonded interface', () => {
  const { doc, aliases } = base();
  const [box, structure] = [aliases['box'] ?? '', aliases['structure'] ?? ''];
  const coated = (electrical: string, extra: Record<string, unknown> = {}): ReturnType<typeof addPath> => {
    let next = run(doc, 'define_material_record', {
      id: 'anod',
      designation: 'test',
      productForm: 'coating',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
    next = run(next, 'assign_surface_coating', { entityId: box, coating: 'anod', location: 'bonded_interface', electrical, ...extra });
    return addPath(next, box, structure, { elements: [joint(0.5, [box, structure]), strap()], limit: LIMIT });
  };

  it('an insulating coating breaks the path: fail EOP_COATING_INSULATES even when the resistance is under the limit', () => {
    const { result, path } = coated('insulating', { source: SRC });
    expect(checkBonding(result.document, { pathIds: [path] }).rows[0]).toMatchObject({ status: 'fail', code: 'EOP_COATING_INSULATES' });
  });

  it('an unknown coating is unknown, never pass', () => {
    const { result, path } = coated('unknown');
    expect(checkBonding(result.document, { pathIds: [path] }).rows[0]).toMatchObject({ status: 'unknown', code: 'EOP_COATING_UNKNOWN' });
  });

  it('a declared conductive coating with a source lets the path pass', () => {
    const { result, path } = coated('conductive', { source: SRC });
    expect(checkBonding(result.document, { pathIds: [path] }).rows[0]?.status).toBe('pass');
  });

  it('a corrosion surface system with no declared electrical effect is unknown', () => {
    const covered = run(doc, 'assign_surface_system', { entityIds: [box], layers: [{ class: 'anodize' }] });
    const { result, path } = addPath(covered, box, structure, { elements: [joint(0.5, [box, structure])], limit: LIMIT });
    const row = checkBonding(result.document, { pathIds: [path] }).rows[0];
    expect(row).toMatchObject({ status: 'unknown', code: 'EOP_COATING_UNKNOWN' });
    expect(row?.findings[0]?.message).toContain('anodize');
  });
});
