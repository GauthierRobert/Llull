import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { addBc, caseOf, thermalFixture } from './fixtures';

const run = (doc: CadDocument, command: string, params: Record<string, unknown>): CommandResult => execute(doc, command, params);

function expectRefused(result: CommandResult, doc: CadDocument, code: string): void {
  expectNoOp(result, doc);
  expect(result.rejected).toBe(true);
  expect(result.error?.code).toBe(code);
  expect(result.error?.remediation.length).toBeGreaterThan(5);
  expect(result.summary).toContain(code);
}

const face = (boxId: string, z: number): Record<string, unknown> => ({ entityId: boxId, facesNear: [[0.5, 0.5, z]] });
const film = { value: 50, unit: 'W/(m^2*K)' };
const sink = { value: 200, unit: 'degC' };
const source = { citation: 'datasheet 12', locator: 'p. 3' };

describe('add_thermal_bc', () => {
  it('adds every BC kind with step-scoped ids, units kept as given and the amplitude resolved by name', () => {
    let fixture = thermalFixture({ type: 'heat_transient' });
    const amplitude = run(fixture.doc, 'define_amplitude', { analysisId: fixture.analysisId, name: 'ramp1', kind: 'ramp', durationS: 10 });
    fixture = { ...fixture, doc: amplitude.document };
    const amplitudeId = amplitude.affected[0] ?? '';
    const cases: [string, Record<string, unknown>][] = [
      ['temperature', { name: 'T', kind: 'temperature', value: 80, unit: 'degC', amplitude: 'ramp1', target: face(fixture.boxId, 0) }],
      ['surface_flux', { name: 'q', kind: 'surface_flux', value: 500, unit: 'W/m^2', target: face(fixture.boxId, 0) }],
      ['heat_generation', { name: 'g', kind: 'heat_generation', value: 20, unit: 'W', mode: 'total', entityId: fixture.boxId }],
      [
        'concentrated_flux',
        { name: 'p', kind: 'concentrated_flux', value: 2, unit: 'W', target: { entityId: fixture.boxId, pointsNear: [[0, 0, 0]] } },
      ],
      ['film', { name: 'f', kind: 'film', filmCoefficient: film, sinkTemperature: sink, source, target: face(fixture.boxId, 0) }],
      [
        'radiation',
        {
          name: 'r',
          kind: 'radiation',
          emissivity: 0.8,
          sinkTemperature: { value: 3, unit: 'K' },
          source,
          target: face(fixture.boxId, 0.05),
        },
      ],
    ];
    for (const [kind, params] of cases) {
      const result = run(fixture.doc, 'add_thermal_bc', { analysisId: fixture.analysisId, ...params });
      const id = result.affected[0] ?? '';
      expect(result.rejected, result.summary).toBeUndefined();
      expect(id).toMatch(/^tb-\d+\.1$/);
      const record = caseOf(result.document, fixture.analysisId).thermal?.bcs[id];
      expect(record?.bc.kind).toBe(kind);
      expect(caseOf(result.document, fixture.analysisId).thermal?.bcOrder).toEqual([id]);
      if (kind === 'temperature') expect(record?.amplitude).toBe(amplitudeId);
      if (kind === 'film') expect(record?.source).toEqual(source);
      expectPure(fixture.doc, () => run(fixture.doc, 'add_thermal_bc', { analysisId: fixture.analysisId, ...params }));
    }
  });

  it('refuses a missing source for film h and numeric emissivity (THM_SOURCE_REQUIRED) but not for a flux', () => {
    const { doc, boxId, analysisId } = thermalFixture();
    const target = face(boxId, 0);
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'f', kind: 'film', filmCoefficient: film, sinkTemperature: sink, target }),
      doc,
      'THM_SOURCE_REQUIRED',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', {
        analysisId,
        name: 'f',
        kind: 'film',
        filmCoefficient: film,
        sinkTemperature: sink,
        target,
        source: { citation: ' ' },
      }),
      doc,
      'THM_SOURCE_REQUIRED',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'r', kind: 'radiation', emissivity: 0.5, sinkTemperature: sink, target }),
      doc,
      'THM_SOURCE_REQUIRED',
    );
    expect(
      run(doc, 'add_thermal_bc', { analysisId, name: 'q', kind: 'surface_flux', value: 1, unit: 'W/m^2', target }).rejected,
    ).toBeUndefined();
  });

  it('refuses emissivity outside [0, 1], h <= 0, wrong unit dimensions and below absolute zero', () => {
    const { doc, boxId, analysisId } = thermalFixture();
    const target = face(boxId, 0);
    const radiation = { analysisId, name: 'r', kind: 'radiation', sinkTemperature: sink, source, target };
    expectRefused(run(doc, 'add_thermal_bc', { ...radiation, emissivity: 1.2 }), doc, 'THM_EMISSIVITY_INVALID');
    expectRefused(run(doc, 'add_thermal_bc', { ...radiation, emissivity: -0.1 }), doc, 'THM_EMISSIVITY_INVALID');
    expectRefused(
      run(doc, 'add_thermal_bc', { ...radiation, emissivity: 0.5, sinkTemperature: { value: 5, unit: 'W' } }),
      doc,
      'THM_UNITS_MISMATCH',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { ...radiation, emissivity: 0.5, sinkTemperature: { value: -300, unit: 'degC' } }),
      doc,
      'THM_UNITS_MISMATCH',
    );
    const filmBc = { analysisId, name: 'f', kind: 'film', sinkTemperature: sink, source, target };
    expectRefused(run(doc, 'add_thermal_bc', { ...filmBc, filmCoefficient: { value: 0, unit: 'W/(m^2*K)' } }), doc, 'THM_FILM_INVALID');
    expectRefused(run(doc, 'add_thermal_bc', { ...filmBc, filmCoefficient: { value: 10, unit: 'W/m^2' } }), doc, 'THM_UNITS_MISMATCH');
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 't', kind: 'temperature', value: 5, unit: 'W', target }),
      doc,
      'THM_UNITS_MISMATCH',
    );
    expectRefused(run(doc, 'add_thermal_bc', { analysisId, name: 't', kind: 'temperature', value: 5, target }), doc, 'THM_UNITS_MISMATCH');
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'q', kind: 'surface_flux', value: 5, unit: 'W', target }),
      doc,
      'THM_UNITS_MISMATCH',
    );
  });

  it('refuses non-thermal cases, unknown analyses and amplitudes, bad targets and parameters the kind does not use', () => {
    const { doc, boxId, analysisId } = thermalFixture();
    const target = face(boxId, 0);
    const flux = { name: 'q', kind: 'surface_flux', value: 1, unit: 'W/m^2', target };
    const staticCase = run(doc, 'create_analysis', { name: 's', analysisType: 'static' });
    expectRefused(
      run(staticCase.document, 'add_thermal_bc', { analysisId: staticCase.affected[0], ...flux }),
      staticCase.document,
      'THM_CASE_TYPE',
    );
    expectRefused(run(doc, 'add_thermal_bc', { analysisId: 'ghost', ...flux }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    expectRefused(run(doc, 'add_thermal_bc', { analysisId, ...flux, amplitude: 'nope' }), doc, 'THM_AMPLITUDE_INVALID');
    expectRefused(run(doc, 'add_thermal_bc', { analysisId, ...flux, filmCoefficient: film }), doc, 'FEA_PARAM_NOT_APPLICABLE');
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, ...flux, target: { entityId: 'ghost', facesNear: [[0, 0, 0]] } }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, ...flux, target: { entityId: boxId, pointsNear: [[0, 0, 0]] } }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'p', kind: 'concentrated_flux', value: 1, unit: 'W', target }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'g', kind: 'heat_generation', value: 1, unit: 'W/m^3', entityId: 'ghost' }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'f', kind: 'film', sinkTemperature: sink, source, target }),
      doc,
      'THM_FILM_INVALID',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'r', kind: 'radiation', sinkTemperature: sink, source, target }),
      doc,
      'THM_EMISSIVITY_INVALID',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'g', kind: 'heat_generation', value: 1, unit: 'W/m^3' }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'q', kind: 'surface_flux', unit: 'W/m^2', target }),
      doc,
      'THM_UNITS_MISMATCH',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'q', kind: 'surface_flux', value: 1, unit: 'W/m^2' }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
    expectRefused(
      run(doc, 'add_thermal_bc', { analysisId, name: 'f', kind: 'film', filmCoefficient: film, source, target }),
      doc,
      'THM_UNITS_MISMATCH',
    );
  });

  it('refuses an entity that is not a part of the analysis', () => {
    const { doc, boxId, analysisId } = thermalFixture();
    const other = run(doc, 'add_box', { size: [1, 1, 1] });
    const otherId = other.affected[0] ?? '';
    expect(otherId).not.toBe(boxId);
    expectRefused(
      run(other.document, 'add_thermal_bc', {
        analysisId,
        name: 'q',
        kind: 'surface_flux',
        value: 1,
        unit: 'W/m^2',
        target: face(otherId, 0),
      }),
      other.document,
      'FEA_PART_NOT_IN_ANALYSIS',
    );
  });
});

describe('update_thermal_bc / delete_thermal_bc', () => {
  const base = (): { doc: CadDocument; analysisId: string; boxId: string; id: string } => {
    const fixture = thermalFixture();
    const added = addBc(fixture, {
      name: 'f',
      kind: 'film',
      filmCoefficient: film,
      sinkTemperature: sink,
      source,
      target: face(fixture.boxId, 0),
    });
    return { doc: added.doc, analysisId: fixture.analysisId, boxId: fixture.boxId, id: added.id };
  };

  it('replaces the given fields only and keeps the kind, source and id', () => {
    const { doc, analysisId, id } = base();
    const result = run(doc, 'update_thermal_bc', {
      analysisId,
      bcId: id,
      name: 'film2',
      filmCoefficient: { value: 25, unit: 'W/(m^2*K)' },
    });
    expect(result.affected).toEqual([id]);
    const record = caseOf(result.document, analysisId).thermal?.bcs[id];
    expect(record).toMatchObject({
      id,
      name: 'film2',
      source,
      bc: { kind: 'film', filmCoefficient: { value: 25 }, sinkTemperature: sink },
    });
    expectPure(doc, () => run(doc, 'update_thermal_bc', { analysisId, bcId: id, name: 'x' }));
    const sinkOnly = run(doc, 'update_thermal_bc', { analysisId, bcId: id, sinkTemperature: { value: 30, unit: 'degC' } });
    expect(caseOf(sinkOnly.document, analysisId).thermal?.bcs[id]?.bc).toMatchObject({
      filmCoefficient: film,
      sinkTemperature: { value: 30 },
    });
  });

  it('updates values of flux BCs, unit alone, and removes an amplitude with an empty name', () => {
    const fixture = thermalFixture({ type: 'heat_transient' });
    const amp = run(fixture.doc, 'define_amplitude', {
      analysisId: fixture.analysisId,
      name: 'a',
      kind: 'table',
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    const added = addBc(
      { ...fixture, doc: amp.document },
      { name: 'q', kind: 'surface_flux', value: 10, unit: 'W/m^2', amplitude: 'a', target: face(fixture.boxId, 0) },
    );
    const analysisId = fixture.analysisId;
    const value = run(added.doc, 'update_thermal_bc', { analysisId, bcId: added.id, value: 20 });
    expect(caseOf(value.document, analysisId).thermal?.bcs[added.id]?.bc).toMatchObject({ value: { value: 20, unit: 'W/m^2' } });
    const unit = run(added.doc, 'update_thermal_bc', { analysisId, bcId: added.id, unit: 'kW/m^2' });
    expect(caseOf(unit.document, analysisId).thermal?.bcs[added.id]?.bc).toMatchObject({ value: { value: 10, unit: 'kW/m^2' } });
    const cleared = run(added.doc, 'update_thermal_bc', { analysisId, bcId: added.id, amplitude: '' });
    expect(caseOf(cleared.document, analysisId).thermal?.bcs[added.id]?.amplitude).toBeUndefined();
    const renamed = run(added.doc, 'update_thermal_bc', { analysisId, bcId: added.id, amplitude: 'a', value: 1, unit: 'W/m^2' });
    expect(caseOf(renamed.document, analysisId).thermal?.bcs[added.id]?.amplitude).toBe(amp.affected[0]);
  });

  it('refuses invalid results and unknown ids without changing the document', () => {
    const { doc, analysisId, id } = base();
    expectRefused(run(doc, 'update_thermal_bc', { analysisId, bcId: 'tb-0.0', name: 'x' }), doc, 'THM_BC_NOT_FOUND');
    expectRefused(run(doc, 'update_thermal_bc', { analysisId: 'ghost', bcId: id }), doc, 'FEA_ANALYSIS_NOT_FOUND');
    expectRefused(
      run(doc, 'update_thermal_bc', { analysisId, bcId: id, filmCoefficient: { value: -1, unit: 'W/(m^2*K)' } }),
      doc,
      'THM_FILM_INVALID',
    );
    expectRefused(run(doc, 'update_thermal_bc', { analysisId, bcId: id, emissivity: 0.5 }), doc, 'FEA_PARAM_NOT_APPLICABLE');
    expectRefused(run(doc, 'update_thermal_bc', { analysisId, bcId: id, amplitude: 'missing' }), doc, 'THM_AMPLITUDE_INVALID');
    expectRefused(
      run(doc, 'update_thermal_bc', { analysisId, bcId: id, target: { entityId: 'ghost', facesNear: [[0, 0, 0]] } }),
      doc,
      'FEA_TARGET_UNRESOLVED',
    );
  });

  it('deletes a BC and refuses unknown ones', () => {
    const { doc, analysisId, id } = base();
    const removed = run(doc, 'delete_analysis_item', { analysisId, itemId: id });
    expect(removed.affected).toEqual([id]);
    expect(caseOf(removed.document, analysisId).thermal).toMatchObject({ bcs: {}, bcOrder: [] });
    expectPure(doc, () => run(doc, 'delete_analysis_item', { analysisId, itemId: id }));
    expectRefused(run(doc, 'delete_analysis_item', { analysisId, itemId: 'ghost' }), doc, 'FEA_ITEM_NOT_FOUND');
    expectRefused(run(doc, 'delete_analysis_item', { analysisId: 'ghost', itemId: id }), doc, 'FEA_ANALYSIS_NOT_FOUND');
  });
});
