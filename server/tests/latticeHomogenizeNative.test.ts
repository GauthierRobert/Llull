/**
 * lattice_properties `homogenize` (05 IMP 14.15): periodic numerical homogenisation on the native voxel FE solver (`llull-compute homogenize`). The octet against its closed-form
 * stretch-dominated stiffness (the voxel model converges towards it from above as the voxels shrink), cubic symmetry to rounding, a slender cell, a non-cubic cell, the cap, determinism.
 * Native runs need llull-compute (cargo build in solver/) and are skipped otherwise; the refusal without the native engine always runs.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { createNativeFieldEngine } from '../src/native/fieldEngine';
import { nativeBinaryPath } from '../src/native/nativeBinary';

const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null) console.warn('latticeHomogenizeNative: llull-compute not built (cargo build in solver/): native runs skipped');
const native = BINARY === null ? it.skip : it;
const engine = BINARY === null ? null : createNativeFieldEngine({ binary: BINARY });
const ctx = () => ({ ...defaultContext(), ...(engine === null ? {} : { fieldEngine: engine }) });

interface Homogenization {
  youngRatio: number[];
  shearRatio: number[];
  poisson: number[];
  youngModulusMpa: number[] | null;
  stiffnessRatio: { c: number[] };
  volumeFraction: { fine: number; coarse: number };
  symmetry: { cubicCell: boolean; asymmetry: number; cubicDeviation: number | null };
  convergence: { relativeChange: number | null; solverConverged: boolean; coarse: { resolution: number; youngRatio: number[] } };
  resolution: { fine: number; coarse: number };
  unverified: boolean;
  reviewRequired: boolean;
  warning: string;
}

type Data = Record<string, unknown> & { homogenization?: Homogenization; mechanics?: { affine: { youngRatio: number[] } } };

function lattice(cell: string, radius: number, cellSize: unknown = 10): { doc: CadDocument; id: string } {
  const made = execute(createEmptyDocument(), 'add_strut_lattice', { cell, cellSize, radius });
  return { doc: made.document, id: made.affected[0] as string };
}

function homogenized(doc: CadDocument, id: string, extra: object): { result: ReturnType<typeof execute>; data: Data } {
  const result = execute(doc, 'lattice_properties', { id, resolution: 32, ...extra }, ctx());
  return { result, data: result.data as Data };
}

describe('lattice_properties homogenize (14.15)', () => {
  native('the octet: cubic to rounding, above the closed-form stretch stiffness and converging towards it as the voxels shrink', () => {
    const { doc, id } = lattice('octet', 0.5);
    const coarse = homogenized(doc, id, { estimateMechanics: true, homogenize: { resolution: 16 } });
    const fine = homogenized(doc, id, { estimateMechanics: true, homogenize: { resolution: 32 } });
    const [low, high] = [coarse.data.homogenization as Homogenization, fine.data.homogenization as Homogenization];
    const closed = (fine.data.mechanics as { affine: { youngRatio: number[] } }).affine.youngRatio[0] as number; // rho Es / 9
    for (const h of [low, high]) {
      expect(h.symmetry.cubicCell).toBe(true);
      expect(h.symmetry.cubicDeviation as number).toBeLessThan(1e-12);
      expect(h.symmetry.asymmetry).toBeLessThan(1e-12);
      expect(h.youngRatio[0]).toBeCloseTo(h.youngRatio[1] as number, 12);
      expect(h.youngRatio[1]).toBeCloseTo(h.youngRatio[2] as number, 12);
      expect(h.convergence.solverConverged).toBe(true);
    }
    // the voxel model of thin struts is too stiff at a coarse resolution and approaches the pin-jointed value from above
    expect(low.youngRatio[0]).toBeGreaterThan(high.youngRatio[0] as number);
    expect(high.youngRatio[0]).toBeGreaterThan(closed);
    expect((high.youngRatio[0] as number) / closed).toBeLessThan(1.6);
    expect((low.youngRatio[0] as number) / closed).toBeLessThan(2.4);
    expect(high.convergence.relativeChange).toBeGreaterThan(0.05); // 16 -> 32 is not yet converged and the block says so
    expect(high.convergence.coarse.resolution).toBe(16);
    expect(high.resolution).toEqual({ fine: 32, coarse: 16 });
    expect(high).toMatchObject({ unverified: true, reviewRequired: true, warning: 'IMP_MECHANICS_UNVERIFIED' });
    expect(fine.data['unverified']).toBe(true);
    // the voxel volume fraction is the measured density (the voxels are partial volumes)
    expect(Math.abs(high.volumeFraction.fine - (fine.data['rhoMeasured'] as number)) / (fine.data['rhoMeasured'] as number)).toBeLessThan(
      0.1,
    );
  });

  native('E, nu and G of a cubic cell follow its stiffness C11, C12, C44, and the MPa values scale the ratios', () => {
    const { doc, id } = lattice('octet', 1);
    const { data } = homogenized(doc, id, {
      homogenize: { resolution: 24, poissonRatio: 0.3 },
      baseMaterial: { youngModulusMpa: 70000, source: 'data sheet' },
    });
    const h = data.homogenization as Homogenization;
    const [c11, c12, c44] = [h.stiffnessRatio.c[0] as number, h.stiffnessRatio.c[1] as number, h.stiffnessRatio.c[21] as number];
    // E = (C11 - C12)(C11 + 2 C12) / (C11 + C12); nu = C12 / (C11 + C12); G = C44
    expect(h.youngRatio[0]).toBeCloseTo(((c11 - c12) * (c11 + 2 * c12)) / (c11 + c12), 10);
    expect(h.poisson[0]).toBeCloseTo(c12 / (c11 + c12), 10);
    expect(h.shearRatio[0]).toBeCloseTo(c44, 12);
    expect(h.youngModulusMpa?.[0]).toBeCloseTo((h.youngRatio[0] as number) * 70000, 6);
  });

  native('a slender cubic lattice is far less stiff than its Voigt bound and weakest in shear; a non-cubic cell is orthotropic', () => {
    const cubic = lattice('cubic', 0.5);
    const slender = homogenized(cubic.doc, cubic.id, { homogenize: { resolution: 16 } }).data.homogenization as Homogenization;
    // along a bar of the simple cubic lattice the stiffness is rho / 3 of the solid (one of three bar directions); the voxel bars are a little stiff
    const ratio = (slender.youngRatio[0] as number) / slender.volumeFraction.fine;
    expect(ratio).toBeGreaterThan(1 / 3 - 0.01);
    expect(ratio).toBeLessThan((1 / 3) * 1.25);
    expect(slender.shearRatio[0] as number).toBeLessThan((slender.youngRatio[0] as number) / 10);
    const tall = lattice('cubic', 0.5, [10, 10, 20]);
    const orthotropic = homogenized(tall.doc, tall.id, { homogenize: { resolution: 16 } }).data.homogenization as Homogenization;
    expect(orthotropic.symmetry.cubicCell).toBe(false);
    expect(orthotropic.symmetry.cubicDeviation).toBeNull();
    expect(orthotropic.symmetry.asymmetry).toBeLessThan(1e-12);
    expect(orthotropic.youngRatio[0]).toBeCloseTo(orthotropic.youngRatio[1] as number, 12);
  });

  native('is deterministic, and refuses a cell above the voxel cap by name', () => {
    const { doc, id } = lattice('octet', 1);
    const a = homogenized(doc, id, { homogenize: { resolution: 16 } }).data.homogenization;
    const b = homogenized(doc, id, { homogenize: { resolution: 16 } }).data.homogenization;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const tall = lattice('cubic', 0.5, [10, 10, 40]);
    const refused = execute(tall.doc, 'lattice_properties', { id: tall.id, homogenize: { resolution: 64 } }, ctx());
    expect(refused.error?.code).toBe('IMP_HOMOGENIZATION_TOO_LARGE');
    expect(refused.document).toBe(tall.doc);
    const invalid = execute(doc, 'lattice_properties', { id, homogenize: { resolution: 4 } }, ctx());
    expect(invalid.error?.code).toBe('CMD_INVALID_PARAMS');
  });

  it('without the native engine the request is refused by name and the document is unchanged', () => {
    const { doc, id } = lattice('octet', 1);
    const refused = execute(doc, 'lattice_properties', { id, homogenize: {} });
    expect(refused.error?.code).toBe('IMP_HOMOGENIZATION_NEEDS_NATIVE');
    expect(refused.document).toBe(doc);
  });
});
