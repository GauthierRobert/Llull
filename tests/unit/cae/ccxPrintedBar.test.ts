/**
 * 14 FLL-M3 with the real solver: a printed bar (2 x 1 x 1 mm, 6 tetrahedra) pulled by a prescribed end displacement of 0.002 mm (strain 1e-3), the deck of
 * set_print_idealization solved by CalculiX. Oracle (the FRD carries 6 significant digits, tolerance 1e-5): the uniaxial stress is E_direction x strain, with E_direction the homogenised modulus of the coupon
 * direction the pull follows: build axis z -> the in-plane (XY) modulus, build axis x -> the build-direction (Z) modulus; their ratio is the coupon ratio 0.75.
 * Skipped without CalculiX (LLULL_CCX or ccx on the PATH).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { writeInp } from '@cae/decks/inpWriter';
import { parseFrd } from '@cae/results/frdReader';
import { requireTool } from '../../requireTool';
import { X0_NODES, X2_NODES, barDocument, barMesh } from './deckFixtures';
import { BAR_PRINT } from './printFixtures';

const CCX = process.env['LLULL_CCX'] ?? 'ccx';
const hasCcx = spawnSync(CCX, ['-v']).error === undefined;

/** Mean axial stress (MPa) of the printed bar pulled along x with build direction `layerAxis` (and the written deck). */
function pulled(layerAxis: readonly number[]): { stress: number[]; deck: string } {
  const bar = barDocument();
  const printed = execute(bar.doc, 'set_print_idealization', { analysisId: bar.analysisId, entityId: bar.boxId, ...BAR_PRINT, layerAxis });
  if (printed.rejected === true) throw new Error(printed.summary);
  const pull = execute(printed.document, 'add_fea_constraint', {
    analysisId: bar.analysisId,
    name: 'pull',
    kind: 'displacement',
    dofs: { ux: 0.002 },
    target: { entityId: bar.boxId, facesNear: [[2, 0.5, 0.5]] },
  });
  const sets = {
    [`C_${bar.constraints['x0']}`]: X0_NODES,
    [`C_${bar.constraints['nodeA']}`]: [1],
    [`C_${bar.constraints['nodeB']}`]: [3],
    [`C_${pull.affected[0]}`]: X2_NODES,
  };
  const mesh = barMesh(pull.document, bar.analysisId, bar.boxId, sets);
  const written = writeInp(pull.document, bar.analysisId, mesh);
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  const dir = mkdtempSync(join(tmpdir(), 'llull-ccx-print-'));
  try {
    writeFileSync(join(dir, 'job.inp'), written.text);
    const ran = spawnSync(CCX, ['-i', 'job'], { cwd: dir, encoding: 'utf8' });
    if (ran.status !== 0) throw new Error(`ccx failed: ${ran.stdout}\n${ran.stderr}`);
    const steps = parseFrd(readFileSync(join(dir, 'job.frd'), 'utf8'));
    const values = Object.values(steps[0]?.fields['STRESS']?.values ?? {});
    return { stress: values.map((row) => row[0] ?? NaN), deck: written.text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(requireTool('calculix', hasCcx))('CalculiX on the printed-bar deck', () => {
  const core = 0.4 ** 1.5;
  const factor = 0.5 + 0.5 * core;

  it('a bar pulled in the build plane and one pulled along the build direction give the two homogenised moduli', () => {
    const inPlane = pulled([0, 0, 1]);
    const along = pulled([1, 0, 0]);
    expect(inPlane.stress).toHaveLength(8);
    for (const sigma of inPlane.stress) expect(Math.abs(sigma / (2000 * factor * 0.001) - 1)).toBeLessThan(1e-5);
    for (const sigma of along.stress) expect(Math.abs(sigma / (1500 * factor * 0.001) - 1)).toBeLessThan(1e-5);
    const ratio = (along.stress[0] ?? 0) / (inPlane.stress[0] ?? 1);
    expect(ratio).toBeCloseTo(0.75, 5);
    expect(along.deck).toContain('ORIENTATION=OR_PRT_');
  });
});
