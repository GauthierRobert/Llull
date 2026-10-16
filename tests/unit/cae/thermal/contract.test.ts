/** Agent-first contract cases of the PHY-03 pack (VC-THM-13, 50, 60, 61, 62, 63) judged against expected_results.json. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { checkThermalItems } from '@cae/thermal/check';
import { thermalSections } from '@cae/thermal/deck';
import { buildDeckContext } from '@cae/decks/context';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '@cae/index';
import { canonicalJson } from '@lib/canonicalJson';
import { expectCase, packCase } from '../../physics/benchmarkCases';
import { addBc, must, thermalFixture, twoTetMesh } from './fixtures';
import { solvedWall } from './solved';

const PACK = '03-thermal-analysis';
const run = (doc: CadDocument, command: string, params: Record<string, unknown>, ctx = defaultContext()): CommandResult =>
  execute(doc, command, params, ctx);
const round12 = (value: number): number => Number(value.toPrecision(12));
const source = { citation: 'test input of this validation case', locator: 'VC-THM-62' };
const hash = (doc: CadDocument): string => sha256Hex(canonicalJson(doc));
const codeOf = (result: CommandResult): string => result.error?.code ?? 'none';
const firstCode = (items: readonly { code: string }[], wanted: string): string =>
  items.find((item) => item.code === wanted)?.code ?? 'none';

/** A thermo_static case solved against the wall's thermal results, then the thermal case is edited: the dependent state (VC-THM-50). */
function dependentStateAfterEdit(wall: ReturnType<typeof solvedWall>): string {
  const created = must(wall.solved, 'create_analysis', {
    name: 'dependent',
    analysisType: 'thermo_static',
    referenceTemperature: { value: 20, unit: 'degC' },
  });
  const dependentId = created.affected[0] ?? '';
  const linked = must(
    must(created.document, 'set_part_idealization', { analysisId: dependentId, entityId: wall.boxId, idealization: 'solid' }).document,
    'set_temperature_field',
    { analysisId: dependentId, source: { kind: 'thermal_result', analysisId: wall.analysisId, time: 'last' } },
  ).document;
  const dependent = linked.analysis?.cases[dependentId];
  const thermal = linked.analysis?.cases[wall.analysisId];
  if (dependent === undefined || thermal?.meshSummary === undefined || thermal.results === undefined) return 'missing';
  const solved: CadDocument = {
    ...linked,
    analysis: {
      ...linked.analysis!,
      cases: {
        ...linked.analysis!.cases,
        [dependentId]: {
          ...dependent,
          meshSummary: { ...thermal.meshSummary, inputHash: analysisInputHash(linked, dependentId, 'mesh') },
          results: { ...thermal.results, inputHash: analysisInputHash(linked, dependentId, 'full') },
        },
      },
    },
  };
  const withStore = { ...defaultContext(), feaArtifacts: wall.port };
  const before = (run(solved, 'fea_report', { analysisId: dependentId }, withStore).data as { state: string }).state;
  expect(before).toBe('solved');
  const edited = must(solved, 'update_thermal_bc', {
    analysisId: wall.analysisId,
    bcId: wall.hotId,
    filmCoefficient: { value: 60, unit: 'W/(m^2*K)' },
  }).document;
  return (run(edited, 'fea_report', { analysisId: dependentId }, withStore).data as { state: string }).state;
}

interface Row {
  status: string;
  code?: string;
  marginK: number;
  reviewRequired: boolean;
  disposition: unknown;
  unverified: boolean;
}
const rowsOf = (result: CommandResult): Row[] => (result.data as { rows: Row[] }).rows;

describe('PHY-03 agent-first contract', () => {
  it('VC-THM-13: sigma written to the deck in N-mm-t-s (SI value times 1e-3)', () => {
    const fixture = thermalFixture({ units: 'mm' });
    const rad = addBc(fixture, {
      name: 'rad',
      kind: 'radiation',
      emissivity: 1,
      sinkTemperature: { value: 3, unit: 'K' },
      source,
      target: { entityId: fixture.boxId, facesNear: [[0, 0, 0]] },
    });
    const ready = { ...fixture, doc: rad.doc };
    const ctx = buildDeckContext(ready.doc, ready.analysisId, twoTetMesh(ready, { faceSets: { [`B_${rad.id}`]: [[1, 1]] } }));
    const sections = ctx === null ? null : thermalSections(ctx);
    const text = sections !== null && 'text' in sections ? sections.text : '';
    const written = Number(/STEFAN BOLTZMANN=(\S+)/.exec(text)?.[1]);
    expect(Math.abs(written / (packCase(PACK, 'VC-THM-13')['inMmTonneSecond'] as number) - 1)).toBeLessThan(1e-9);
    expectCase(PACK, 'VC-THM-13', written * 1e3, 'W/(m^2 K^4)');
  });

  it('VC-THM-50: after a change the report is stale and the limits are refused with FEA_RESULTS_STALE', () => {
    const wall = solvedWall();
    const edited = must(wall.solved, 'update_thermal_bc', {
      analysisId: wall.analysisId,
      bcId: wall.hotId,
      filmCoefficient: { value: 60, unit: 'W/(m^2*K)' },
    }).document;
    const withLimit = must(edited, 'add_temperature_limit', {
      analysisId: wall.analysisId,
      name: 'l',
      entityId: wall.boxId,
      max: { value: 150, unit: 'degC' },
      source,
    });
    const report = run(edited, 'thermal_report', { analysisId: wall.analysisId }).data as { state: string };
    const limits = run(
      withLimit.document,
      'check_temperature_limits',
      { analysisId: wall.analysisId },
      { ...defaultContext(), feaArtifacts: wall.port },
    );
    expectCase(PACK, 'VC-THM-50', {
      'thermal_report.state': report.state,
      'check_temperature_limits.code': codeOf(limits),
      'dependentThermoStatic.state': dependentStateAfterEdit(wall),
    });
  });

  it('VC-THM-62: the exceeded limit FAILs pending a human; an agent disposition is refused and the document hash is unchanged', () => {
    let limitId = '';
    const wall = solvedWall({}, 1, undefined, (fixture) => {
      const added = must(fixture.doc, 'add_temperature_limit', {
        analysisId: fixture.analysisId,
        name: 'max',
        entityId: fixture.boxId,
        max: { value: 150, unit: 'degC' },
        source,
      });
      limitId = added.affected[0] ?? '';
      return { doc: added.document };
    });
    const rows = rowsOf(
      run(wall.solved, 'check_temperature_limits', { analysisId: wall.analysisId }, { ...defaultContext(), feaArtifacts: wall.port }),
    );
    const before = hash(wall.solved);
    const agent = run(
      wall.solved,
      'dispose_thermal_limit',
      { analysisId: wall.analysisId, rowId: `${limitId}:max`, decision: 'accepted', justification: 'j' },
      { ...defaultContext(), feaArtifacts: wall.port },
    );
    const row = rows[0];
    expectCase(
      PACK,
      'VC-THM-62',
      {
        'row.status': row?.status ?? null,
        'row.code': row?.code ?? null,
        'row.marginK': round12(row?.marginK ?? Number.NaN),
        'row.reviewRequired': row?.reviewRequired ?? null,
        'row.disposition': row?.disposition as string,
        'dispose_thermal_limit(agent).code': codeOf(agent),
        documentHashUnchanged: hash(agent.document) === before,
      },
      '-',
    );
  });

  it('VC-THM-63: unverified conductivity flags the report, every limit row and the check', () => {
    let limitId = '';
    const wall = solvedWall({ basis: 'typical' }, 1, undefined, (fixture) => {
      const added = must(fixture.doc, 'add_temperature_limit', {
        analysisId: fixture.analysisId,
        name: 'max',
        entityId: fixture.boxId,
        max: { value: 150, unit: 'degC' },
        source,
      });
      limitId = added.affected[0] ?? '';
      return { doc: added.document };
    });
    const report = run(wall.solved, 'thermal_report', { analysisId: wall.analysisId }).data as { unverified: boolean };
    const rows = rowsOf(
      run(wall.solved, 'check_temperature_limits', { analysisId: wall.analysisId }, { ...defaultContext(), feaArtifacts: wall.port }),
    );
    const check = run(wall.solved, 'check_thermal', { analysisId: wall.analysisId }).data as { items: { code: string }[] };
    expect(limitId).not.toBe('');
    expectCase(PACK, 'VC-THM-63', {
      'thermal_report.unverified': report.unverified,
      'limitRows[*].unverified': rows.every((row) => row.unverified),
      'check_thermal.items': check.items.map((item) => item.code),
    });
  });

  it('VC-THM-61: every deliberately wrong set-up returns its stable code', () => {
    const noCp = thermalFixture({ type: 'heat_transient', cp: null });
    const base = thermalFixture();
    const radiation = {
      analysisId: base.analysisId,
      name: 'r',
      kind: 'radiation',
      source,
      target: { entityId: base.boxId, facesNear: [[0, 0, 0]] },
    };
    const badEmissivity = run(base.doc, 'add_thermal_bc', { ...radiation, emissivity: 1.2, sinkTemperature: { value: 3, unit: 'K' } });
    const belowZero = run(base.doc, 'add_thermal_bc', { ...radiation, emissivity: 0.5, sinkTemperature: { value: -300, unit: 'degC' } });
    const noInitial = thermalFixture({ type: 'heat_transient' });
    const flux = addBc(base, {
      name: 'q',
      kind: 'surface_flux',
      value: 1,
      unit: 'W/m^2',
      target: { entityId: base.boxId, facesNear: [[0, 0, 0]] },
    });
    const narrow = solvedWall(
      {
        k: [
          [0, 10],
          [100, 20],
          [400, 40],
        ],
      },
      1,
      300,
    );
    const unbalanced = solvedWall({}, 1.05);
    const noSource = run(base.doc, 'add_temperature_limit', {
      analysisId: base.analysisId,
      name: 'l',
      entityId: base.boxId,
      max: { value: 85, unit: 'degC' },
    });
    const noFilmSource = run(base.doc, 'add_thermal_bc', {
      analysisId: base.analysisId,
      name: 'f',
      kind: 'film',
      filmCoefficient: { value: 10, unit: 'W/(m^2*K)' },
      sinkTemperature: { value: 20, unit: 'degC' },
      target: { entityId: base.boxId, facesNear: [[0, 0, 0]] },
    });
    const gateRow = run(narrow.doc, 'add_temperature_limit', {
      analysisId: narrow.analysisId,
      name: 'l',
      entityId: narrow.boxId,
      max: { value: 85, unit: 'degC' },
      source,
    });
    const agent = run(gateRow.document, 'dispose_thermal_limit', {
      analysisId: narrow.analysisId,
      rowId: `${gateRow.affected[0]}:max`,
      decision: 'accepted',
      justification: 'j',
    });
    const checkCodes = (doc: CadDocument, id: string): readonly { code: string; remediation: string; ids: readonly string[] }[] =>
      checkThermalItems(doc, id);
    const measured = [
      {
        setup: 'heat_transient case, material record has k but no cp',
        code: firstCode(checkCodes(noCp.doc, noCp.analysisId), 'THM_MATERIAL_NO_CP'),
      },
      { setup: 'radiation BC with emissivity 1.2', code: codeOf(badEmissivity) },
      { setup: 'radiation BC with sink temperature given in degC without absoluteZero handling', code: codeOf(belowZero) },
      {
        setup: 'transient case without initial temperature',
        code: firstCode(checkCodes(noInitial.doc, noInitial.analysisId), 'THM_INITIAL_TEMPERATURE_MISSING'),
      },
      {
        setup: 'no temperature BC, film or radiation anywhere (steady)',
        code: firstCode(checkCodes(flux.doc, base.analysisId), 'THM_NO_HEAT_PATH'),
      },
      {
        setup: 'k(T) table evaluated outside its valid range at a solved temperature',
        code: firstCode(checkCodes(narrow.solved, narrow.analysisId), 'THM_PROPERTY_OUT_OF_RANGE'),
      },
      {
        setup: 'heat balance residual 5 % after solve',
        code: firstCode(checkCodes(unbalanced.solved, unbalanced.analysisId), 'THM_HEAT_BALANCE'),
      },
      { setup: 'agent calls dispose_thermal_limit', code: codeOf(agent) },
      { setup: 'add_temperature_limit without source', code: codeOf(noSource) },
      { setup: 'film BC with numeric h and no source', code: codeOf(noFilmSource) },
    ];
    expectCase(PACK, 'VC-THM-61', measured as never, '-');
    for (const result of [badEmissivity, belowZero, noSource, noFilmSource, agent]) {
      expect(result.error?.remediation.length).toBeGreaterThan(10);
      expect(result.error?.ids.length).toBeGreaterThan(0);
    }
    for (const [doc, id] of [
      [noCp.doc, noCp.analysisId],
      [noInitial.doc, noInitial.analysisId],
      [flux.doc, base.analysisId],
      [narrow.solved, narrow.analysisId],
      [unbalanced.solved, unbalanced.analysisId],
    ] as const)
      for (const item of checkCodes(doc, id)) {
        expect(item.remediation.length).toBeGreaterThan(10);
        expect(item.ids.length).toBeGreaterThan(0);
      }
  });
});
