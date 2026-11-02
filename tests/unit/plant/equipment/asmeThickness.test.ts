/**
 * VC-EQP-05..07: ASME VIII-1 UG-27 / UG-32 thickness, MAWP and hydrotest of `vessel_thickness` against the validation pack
 * (docs/plant/03-parametric-equipment/validation/data/asme_viii_div1_examples.json: published values and independent re-derivations).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { createEmptyDocument } from '@core/model/types';
import { drumDocument, drumParams, mmDocument, separatorDocument } from './equipmentFixtures';

const REFERENCES = path.resolve(__dirname, '../../../../docs/plant/03-parametric-equipment/validation/data');
interface Example {
  id: string;
  inputs: Record<string, number>;
  published: Record<string, number>;
  derived: Record<string, number>;
}
const examples = (JSON.parse(readFileSync(path.join(REFERENCES, 'asme_viii_div1_examples.json'), 'utf8')) as { examples: Example[] })
  .examples;
const example = (id: string): Example => examples.find((candidate) => candidate.id === id) as Example;

const MM_PER_INCH = 25.4;
const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

interface Component {
  requiredThicknessMm: number;
  requiredCorrodedThicknessMm: number;
  availableThicknessMm: number;
  mawpMPa: number;
  status: string;
  failures: string[];
  formula: string;
}
interface Thickness {
  components: Record<string, Component>;
  mawpMPa: number;
  hydrotestPressureMPa: number;
  governingComponent: string;
  reviewRequired: boolean;
  unverified: boolean;
  status: string;
  warnings: Array<{ code: string }>;
  hydrotest: { stressRatio: number; stressRatioDefaulted: boolean };
}

const inchDocument = (): CadDocument => apply(createEmptyDocument(), 'set_units', { units: 'in' });

/** A vessel in inches with the example's design data; `heads` defaults to 2:1 heads, thick enough to be out of the way. */
function inchVessel(
  inputs: { P_psi: number; S_psi: number; E?: number; CA_in?: number },
  geometry: { D_in: number; shell?: number; head?: number; heads?: unknown },
): CadDocument {
  const ellipsoidal = { type: 'ellipsoidal', ratio: 2 };
  const heads = geometry.heads ?? ellipsoidal;
  return apply(inchDocument(), 'add_vessel', {
    tag: 'V-1',
    orientation: 'vertical',
    location: [0, 0],
    insideDiameter: geometry.D_in,
    tangentLength: geometry.D_in * 2,
    heads: { top: heads, bottom: heads },
    shellThickness: geometry.shell ?? 2,
    headThickness: geometry.head ?? 2,
    corrosionAllowance: inputs.CA_in ?? 0,
    support: { type: 'none' },
    design: {
      pressure: { value: inputs.P_psi, unit: 'psi' },
      allowableStress: { value: inputs.S_psi, unit: 'psi', source: 'validation example' },
      jointEfficiency: { shell: inputs.E ?? 1, heads: inputs.E ?? 1 },
    },
  });
}

const thickness = (doc: CadDocument, extra: object = {}): Thickness =>
  data<Thickness>(doc, 'vessel_thickness', { equipment: 'V-1', ...extra });

describe('VC-EQP-05: UG-27(c)(1) shell thickness', () => {
  it('UG27-A: P 100 psi, R 30 in, S 18800 psi, E 1 -> 0.1601 in (published), 1e-9 vs the derivation', () => {
    const { inputs, published, derived } = example('UG27-A');
    const result = thickness(inchVessel(inputs as never, { D_in: 2 * (inputs.R_in as number) }));
    const shell = result.components.shell as Component;
    expect(rel(shell.requiredThicknessMm / MM_PER_INCH, derived.t_in as number)).toBeLessThan(1e-9);
    expect(Math.abs(shell.requiredThicknessMm / MM_PER_INCH - (published.t_in as number))).toBeLessThan(5e-5);
    expect((shell as Component & { clause: string }).clause).toBe('UG-27(c)(1)');
  });

  it('UG27-B: D 46 in, E 0.85, CA 0.125 in -> t_r + CA = 0.3990 in with the corroded radius (published 0.399)', () => {
    const { inputs, published, derived } = example('UG27-B');
    const doc = inchVessel(inputs as never, { D_in: inputs.D_in as number });
    const shell = thickness(doc).components.shell as Component;
    expect(rel(shell.requiredThicknessMm / MM_PER_INCH, derived.trPlusCA_in as number)).toBeLessThan(1e-9);
    expect(rel(shell.requiredCorrodedThicknessMm / MM_PER_INCH, derived.tr_in as number)).toBeLessThan(1e-9);
    expect(Math.abs(shell.requiredThicknessMm / MM_PER_INCH - (published.trPlusCA_in as number))).toBeLessThan(1e-3);
  });

  it('UG27-C: corrodedDimensions:false reproduces the uncorroded-radius source (0.578 in); the default differs (0.5800 in)', () => {
    const { inputs, published, derived } = example('UG27-C');
    const doc = inchVessel(inputs as never, { D_in: 2 * (inputs.R_in as number) });
    const uncorroded = (thickness(doc, { corrodedDimensions: false }).components.shell as Component).requiredThicknessMm / MM_PER_INCH;
    expect(rel(uncorroded, derived.t_total_uncorrodedRadius_in as number)).toBeLessThan(1e-9);
    expect(Math.abs(uncorroded - (published.t_total_in as number))).toBeLessThan(5e-4);
    const corroded = (thickness(doc).components.shell as Component).requiredThicknessMm / MM_PER_INCH;
    expect(rel(corroded, derived.t_total_corrodedRadius_in as number)).toBeLessThan(1e-9);
    expect(corroded).toBeGreaterThan(uncorroded);
  });

  it('SC-EQP-01 / 02 numbers (5 digits of the plan rows): shell, head, MAWP, hydrotest', () => {
    const separator = data<Thickness>(separatorDocument(), 'vessel_thickness', { equipment: 'V-101' });
    expect(rel(separator.components.shell?.requiredThicknessMm ?? 0, 8.484340859431901)).toBeLessThan(1e-9);
    expect(rel(separator.components.headTop?.requiredThicknessMm ?? 0, 8.4644412191582)).toBeLessThan(1e-9);
    expect(rel(separator.mawpMPa, 1.2748283148441628)).toBeLessThan(1e-9);
    expect(rel(separator.hydrotestPressureMPa, 1.6572768092974117)).toBeLessThan(1e-9);
    expect(separator.governingComponent).toBe('shell');
    const drum = data<Thickness>(drumDocument(false), 'vessel_thickness', { equipment: 'D-201' });
    expect(rel(drum.components.shell?.requiredThicknessMm ?? 0, 15.934703176718392)).toBeLessThan(1e-9);
    expect(rel(drum.mawpMPa, 1.737376482213439)).toBeLessThan(1e-9);
    expect(rel(drum.hydrotestPressureMPa, 2.258589426877471)).toBeLessThan(1e-9);
    expect(Object.keys(drum.components)).toEqual(['shell', 'headLeft', 'headRight']);
  });
});

describe('VC-EQP-06: UG-32 heads', () => {
  const headRequired = (result: Thickness): number => (result.components.headTop as Component).requiredThicknessMm / MM_PER_INCH;

  it.each([
    ['UG32E-A', 't_total_in', false],
    ['UG32E-B', 't_in', true],
  ])('%s 2:1 ellipsoidal matches the derivation to 1e-9 and the published value within its rounding', (id, key, corroded) => {
    const { inputs, published, derived } = example(id);
    const doc = inchVessel(inputs as never, { D_in: inputs.D_in as number });
    // UG32E-A is the checalc example (S10): it uses the uncorroded diameter, like UG27-C
    const required = headRequired(thickness(doc, { corrodedDimensions: corroded }));
    expect(rel(required, derived[key] as number)).toBeLessThan(1e-9);
    expect(Math.abs(required - (published[key] as number))).toBeLessThan(1e-3);
  });

  it.each(['UG32T-A', 'UG32T-B'])('%s ASME F&D torispherical (L = D) matches the derivation to 1e-9', (id) => {
    const { inputs, published, derived } = example(id);
    const length = inputs.L_in as number;
    const doc = inchVessel(inputs as never, { D_in: length, heads: { type: 'torispherical', standard: 'asme_fd' }, head: 0.5, shell: 0.5 });
    const required = headRequired(thickness(doc));
    expect(rel(required, derived.t_in as number)).toBeLessThan(1e-9);
    expect(Math.abs(required - (published.t_in as number))).toBeLessThan(1e-3);
  });

  it('a hemispherical head uses UG-32(f): t = P L / (2 S E - 0.2 P) with L the (corroded) inside radius', () => {
    const doc = inchVessel({ P_psi: 200, S_psi: 20000, CA_in: 0.1 }, { D_in: 40, heads: { type: 'hemispherical' } });
    const required = headRequired(thickness(doc));
    expect(rel(required, (200 * 20.1) / (2 * 20000 - 0.2 * 200) + 0.1)).toBeLessThan(1e-12);
  });

  it('an uncovered head is refused per part: conical, DIN 28011 (k/L 0.1) and a 3:1 ellipse -> EQP_HEAD_NOT_COVERED with the head path', () => {
    const inputs = { P_psi: 100, S_psi: 20000 };
    const conical = { type: 'conical', halfAngleDeg: 45 };
    expectRefusal(
      inchVessel(inputs, { D_in: 40, heads: conical }),
      'vessel_thickness',
      { equipment: 'V-1' },
      'EQP_HEAD_NOT_COVERED',
      'heads.first',
    );
    const din = { type: 'torispherical', standard: 'din_28011' };
    expectRefusal(
      inchVessel(inputs, { D_in: 40, heads: din }),
      'vessel_thickness',
      { equipment: 'V-1' },
      'EQP_HEAD_NOT_COVERED',
      'heads.first',
    );
    const three = { type: 'ellipsoidal', ratio: 3 };
    expectRefusal(
      inchVessel(inputs, { D_in: 40, heads: three }),
      'vessel_thickness',
      { equipment: 'V-1' },
      'EQP_HEAD_NOT_COVERED',
      'heads.first',
    );
  });
});

describe('VC-EQP-07: applicability limits, missing allowable, MAWP round trip', () => {
  it('the UG-27(c)(1) pressure limit is 0.385 S E (S 137.9 MPa, E 1 -> 53.0915 MPa) and 60 MPa is refused with the pressure path', () => {
    const doc = separatorDocument(false);
    const result = data<Thickness & { components: { shell: Component & { pressureLimitMPa: number } } }>(doc, 'vessel_thickness', {
      equipment: 'V-101',
    });
    expect(rel(result.components.shell.pressureLimitMPa, 53.0915)).toBeLessThan(1e-6);
    expectRefusal(
      doc,
      'vessel_thickness',
      { equipment: 'V-101', pressure: { value: 60, unit: 'MPa' } },
      'EQP_FORMULA_OUT_OF_RANGE',
      'pressure',
    );
    const high = apply(doc, 'update_equipment_parameters', {
      equipment: 'V-101',
      set: { design: { pressure: { value: 60, unit: 'MPa' } } },
    });
    expectRefusal(high, 'vessel_thickness', { equipment: 'V-101' }, 'EQP_FORMULA_OUT_OF_RANGE', 'design.pressure');
    expect(execute(doc, 'vessel_thickness', { equipment: 'V-101', pressure: { value: 52, unit: 'MPa' } }).rejected).toBeUndefined();
    expectRefusal(
      doc,
      'vessel_thickness',
      { equipment: 'V-101', pressure: { value: 53.1, unit: 'MPa' } },
      'EQP_FORMULA_OUT_OF_RANGE',
      'pressure',
    );
  });

  it('a REQUIRED wall above R/2 is outside UG-27(c)(1): refused with the shellThickness path (P between 0.3846 and 0.385 S E)', () => {
    const doc = inchVessel({ P_psi: 7696, S_psi: 20000 }, { D_in: 10, shell: 4 });
    expectRefusal(doc, 'vessel_thickness', { equipment: 'V-1' }, 'EQP_FORMULA_OUT_OF_RANGE', 'shellThickness');
  });

  it('an AVAILABLE wall above R/2 at low pressure is not refused: the shell MAWP is flagged mawpUnverified, is not governing and never fails', () => {
    const doc = inchVessel({ P_psi: 100, S_psi: 20000 }, { D_in: 10, shell: 3, head: 0.5 });
    const result = thickness(doc);
    const shell = result.components.shell as Component & { mawpUnverified?: boolean };
    expect(shell.mawpUnverified).toBe(true);
    expect(shell.failures).toEqual([]);
    expect(result.governingComponent).not.toBe('shell');
    expect(result.mawpMPa).toBe(Math.min(...['headBottom', 'headTop'].map((key) => (result.components[key] as Component).mawpMPa)));
    expect((result.components.headTop as Component & { mawpUnverified?: boolean }).mawpUnverified).toBeUndefined();
  });

  it('UG-32(e): a torispherical head thinner than t/L = 0.002 is EQP_HEAD_NOT_COVERED (query) and a warning (check); 0.00208 is accepted', () => {
    const fd = { type: 'torispherical', standard: 'asme_fd' };
    const thin = inchVessel({ P_psi: 10, S_psi: 20000 }, { D_in: 12, shell: 0.5, head: 0.0125, heads: fd });
    expectRefusal(thin, 'vessel_thickness', { equipment: 'V-1' }, 'EQP_HEAD_NOT_COVERED', 'heads.first');
    const warned = data<{ issues: Array<{ code: string; severity: string; paths: string[] }> }>(thin, 'check_equipment', {});
    expect(warned.issues.filter((issue) => issue.code === 'EQP_HEAD_NOT_COVERED').map((issue) => [issue.severity, issue.paths[0]])).toEqual(
      [
        ['warning', 'heads.first'],
        ['warning', 'heads.second'],
      ],
    );
    const ok = inchVessel({ P_psi: 10, S_psi: 20000 }, { D_in: 12, shell: 0.5, head: 0.025, heads: fd });
    expect((thickness(ok).components.headTop as Component).status).toBe('pass_with_review');
  });

  it('UG-32(f): a hemispherical head with t > 0.356 L and P > 0.665 S E is EQP_FORMULA_OUT_OF_RANGE (heads.first); P below that limit is accepted', () => {
    const base = inchVessel({ P_psi: 7400, S_psi: 20000 }, { D_in: 40, shell: 10, head: 10, heads: { type: 'hemispherical' } });
    const weak = apply(base, 'update_equipment_parameters', {
      equipment: 'V-1',
      set: { design: { jointEfficiency: { shell: 1, heads: 0.5 } } },
    });
    expectRefusal(weak, 'vessel_thickness', { equipment: 'V-1' }, 'EQP_FORMULA_OUT_OF_RANGE', 'heads.first');
    const found = data<{ issues: Array<{ code: string; paths: string[] }> }>(weak, 'check_equipment', {}).issues;
    expect(found.filter((issue) => issue.code === 'EQP_FORMULA_OUT_OF_RANGE').map((issue) => issue.paths[0])).toEqual([
      'heads.first',
      'heads.second',
    ]);
    const lower = apply(weak, 'update_equipment_parameters', {
      equipment: 'V-1',
      set: { design: { pressure: { value: 6000, unit: 'psi' } } },
    });
    expect(execute(lower, 'vessel_thickness', { equipment: 'V-1' }).rejected).toBeUndefined();
  });

  it('a missing allowable stress or joint efficiency is never defaulted: EQP_ALLOWABLE_MISSING with the design path', () => {
    const { design, ...bare } = drumParams;
    const withoutDesign = apply(mmDocument(), 'add_vessel', { ...bare, design: { pressure: design.pressure } });
    expectRefusal(withoutDesign, 'vessel_thickness', { equipment: 'D-201' }, 'EQP_ALLOWABLE_MISSING', 'design.allowableStress');
    const withoutE = apply(mmDocument(), 'add_vessel', {
      ...bare,
      design: { pressure: design.pressure, allowableStress: design.allowableStress },
    });
    expectRefusal(withoutE, 'vessel_thickness', { equipment: 'D-201' }, 'EQP_ALLOWABLE_MISSING', 'design.jointEfficiency');
    const noPressure = apply(mmDocument(), 'add_vessel', {
      ...bare,
      design: { allowableStress: design.allowableStress, jointEfficiency: design.jointEfficiency },
    });
    expectRefusal(noPressure, 'vessel_thickness', { equipment: 'D-201' }, 'EQP_DESIGN_DATA_MISSING', 'design.pressure');
    expect(
      data<Thickness>(noPressure, 'vessel_thickness', { equipment: 'D-201', pressure: { value: 1, unit: 'MPa' } }).mawpMPa,
    ).toBeGreaterThan(1);
  });

  it('MAWP round trip: a shell built exactly at the required thickness has MAWP = P within 1e-12 relative', () => {
    const base = separatorDocument(false);
    const required = (data<Thickness>(base, 'vessel_thickness', { equipment: 'V-101' }).components.shell as Component).requiredThicknessMm;
    const exact = apply(base, 'update_equipment_parameters', { equipment: 'V-101', set: { shellThickness: required, headThickness: 40 } });
    const result = data<Thickness>(exact, 'vessel_thickness', { equipment: 'V-101' });
    expect(rel(result.components.shell?.mawpMPa ?? 0, 1)).toBeLessThan(1e-12);
    expect(result.status).toBe('pass_with_review');
  });

  it('unit handling: 100 psi = 0.689475729 MPa gives the same thickness as MPa input; kPa and bar likewise', () => {
    const doc = separatorDocument(false);
    const reference = data<Thickness>(doc, 'vessel_thickness', { equipment: 'V-101', pressure: { value: 1, unit: 'MPa' } });
    for (const pressure of [
      { value: 1000, unit: 'kPa' },
      { value: 10, unit: 'bar' },
      { value: 1 / 0.006894757293168, unit: 'psi' },
    ]) {
      const other = data<Thickness>(doc, 'vessel_thickness', { equipment: 'V-101', pressure });
      expect(rel(other.mawpMPa, reference.mawpMPa)).toBeLessThan(1e-12);
      expect(rel(other.components.shell?.requiredThicknessMm ?? 0, reference.components.shell?.requiredThicknessMm ?? 0)).toBeLessThan(
        1e-12,
      );
    }
  });
});

describe('vessel_thickness: status, hydrotest and what-if', () => {
  it('SC-EQP-02 revision: a 12 mm shell fails with the shell under-thickness and MAWP (plan step 12)', () => {
    const thin = apply(drumDocument(false), 'update_equipment_parameters', { equipment: 'D-201', set: { shellThickness: 12 } });
    const result = data<Thickness>(thin, 'vessel_thickness', { equipment: 'D-201' });
    expect(result.status).toBe('fail');
    const shell = result.components.shell as Component;
    expect(shell.failures).toEqual(['EQP_SHELL_UNDER_THICKNESS', 'EQP_MAWP_BELOW_DESIGN']);
    expect(shell.availableThicknessMm).toBe(9);
    expect(rel(shell.requiredThicknessMm - 3, 15.934703176718392 - 3)).toBeLessThan(1e-12);
    expect(rel(shell.mawpMPa, (137.9 * 0.85 * 9) / (1003 + 0.6 * 9))).toBeLessThan(1e-12);
  });

  it('hydrotest uses S_test / S_design when given, else 1 and says it was defaulted', () => {
    const doc = apply(separatorDocument(false), 'update_equipment_parameters', {
      equipment: 'V-101',
      set: { design: { allowableStressAtTest: { value: 160, unit: 'MPa', source: 'test table' } } },
    });
    const result = data<Thickness>(doc, 'vessel_thickness', { equipment: 'V-101' });
    expect(result.hydrotest).toMatchObject({ stressRatioDefaulted: false });
    expect(rel(result.hydrotestPressureMPa, 1.3 * result.mawpMPa * (160 / 137.9))).toBeLessThan(1e-12);
    expect(data<Thickness>(separatorDocument(false), 'vessel_thickness', { equipment: 'V-101' }).hydrotest.stressRatioDefaulted).toBe(true);
  });

  it('is read-only (same document object), refuses an unknown or legacy equipment, and a what-if pressure does not touch the vessel', () => {
    const doc = separatorDocument(false);
    const result = execute(doc, 'vessel_thickness', { equipment: 'V-101', pressure: { value: 2, unit: 'MPa' } });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expectRefusal(doc, 'vessel_thickness', { equipment: 'V-999' }, 'EQP_NOT_FOUND', 'equipment');
    const legacy = apply(mmDocument(), 'add_equipment', { name: 'Skid', mark: 'S-1', location: [0, 0], size: [1000, 1000, 1000] });
    expectRefusal(legacy, 'vessel_thickness', { equipment: 'S-1' }, 'EQP_NOT_PARAMETRIC', 'equipment');
  });
});
