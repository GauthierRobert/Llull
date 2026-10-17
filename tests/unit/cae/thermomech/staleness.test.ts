/** PHY-04 VC-TMC-50 (staleness chain): editing the source thermal case makes the dependent thermo_static input hash move. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { analysisInputHash } from '@cae/index';
import { thermoFixture } from './fixtures';

describe('thermal -> thermo_static staleness chain', () => {
  it('moves the dependent full hash when the source thermal case is edited, not its mesh hash', () => {
    const fixture = thermoFixture({ field: null });
    const heat = execute(fixture.doc, 'create_analysis', { name: 'H', analysisType: 'heat_steady' });
    const thermalId = heat.affected[0] ?? '';
    const linked = execute(heat.document, 'set_temperature_field', {
      analysisId: fixture.analysisId,
      source: { kind: 'thermal_result', analysisId: thermalId, time: 'last' },
    }).document;
    const before = {
      full: analysisInputHash(linked, fixture.analysisId, 'full'),
      mesh: analysisInputHash(linked, fixture.analysisId, 'mesh'),
    };
    const edited = execute(linked, 'set_mesh_controls', { analysisId: thermalId, elementFamily: 'tet', order: 1, globalSize: 3 });
    expect(edited.affected).toEqual([thermalId]);
    expect(analysisInputHash(edited.document, fixture.analysisId, 'full')).not.toBe(before.full);
    expect(analysisInputHash(edited.document, fixture.analysisId, 'mesh')).toBe(before.mesh);
  });
});
