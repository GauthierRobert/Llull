/**
 * PST-M3 solver extras: the support active set is bounded (PST_NONLINEAR_NOT_CONVERGED names the toggling restraints), pressure with the Poisson option,
 * thermal strain from a document material, point loads with moments.
 */

import { describe, expect, it } from 'vitest';
import { pipeProperties } from '@lib/frame3d/section';
import type { FrameElement, FramePoint } from '@lib/frame3d/types';
import { solveWithContacts } from '@aec/plant/stress/solve/nonlinear';
import type { Contact } from '@aec/plant/stress/model/restraints';
import { strainModel, withModel as withMaterial } from '../../physics/thermomech/thermomechFixtures';
import { analyzed, anchorAt, baseDoc, cases, conditioned, DN100, reaction, withModel, withPipe } from './m3Fixtures';
import { expectRel } from './stressFixtures';

describe('bounded active set', () => {
  const nodes: FramePoint[] = [
    [0, 0, 0],
    [3000, 0, 0],
    [6000, 0, 0],
  ];
  const elements: FrameElement[] = [0, 1].map((a) => ({ a, b: a + 1, properties: pipeProperties(114.3, 6.02, 200000, 0.3) }));
  const rest: Contact = { node: 2, dof: 2, normal: 1, gapMm: 0, friction: 0, sources: ['rest-1'] };
  const lift = { name: 'L', nodal: [{ node: 1, force: [0, 0, 10000] as const }] };

  it('the lift-off case settles in two iterations', () => {
    const result = solveWithContacts({ nodes, elements }, [{ node: 0 }], [rest], lift);
    expect(result.ok && result.iterations).toBe(2);
  });

  it('with the iteration cap at 1 it stops with PST_NONLINEAR_NOT_CONVERGED naming the node and the restraint that toggled', () => {
    const result = solveWithContacts({ nodes, elements }, [{ node: 0 }], [rest], lift, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PST_NONLINEAR_NOT_CONVERGED');
    expect(result.sources).toEqual(['rest-1']);
    expect(result.nodes).toEqual([2]);
  });

  it('a mechanism inside the loop is PST_UNSTABLE with the DOF (no anchors)', () => {
    const result = solveWithContacts({ nodes, elements }, [], [rest], lift);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PST_UNSTABLE');
  });
});

describe('primitive loads', () => {
  const anchored = (): { doc: ReturnType<typeof baseDoc>; id: string; pipeId: string } => {
    const { doc: pipes, id: pipeId } = withPipe(
      baseDoc(),
      [
        [0, 0, 3000],
        [4000, 0, 3000],
      ],
      DN100.odMm,
    );
    const { doc, id } = withModel(pipes, [pipeId]);
    return { doc: anchorAt(anchorAt(doc, id, pipeId, 0), id, pipeId, 4000), id, pipeId };
  };

  it('pressure acts through the code stress only by default; with poissonPressure the hoop contraction shortens a restrained pipe: N = nu sigma_h A', () => {
    const { doc, id } = anchored();
    const run = (poissonPressure: boolean): number => {
      const d = cases(conditioned(doc, id, { pressures: [{ name: 'P1', gaugeBar: 40 }], poissonPressure }), id, [
        { name: 'P', type: 'SUS', basic: ['P1'] },
      ]);
      return reaction(analyzed(d, id, { include: ['reactions'] }), 'P', 'N1').forceN[0] as number;
    };
    expect(Math.abs(run(false))).toBeLessThan(1e-6);
    const hoop = (4 * DN100.odMm) / (2 * DN100.wallMm); // MPa per MPa of pressure
    const area = (Math.PI / 4) * (DN100.odMm ** 2 - (DN100.odMm - 2 * DN100.wallMm) ** 2);
    expectRel(Math.abs(run(true)), 0.3 * hoop * area, 1e-6, 'N = nu P Do A / (2 t)');
  });

  it('thermal strain from a document material (thermalStrain model): a restrained pipe carries E A alpha dT; an unverified basis is listed', () => {
    const { doc, id } = anchored();
    const withMat = withMaterial(doc, 'mat', strainModel(1.2e-5, 'typical'));
    const d = cases(
      conditioned(withMat, id, { installTempC: 20, temperatures: [{ name: 'T1', tempC: 120 }] }, { thermal: { materialId: 'mat' } }),
      id,
      [{ name: 'H', type: 'OPE', basic: ['T1'] }],
    );
    const result = analyzed(d, id, { include: ['reactions'] });
    const area = (Math.PI / 4) * (DN100.odMm ** 2 - (DN100.odMm - 2 * DN100.wallMm) ** 2);
    expectRel(Math.abs(reaction(result, 'H', 'N1').forceN[0] as number), 200000 * area * 1.2e-5 * 100, 1e-6, 'E A alpha dT');
    expect(result.findings.map((finding) => finding.code)).toContain('PST_MATERIAL_UNVERIFIED');
  });

  it('a point load with a moment is applied at its station: the anchor reaction balances force and moment', () => {
    const { doc, id, pipeId } = anchored();
    const d = cases(
      conditioned(doc, id),
      id,
      [{ name: 'F', type: 'SUS', basic: ['F1'] }],
      [{ name: 'F1', pipeId, atMm: 2000, forceN: [0, 0, 0], momentNmm: [0, 5e6, 0] }],
    );
    const result = analyzed(d, id, { include: ['reactions'] });
    const sum = (axis: number): number =>
      (reaction(result, 'F', 'N1').momentNmm[axis] as number) + (reaction(result, 'F', 'N3').momentNmm[axis] as number);
    // pure moment M about y at mid-span: the two anchors react with a moment couple summing to -M plus the force couple
    const forceCouple = (reaction(result, 'F', 'N3').forceN[2] as number) * 4000;
    expect(sum(1) - forceCouple).toBeCloseTo(-5e6, 0);
  });
});
