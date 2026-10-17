/** check_thermo_mechanical items: remediations are actionable (no pointer to an internal spec) and messages agree with compute_margins behaviour. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { checkThermomechItems } from '@cae/thermomech/check';
import { cteModel } from '../../physics/thermomech/thermomechFixtures';
import { thermoFixture } from './fixtures';

describe('thermo-mechanical check remediations', () => {
  it('TMC_CTE_BASIS_UNKNOWN tells how to state the CTE basis', () => {
    const fixture = thermoFixture({ model: { ...cteModel({ kind: 'constant', value: 1e-5 }), variables: [{ variable: 'T', unit: 'K' }] } });
    const found = checkThermomechItems(fixture.doc, fixture.analysisId).find((entry) => entry.code === 'TMC_CTE_BASIS_UNKNOWN');
    expect(found?.remediation).toContain('cteBasis');
    expect(found?.remediation).not.toMatch(/TECHNICAL_SPEC|§/);
  });

  it('no item of any code points to an internal spec section', () => {
    const empty = thermoFixture({ model: null, field: null });
    const items = checkThermomechItems(empty.doc, empty.analysisId);
    expect(items.length).toBeGreaterThan(1);
    for (const entry of items) expect(entry.remediation, entry.code).not.toMatch(/TECHNICAL_SPEC|§|see the command description/);
  });

  it('TMC_THERMAL_CATEGORY_UNSET does not claim that margins are refused (compute_margins still runs, as a LIMIT case)', () => {
    const fixture = thermoFixture();
    const found = checkThermomechItems(fixture.doc, fixture.analysisId).find((entry) => entry.code === 'TMC_THERMAL_CATEGORY_UNSET');
    expect(found?.severity).toBe('warning');
    expect(found?.message).not.toContain('refused');
    expect(found?.message).toContain('LIMIT');
    expect(found?.remediation).toContain('add_fea_load');
    expect(execute(fixture.doc, 'check_thermo_mechanical', { analysisId: fixture.analysisId }).rejected).toBeUndefined();
  });
});
