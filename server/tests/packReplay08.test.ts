/**
 * Aerospace pack 08 (materials, standards, libraries) through the real `llull` CLI entry (`runCli`, `--json`): the CLI-phrased cases of
 * `validation/README.md` (VC-MAT-22, 24, 25, 26, 15) with the values of `validation/expected_results.json`, and the validation plans
 * (`mass_7075_block_current`, `mass_ti_cylinder`, `fastener_stack_nas6203`, VC-MAT-02 / 04 / 10 / 11) on the exact OpenCascade kernel.
 * The command-level versions of the same cases live in tests/unit/{materials,aero}.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import request from 'supertest';
import { app } from '../src/index';
import { _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory, applyCommand } from '../src/commandBus';
import { libraryFile } from '../../tests/unit/materials/support';
import { REPO_ROOT, cliCall, cliExec, cliPlan, newSession, runPlan, type CliCall, type Session } from './packCli';

afterAll(() => setGeometryKernel(null));

const PACK = 'docs/aerospace/08-materials-standards-libraries/validation';
const SLOW = 180_000;
const SOURCE = { citation: 'synthetic test fixture', locator: 'server/tests/packReplay08.test.ts' };

interface AgentFirst {
  id: string;
  expected: Array<Record<string, unknown>> | Record<string, Record<string, unknown>>;
  check_materials?: { code: string; severity: string };
}
interface PackFile {
  massProperties: Array<{ id: string; expected: Record<string, number> }>;
  agentFirst: AgentFirst[];
}
const pack = JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'expected_results.json'), 'utf8')) as PackFile;
const agentFirst = (id: string): AgentFirst => pack.agentFirst.find((entry) => entry.id === id) as AgentFirst;
const massRow = (idPrefix: string): Record<string, number> =>
  (pack.massProperties.find((row) => row.id.startsWith(idPrefix)) as { expected: Record<string, number> }).expected;
type Json = Record<string, unknown>;
const relative = (actual: unknown, expected: unknown): number => Math.abs((actual as number) / (expected as number) - 1);
const dataOf = (call: CliCall | null): Json => ((call?.json as { data?: Json } | null)?.data ?? {}) as Json;
const errorOf = (call: CliCall | null): { code: string; ids: string[]; paths: string[]; remediation: string } =>
  (call?.json as { error: { code: string; ids: string[]; paths: string[]; remediation: string } }).error;
const stepData = (plan: CliCall | null, command: string): Json =>
  ((plan?.json as { data: { steps: Array<{ command: string; data?: Json }> } }).data.steps.find((s) => s.command === command)?.data ??
    {}) as Json;
const planFile = (name: string): string => path.join(PACK, 'plans', name);

/** The VCs proved here (tests/unit/contract/aeroValidationMatrix.test.ts needs the id literally in every test file it lists). */
const COVERS = ['VC-MAT-02', 'VC-MAT-04', 'VC-MAT-10', 'VC-MAT-15', 'VC-MAT-22', 'VC-MAT-24', 'VC-MAT-25', 'VC-MAT-26'];

describe('validation plans through llull run (build_project)', () => {
  it('names only VCs that exist in the pack README', () => {
    const readme = readFileSync(path.join(REPO_ROOT, PACK, 'README.md'), 'utf8');
    for (const id of COVERS) expect(readme, id).toContain(`| ${id} |`);
  });

  it('mass_7075_block_current: 140.5 g from the legacy density, flagged unverified (VC-MAT-04 a, VC-MAT-01 provenance)', async () => {
    const session = newSession();
    const plan = await runPlan(session, { plan_file: planFile('mass_7075_block_current.json'), flags: [] });
    expect(plan?.code, plan?.stdout.slice(0, 400)).toBe(0);
    const mass = stepData(plan, 'mass_properties');
    expect(relative(mass['massG'], massRow('VC-MAT-04/box_100x50x10_mm/aa7075_t6/density_typical')['mass_g'] as number)).toBeLessThan(1e-6);
    expect(mass).toMatchObject({ unverified: true, unverifiedReasons: ['density given without a source (unverified)'] });
  });

  it('mass_ti_cylinder: 69.56719 g with the preferred 0.160 lb/in3 entry as densitySource; both densities are listed by get_material (VC-MAT-02, 04 c)', async () => {
    const session = newSession();
    const plan = await runPlan(session, { plan_file: planFile('mass_ti_cylinder_proposed.json'), flags: [] });
    expect(plan?.code, plan?.stdout.slice(0, 400)).toBe(0);
    const mass = stepData(plan, 'mass_properties');
    expect(relative(mass['massG'], massRow('VC-MAT-04/cylinder_r10_h50_mm')['mass_g'] as number)).toBeLessThan(1e-6);
    expect(mass['densitySource']).toContain('density_supplier');
    expect(mass['unverifiedReasons']).toEqual(['basis supplier_unstated']);
    const read = await cliCall(session, ['get_material', 'material=ti6al4v_annealed']);
    const values = (dataOf(read)['values'] as Array<{ id: string; preferred: boolean; value: number; unit: string }>).filter((v) =>
      v.id.startsWith('density'),
    );
    expect(values.map((v) => [v.id, v.preferred, v.value, v.unit])).toEqual([
      ['density_supplier', true, 0.16, 'lb/in^3'],
      ['density_other_supplier', false, 0.163, 'lb/in^3'],
    ]);
    const second = await cliExec(session, 'set_material_property', {
      material: 'ti6al4v_annealed',
      property: 'density',
      id: 'density_other_supplier',
      value: 0.163,
      unit: 'lb/in^3',
      basis: 'supplier_unstated',
      preferred: true,
      replace: true,
      source: SOURCE,
    });
    expect(second.code).toBe(1);
    expect(errorOf(second).code).toBe('MAT_PREFERRED_CONFLICT');
  });

  it(
    'VC-MAT-04 d: 100 x 100 x 5 mm plate with a D10 hole, 2024-T3 at 2.78 g/cm3: 137.9083 g (exact 1e-6 on OCC, mesh 5e-3 on Manifold)',
    async () => {
      const row = massRow('VC-MAT-04/plate_100x100x5_hole_d10_mm');
      for (const [kernel, tolerance] of [
        ['occt', 1e-6],
        ['manifold', 5e-3],
      ] as const) {
        const session = newSession();
        const plan = await cliPlan(
          session,
          [
            { command: 'set_units', params: { units: 'mm' } },
            {
              command: 'create_material',
              params: { name: 'aa2024_t3', density: 0.00278, color: '#b8bcc2', metalness: 1, roughness: 0.35 },
            },
            { command: 'add_box', params: { size: [100, 100, 5], anchor: 'min' }, as: 'plate' },
            { command: 'add_cylinder', params: { radius: 5, height: 7, position: [50, 50, 2.5] }, as: 'drill' },
            { command: 'boolean', params: { op: 'subtract', a: '$plate', b: '$drill' }, as: 'part' },
            { command: 'assign_material', params: { materialName: 'aa2024_t3', entityIds: ['$part'] } },
            { command: 'mass_properties', params: { entityId: '$part' } },
          ],
          ['--kernel', kernel],
        );
        expect(plan.code, plan.stdout.slice(0, 600)).toBe(0);
        const mass = stepData(plan, 'mass_properties');
        expect(relative(mass['massG'], row['mass_g'] as number), `${kernel} ${String(mass['massG'])}`).toBeLessThan(tolerance);
        expect(relative(mass['volume'], row['volume_mm3'] as number)).toBeLessThan(tolerance);
      }
    },
    SLOW,
  );
});

describe('VC-MAT-10 / 11 on OCC: the NAS6203 stack plan', () => {
  const catalogParams = (): { catalog: unknown } => ({
    catalog: JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'fastener_catalog_llull.json'), 'utf8')),
  });
  const planActions = (): Array<{ command: string; params: Json; as?: string }> =>
    (JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'plans/fastener_stack_nas6203_proposed.json'), 'utf8')) as { actions: never[] })
      .actions;
  const hole = (thickness: number): number => Math.PI * (0.19 / 2) ** 2 * thickness;

  it(
    'one insert step; each plate volume is reduced by pi (d/2)^2 t to 1e-6; instances NAS6203-9, NAS1149(.063), MS21042L3; undo restores the document; replay is id-stable',
    async () => {
      const session = newSession();
      const imported = await cliExec(session, 'import_fastener_catalog', catalogParams(), ['--kernel', 'occt']);
      expect(imported.code, imported.stdout.slice(0, 300)).toBe(0);
      const [setUnits, plateA, plateB, selectStep, insertStep] = planActions();
      const built = await cliPlan(session, [setUnits, plateA, plateB], ['--kernel', 'occt']);
      expect(built.code).toBe(0);
      const [a, b] = [session.aliases['plateA']?.[0] as string, session.aliases['plateB']?.[0] as string];
      const stackParams = (step: { params: Json }): Json => ({ ...step.params, stackIds: [a, b] });
      const selected = await cliExec(session, 'select_fastener', stackParams(selectStep as never));
      expect(dataOf(selected)).toMatchObject({ ok: true, partNumber: 'NAS6203-9', washersIn: [0.063] });

      const before = deserializeDocument(readFileSync(session.doc, 'utf8'));
      const inserted = await cliExec(session, 'insert_fastener_stack', stackParams(insertStep as never), ['--kernel', 'occt']);
      expect(inserted.code, inserted.stdout.slice(0, 500)).toBe(0);
      const after = deserializeDocument(readFileSync(session.doc, 'utf8'));
      expect(after.featureHistory.filter((s) => s.name === 'insert_fastener_stack')).toHaveLength(1);
      expect(after.featureHistory.length).toBe(before.featureHistory.length + 1);

      const stack = dataOf(inserted)['stack'] as { layers: Array<{ entityId: string }> };
      const volumes: number[] = [];
      for (const layer of stack.layers) {
        const mass = await cliCall(session, ['mass_properties', `entityId=${layer.entityId}`, '--kernel', 'occt']);
        volumes.push(dataOf(mass)['volume'] as number);
      }
      expect(relative(volumes[0] as number, 2 * 1 * 0.25 - hole(0.25))).toBeLessThan(1e-6);
      expect(relative(volumes[1] as number, 2 * 1 * 0.26 - hole(0.26))).toBeLessThan(1e-6);

      const bom = await cliCall(session, ['bill_of_materials', 'includeStandardParts=true']);
      const parts = (dataOf(bom)['standardParts'] as Array<{ partNumber: string; count: number }>).map(
        (part) => `${part.partNumber}x${part.count}`,
      );
      expect(parts.sort()).toEqual(['MS21042L3x1', 'NAS1149(.063)x1', 'NAS6203-9x1']);

      const undone = await cliCall(session, ['undo']);
      expect(undone.code, undone.stdout.slice(0, 300)).toBe(0);
      expect(deserializeDocument(readFileSync(session.doc, 'utf8'))).toEqual(before);
      const redone = await cliCall(session, ['redo']);
      expect(redone.code, redone.stdout.slice(0, 300)).toBe(0);
      expect(deserializeDocument(readFileSync(session.doc, 'utf8'))).toEqual(after);

      const replayed = await cliCall(session, ['replay_history', '--kernel', 'occt']);
      expect(replayed.code, replayed.stdout.slice(0, 300)).toBe(0);
      const afterReplay = deserializeDocument(readFileSync(session.doc, 'utf8'));
      expect(Object.keys(afterReplay.entities).sort()).toEqual(Object.keys(after.entities).sort());
      expect(afterReplay.fasteners?.stacks).toEqual(after.fasteners?.stacks);
    },
    SLOW,
  );
});

function mass7075(session: Session, kind: 'typical' | 'supplier' | 'legacy'): Promise<CliCall> {
  const block = { command: 'add_box', params: { size: [100, 50, 10], anchor: 'min' }, as: 'block' };
  const cube = { command: 'add_box', params: { size: [10, 10, 10], anchor: 'min' }, as: 'block' };
  const record = {
    command: 'define_material_record',
    params: { id: 'aa7075_t6', designation: '7075', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'none' } },
  };
  const density = (id: string, value: number, unit: string, basis: string): object => ({
    command: 'set_material_property',
    params: { material: 'aa7075_t6', property: 'density', id, value, unit, basis, source: SOURCE },
  });
  const assign = (name: string): object => ({ command: 'assign_material', params: { materialName: name, entityIds: ['$block'] } });
  const actions = {
    typical: [
      { command: 'set_units', params: { units: 'mm' } },
      record,
      density('density_typical_matweb', 2.81, 'g/cm^3', 'typical'),
      block,
      assign('aa7075_t6'),
    ],
    supplier: [
      { command: 'set_units', params: { units: 'mm' } },
      record,
      density('density_ams4045_supplier', 0.101, 'lb/in^3', 'supplier_unstated'),
      block,
      assign('aa7075_t6'),
    ],
    legacy: [
      { command: 'set_units', params: { units: 'mm' } },
      { command: 'create_material', params: { name: 'steel', density: 0.00785, color: '#aaaaaa', metalness: 1, roughness: 0.4 } },
      cube,
      assign('steel'),
    ],
  }[kind];
  return cliPlan(session, actions);
}

describe('VC-MAT-22 through the CLI: unverified flag in mass_properties and check_materials', () => {
  const spec = agentFirst('VC-MAT-22');
  const rows = spec.expected as Array<Json>;

  it.each([
    ['typical', 0],
    ['supplier', 1],
    ['legacy', 2],
  ] as const)(
    '(%s) massG / massKg / massLb at 1e-6, densitySource, unverified with reasons, MAT_VALUE_UNVERIFIED warning',
    async (kind, index) => {
      const row = rows[index] as Json;
      const session = newSession();
      const plan = await mass7075(session, kind);
      expect(plan.code, plan.stdout.slice(0, 400)).toBe(0);
      const mass = await cliCall(session, ['mass_properties', `entityId=${session.aliases['block']?.[0]}`]);
      expect(mass.code).toBe(0);
      const data = dataOf(mass);
      expect(relative(data['massG'], row['massG'])).toBeLessThan(1e-6);
      if (row['massKg'] !== undefined) expect(relative(data['massKg'], row['massKg'])).toBeLessThan(1e-6);
      if (row['massLb'] !== undefined) expect(relative(data['massLb'], row['massLb'])).toBeLessThan(1e-6);
      expect(data).toMatchObject({ unverified: true, unverifiedReasons: row['unverifiedReasons'] });
      const sourceId = (row['densitySource'] as string).split('.').at(-1) as string;
      expect(String(data['densitySource'])).toContain(kind === 'legacy' ? "material 'steel' density (given without a source" : sourceId);
      const check = await cliCall(session, ['check_materials']);
      expect(check.code).toBe(0);
      const items = dataOf(check)['items'] as Array<{ code: string; severity: string; remediation: string }>;
      expect(items[0]).toMatchObject({ code: spec.check_materials?.code, severity: spec.check_materials?.severity });
      expect(items[0]?.remediation.length).toBeGreaterThan(0);
    },
  );
});

describe('VC-MAT-24 through the CLI: nine wrong inputs, exit 1, stable code, remediation, ids or path', () => {
  const listed = agentFirst('VC-MAT-24').expected as Array<{ call: string; code: string }>;
  const record = { id: 'r', designation: '7075', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'none' } };
  const hot = {
    mode: 'percentOfRT',
    temperatureUnit: 'degF',
    points: [
      [70, 100],
      [300, 80],
      [500, 50],
    ],
  };
  const material = async (session: Session): Promise<void> => {
    await cliExec(session, 'set_units', { units: 'mm' });
    await cliExec(session, 'define_material_record', record);
    await cliExec(session, 'set_material_property', {
      material: 'r',
      id: 'rt',
      property: 'Ftu',
      value: 60,
      unit: 'ksi',
      basis: 'S',
      preferred: true,
      source: SOURCE,
    });
    await cliExec(session, 'set_material_property', {
      material: 'r',
      id: 'hot',
      property: 'Ftu',
      unit: 'ksi',
      temperature: hot,
      source: SOURCE,
    });
    await cliExec(session, 'set_material_property', {
      material: 'r',
      id: 'rho',
      property: 'density',
      value: 2.81,
      unit: 'g/cm^3',
      basis: 'typical',
      preferred: true,
      source: SOURCE,
    });
  };
  const withCatalog = async (session: Session): Promise<void> => {
    await cliExec(session, 'import_fastener_catalog', {
      catalog: JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'fastener_catalog_llull.json'), 'utf8')),
    });
    await cliExec(session, 'set_units', { units: 'in' });
  };
  const cases: Array<[string, (session: Session) => Promise<CliCall>]> = [
    [
      'unit=MPa',
      async (s) => (
        await material(s),
        cliExec(s, 'set_material_property', { material: 'r', property: 'density', value: 2.81, unit: 'MPa', source: SOURCE })
      ),
    ],
    [
      '(no basis)',
      async (s) => (
        await material(s),
        cliExec(s, 'set_material_property', { material: 'r', property: 'Ftu', value: 83, unit: 'ksi', source: SOURCE })
      ),
    ],
    [
      'second preferred density',
      async (s) => (
        await material(s),
        cliExec(s, 'set_material_property', {
          material: 'r',
          id: 'rho2',
          property: 'density',
          value: 2.8,
          unit: 'g/cm^3',
          basis: 'typical',
          preferred: true,
          source: SOURCE,
        })
      ),
    ],
    [
      'basis=A where only S exists',
      async (s) => (await material(s), cliExec(s, 'get_material_allowable', { material: 'r', property: 'Ftu', basis: 'A' })),
    ],
    [
      '600 degF',
      async (s) => (
        await material(s),
        cliExec(s, 'get_material_allowable', { material: 'r', property: 'Ftu', basis: 'S', temperature: { value: 600, unit: 'degF' } })
      ),
    ],
    ['storage=embedded', (s) => cliExec(s, 'import_material_library', { library: libraryFile({ licence: 'licensed-no-redistribution' }) })],
    [
      'select_fastener NAS6204 stack 3.000 in',
      async (s) => (
        await withCatalog(s),
        cliExec(s, 'select_fastener', { family: 'NAS6203-6220', diameterDash: '4', stack: { value: 3, unit: 'in' } })
      ),
    ],
    [
      'insert_fastener_row MS20470AD4 pitch 0.30 in',
      async (s) => {
        await withCatalog(s);
        const first = await cliExec(s, 'add_box', { size: [3, 1, 0.0625], anchor: 'min', position: [0, 0, 0] });
        const second = await cliExec(s, 'add_box', { size: [3, 1, 0.0625], anchor: 'min', position: [0, 0, 0.0625] });
        const ids =
          [dataOf(first), dataOf(second)].length > 0
            ? [(first.json as { affected: string[] }).affected[0], (second.json as { affected: string[] }).affected[0]]
            : [];
        return cliExec(s, 'insert_fastener_row', {
          family: 'MS20470',
          diameterDash: '4',
          codes: { material: 'AD' },
          stackIds: ids,
          from: [0.5, 0.5, 0],
          to: [1.4, 0.5, 0],
          pitch: { value: 0.3, unit: 'in' },
          holeDiameter: { value: 0.129, unit: 'in' },
        });
      },
    ],
    ['decode_part_number partNumber=XYZ123', async (s) => (await withCatalog(s), cliCall(s, ['decode_part_number', 'partNumber=XYZ123']))],
  ];

  it('the pack lists exactly these nine calls', () => {
    expect(listed).toHaveLength(9);
    expect(listed.map((row) => row.call)).toHaveLength(cases.length);
  });

  it.each(cases.map(([label, run], index) => [label, run, index] as const))(
    '%s',
    async (label, run, index) => {
      const row = listed[index] as { call: string; code: string };
      const session = newSession();
      const call = await run(session);
      expect(call.code, `${label}: ${call.stdout.slice(0, 400)}`).toBe(1);
      const error = errorOf(call);
      expect(error.code, row.call).toBe(row.code);
      expect(error.remediation.length).toBeGreaterThan(10);
      expect(error.ids.length + error.paths.length).toBeGreaterThan(0);
    },
    SLOW,
  );
});

describe('VC-MAT-26 through the CLI: named defaults in select_fastener', () => {
  const expected = agentFirst('VC-MAT-26').expected as Record<string, Json>;

  it('lists every default rule with its source and defaulted: true, for a bolt and for a rivet', async () => {
    const session = newSession();
    await cliExec(session, 'import_fastener_catalog', {
      catalog: JSON.parse(readFileSync(path.join(REPO_ROOT, PACK, 'fastener_catalog_llull.json'), 'utf8')),
    });
    await cliExec(session, 'set_units', { units: 'in' });
    const bolt = await cliExec(session, 'select_fastener', {
      family: 'NAS6203-6220',
      diameterDash: '3',
      stack: { value: 0.51, unit: 'in' },
      nut: 'MS21042',
      washer: 'NAS1149',
    });
    const rivet = await cliExec(session, 'select_fastener', {
      family: 'MS20470',
      diameterDash: '4',
      stack: { value: 0.125, unit: 'in' },
      codes: { material: 'AD' },
    });
    expect(bolt.code).toBe(0);
    expect(rivet.code).toBe(0);
    const rules = { ...(dataOf(rivet)['rules'] as Json), ...(dataOf(bolt)['rules'] as Json) } as Record<string, Json>;
    expect(Object.keys(expected).sort()).toEqual([
      'maxWasherTotal',
      'minProtrusion',
      'rivetLengthRounding',
      'rivetMinEdgeDistance',
      'rivetMinPitch',
    ]);
    for (const [key, want] of Object.entries(expected)) {
      expect(rules[key], key).toBeDefined();
      expect(rules[key]?.['defaulted'], key).toBe(true);
      expect(String(rules[key]?.['source']), key).toContain(String(want['source']));
    }
    expect(rules['maxWasherTotal']).toMatchObject({ value: 0.125, unit: 'in' });
    expect(rules['rivetLengthRounding']).toMatchObject({ value: 'up', step: { value: 0.0625, unit: 'in' } });
  });
});

describe('VC-MAT-15 / 25 through the CLI (local file and live backend): export-control gates', () => {
  const spec = agentFirst('VC-MAT-25').expected as Array<{
    call: string;
    exitCode: number;
    code?: string;
    saved?: unknown[];
    documentChanged?: boolean;
  }>;

  const controlled = async (session: Session, regime: string): Promise<void> => {
    await cliExec(session, 'define_material_record', {
      id: 'secret',
      designation: 'X',
      specs: [],
      licence: 'company-proprietary',
      exportMarking: { regime },
    });
    await cliPlan(session, [
      { command: 'add_box', params: { size: [10, 10, 10], anchor: 'min' }, as: 'box' },
      { command: 'assign_material', params: { materialName: 'secret', entityIds: ['$box'] } },
    ]);
  };

  it(
    '(a) the CLI agent: export_step_exact --save is refused (MAT_EXPORT_CONTROLLED), an agent confirmation is MAT_HUMAN_GATE, nothing is saved',
    async () => {
      const session = newSession();
      await controlled(session, 'ITAR');
      const target = path.join(session.dir, 'x.step');
      const refused = await cliCall(session, ['export_step_exact', '--save', target, '--kernel', 'occt']);
      expect([refused.code, errorOf(refused).code]).toEqual([spec[0]?.exitCode, spec[0]?.code]);
      expect(existsSync(target)).toBe(false);
      const confirmed = await cliExec(session, 'export_step_exact', { confirmExportControlled: true }, [
        '--save',
        target,
        '--kernel',
        'occt',
      ]);
      expect([confirmed.code, errorOf(confirmed).code]).toEqual([spec[1]?.exitCode, spec[1]?.code]);
      expect(existsSync(target)).toBe(false);
    },
    SLOW,
  );

  it(
    'an unmarked document exports as before',
    async () => {
      const session = newSession();
      await controlled(session, 'none');
      const target = path.join(session.dir, 'y.step');
      const exported = await cliCall(session, ['export_step_exact', '--save', target, '--kernel', 'occt']);
      expect(exported.code, exported.stdout.slice(0, 300)).toBe(0);
      expect(existsSync(target)).toBe(true);
    },
    SLOW,
  );

  it('VC-MAT-25: lowering ITAR to none by an agent is MAT_HUMAN_GATE and leaves the file byte-identical; raising none to EAR99 works', async () => {
    const session = newSession();
    await controlled(session, 'ITAR');
    const before = readFileSync(session.doc);
    const lowered = await cliExec(session, 'set_export_marking', { material: 'secret', marking: { regime: 'none' } });
    expect([lowered.code, errorOf(lowered).code]).toEqual([spec[2]?.exitCode, spec[2]?.code]);
    expect(spec[2]?.documentChanged).toBe(false);
    expect(readFileSync(session.doc).equals(before)).toBe(true);

    const other = newSession();
    await controlled(other, 'none');
    const raised = await cliExec(other, 'set_export_marking', { material: 'secret', marking: { regime: 'EAR99' } });
    expect(raised.code).toBe(spec[3]?.exitCode);
    expect(spec[3]?.documentChanged).toBe(true);
    expect((raised.json as { changed: boolean }).changed).toBe(true);
    expect(deserializeDocument(readFileSync(other.doc, 'utf8')).materials['secret']?.record?.exportMarking).toEqual({ regime: 'EAR99' });
  });

  describe('(b) the CLI against the live backend (POST /command, --app / --server)', () => {
    beforeEach(() => {
      _resetLiveDoc();
      _resetHistory();
    });

    it('export_step_exact on an ITAR-marked live document is refused over REST, with or without an agent confirmation', async () => {
      applyCommand('define_material_record', {
        id: 'secret',
        designation: 'X',
        specs: [],
        licence: 'company-proprietary',
        exportMarking: { regime: 'ITAR' },
      });
      const box = applyCommand('add_box', { size: [2, 2, 2], position: [0, 0, 0] });
      applyCommand('assign_material', { materialName: 'secret', entityIds: box.affected });
      const call = async (params: Record<string, unknown>): Promise<request.Response> =>
        request(app).post('/command').send({ name: 'export_step_exact', params, client: 'cli' });
      const plain = await call({});
      expect(plain.body.isError).toBe(true);
      expect(JSON.stringify(plain.body)).toContain('MAT_EXPORT_CONTROLLED');
      const confirmed = await call({ confirmExportControlled: true });
      expect(confirmed.body.isError).toBe(true);
      expect(JSON.stringify(confirmed.body)).toContain('MAT_HUMAN_GATE');
    });
  });
});
