import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import { coreVolume } from '@aero/composites/sandwich';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { T300, panelPart } from './fixtures';

const HONEYCOMB = {
  name: 'Honey',
  form: 'core_honeycomb',
  E1: 100,
  E2: 100,
  G12: 50,
  nu12: 0.1,
  plyThickness: 10,
  density: 0.00005,
  basis: 'b_basis',
  source: 'test fixture (core data illustrative)',
} as const;

const CORE_BOX = [
  [200, 100],
  [400, 100],
  [400, 300],
  [200, 300],
] as const;

interface Sample {
  plyCount: number;
  thickness: number;
  core: { thickness: number; z0: number; z1: number; pliesBelow: number } | null;
  plies: { name: string; z0: number; z1: number }[];
}

/** VC-CMP-24: the 8-ply Z-base laminate with a 10 mm honeycomb core (30 degree chamfer) over a 200 x 200 region, after the 4th ply. */
function cored(): { doc: CadDocument; part: string } {
  const base = panelPart();
  let doc = apply(base.doc, 'create_lamina_material', HONEYCOMB);
  doc = apply(doc, 'define_zone', {
    part: base.part,
    name: 'Z-base',
    boundary: [
      [0, 0],
      [600, 0],
      [600, 400],
      [0, 400],
    ],
    laminate: '[45/-45/0/90]s',
    priority: 0,
  });
  doc = apply(doc, 'generate_plies_from_zones', { part: base.part, material: T300.name, sequencePrefix: 'S' });
  doc = apply(doc, 'add_core', { part: base.part, boundary: CORE_BOX, material: 'Honey', thickness: 10, chamferAngle: 30, afterPly: 'S4' });
  return { doc, part: base.part };
}

describe('add_core (VC-CMP-24)', () => {
  const { doc, part } = cored();

  it('records the core above the fourth ply and reports it in core samples', () => {
    const core = Object.values(doc.composites?.cores ?? {})[0];
    expect(core?.afterOrder).toBe(4);
    const centre = data<Sample>(doc, 'core_sample', { part, point: [300, 200, 0] });
    expect(centre.plyCount).toBe(8);
    expect(centre.thickness).toBeCloseTo(11, 9);
    expect(centre.core?.pliesBelow).toBe(4);
    expect(centre.core?.thickness).toBeCloseTo(10, 9);
    expect(centre.core?.z0).toBeCloseTo(0.5, 9);
    expect(centre.core?.z1).toBeCloseTo(10.5, 9);
    const names = centre.plies.map((ply) => ply.name);
    expect(centre.plies[names.indexOf('S4')]?.z1).toBeCloseTo(0.5, 9);
    expect(centre.plies[names.indexOf('S5')]?.z0).toBeCloseTo(10.5, 9);
    expect(centre.plies[names.indexOf('S8')]?.z1).toBeCloseTo(11, 9);
  });

  it('ramps linearly over the chamfer run: 5 mm at mid-run, none outside', () => {
    const run = 10 / Math.tan((30 * Math.PI) / 180);
    const mid = data<Sample>(doc, 'core_sample', { part, point: [200 + run / 2, 200, 0] });
    expect(mid.core?.thickness).toBeCloseTo(5, 6);
    expect(mid.thickness).toBeCloseTo(1 + 5, 6);
    const outside = data<Sample>(doc, 'core_sample', { part, point: [100, 200, 0] });
    expect(outside.core).toBeNull();
    expect(outside.thickness).toBeCloseTo(1, 9);
  });

  it('adds the core mass to laminate_mass (closed-form volume of the chamfered box)', () => {
    const run = 10 / Math.tan((30 * Math.PI) / 180);
    const exact = Math.tan((30 * Math.PI) / 180) * (200 * 200 * run - (2 * 200 * 2 * run * run) / 2 + (4 * run ** 3) / 3);
    const core = Object.values(doc.composites?.cores ?? {})[0];
    expect(core).toBeDefined();
    expect(Math.abs(coreVolume(core as NonNullable<typeof core>) / exact - 1)).toBeLessThan(0.003);
    const mass = data<{ coreMass: number; mass: number; cores: { volume: number }[]; perMaterial: Record<string, { mass: number }> }>(
      doc,
      'laminate_mass',
      { part },
    );
    expect(mass.coreMass).toBeCloseTo(exact * 0.00005, 1);
    expect(mass.mass).toBeCloseTo((mass.perMaterial['T300_5208']?.mass ?? 0) + mass.coreMass, 6);
    expect(mass.cores).toHaveLength(1);
  });

  it('delegates mass_properties of a composite part id to laminate_mass', () => {
    const result = execute(doc, 'mass_properties', { entityId: part });
    expect(result.summary).toContain('delegated to laminate_mass');
    expect((result.data as { mass: number }).mass).toBeGreaterThan(0);
    expect(execute(doc, 'mass_properties', { entityId: 'nope' }).summary).toContain('not found');
  });

  it('lifts the plies above the core in per-ply solids', () => {
    const result = ok(doc, 'create_ply_solids', { part, plies: ['S8'], maxEdge: 20 });
    const solid = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    const zs = solid.mesh.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeGreaterThan(10.9);
    expect(Math.max(...zs)).toBeLessThanOrEqual(11.0000001);
  });

  it('refuses strength analyses over the core and keeps the skins analysable elsewhere', () => {
    expectRefusal(doc, 'analyze_laminate', { part, point: [300, 200, 0] }, 'CMP_CORE_UNSUPPORTED');
    expect(data<{ unit: string }>(doc, 'analyze_laminate', { part, point: [50, 50, 0] }).unit).toBe('N-mm-MPa');
    expectRefusal(doc, 'create_laminate_sections', { part }, 'CMP_CORE_UNSUPPORTED');
    const check = data<{ findings: { code: string }[] }>(doc, 'check_layup', { part, loads: [{ name: 'L', Nx: 10 }] });
    expect(check.findings.map((finding) => finding.code)).toContain('CMP_CORE_UNSUPPORTED');
  });

  it('refuses bad cores without changing the document', () => {
    const args = { part, boundary: CORE_BOX, material: 'Honey', thickness: 10, chamferAngle: 30 };
    expectRefusal(doc, 'add_core', { ...args, part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'add_core', { ...args, material: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'add_core', { ...args, afterPly: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'add_core', { ...args, material: T300.name }, 'CMP_CORE_INVALID');
    expectRefusal(doc, 'add_core', { ...args, thickness: 0 }, 'CMP_CORE_INVALID');
    expectRefusal(doc, 'add_core', { ...args, chamferAngle: 0 }, 'CMP_CORE_INVALID');
    expectRefusal(doc, 'add_core', { ...args, chamferAngle: 91 }, 'CMP_CORE_INVALID');
    expectRefusal(
      doc,
      'add_core',
      {
        ...args,
        boundary: [
          [0, 0],
          [10, 0],
        ],
      },
      'CMP_CORE_INVALID',
    );
    expectRefusal(
      doc,
      'add_core',
      {
        ...args,
        boundary: [
          [0, 0],
          [10, 10],
          [10, 0],
          [0, 10],
        ],
      },
      'CMP_CORE_INVALID',
    );
    expectRefusal(
      doc,
      'add_core',
      {
        ...args,
        boundary: [
          [500, 300],
          [700, 300],
          [700, 500],
          [500, 500],
        ],
      },
      'CMP_CORE_INVALID',
    );
    expectRefusal(doc, 'add_core', { ...args, name: 'Core1' }, 'CMP_NAME_TAKEN');
    const fresh = cored();
    expectPure(fresh.doc, () => execute(fresh.doc, 'add_core', { ...args, part: fresh.part, name: 'Other' }));
  });

  it('defaults the position to the lower half of the stack and survives a plain add_ply', () => {
    const lower = apply(doc, 'add_core', {
      part,
      name: 'Mid',
      boundary: [
        [10, 10],
        [60, 10],
        [60, 60],
        [10, 60],
      ],
      material: 'Honey',
      thickness: 5,
      chamferAngle: 45,
    });
    const mid = Object.values(lower.composites?.cores ?? {}).find((core) => core.name === 'Mid');
    expect(mid?.afterOrder).toBe(4);
    const sample = data<Sample>(lower, 'core_sample', { part, point: [35, 35, 0] });
    expect(sample.core?.thickness).toBeCloseTo(5, 9);
  });

  it('refuses a core mass when its material has no density', () => {
    const none = apply(doc, 'create_lamina_material', { ...HONEYCOMB, density: undefined });
    expectRefusal(none, 'laminate_mass', { part }, 'CMP_MATERIAL_DENSITY_MISSING');
  });
});
