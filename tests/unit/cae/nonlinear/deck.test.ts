import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { writeInp } from '@cae/decks/inpWriter';
import { caseOf, withCase } from '@cae/shared/access';
import { barMesh, mustRun } from '../deckFixtures';
import { meshOf, nonlinearBar, pressureBar, pulledBar, step } from './support';

const normalised = (text: string): string =>
  text
    .replace(/inputHash \w+ meshHash \w+/, 'inputHash H meshHash M')
    .replace(/(stp|prb)[-_]\d+[._]\d+/g, (_match, kind: string) => `${kind.toUpperCase()}_X`)
    .replace(/sha256=\w+/, 'sha256=S');

const deck = (doc: CadDocument, analysisId: string, mesh: ReturnType<typeof meshOf>): string => {
  const written = writeInp(doc, analysisId, mesh);
  if (!('text' in written)) throw new Error(`${written.code}: ${written.message}`);
  return written.text;
};

describe('nonlinear_static deck', () => {
  it('writes a displacement-controlled NLGEOM step with *PLASTIC from the selected set and the curve-probe prints (golden)', () => {
    const bar = pulledBar();
    const text = normalised(deck(bar.doc, bar.analysisId, meshOf(bar)));
    expect(text).toBe(`** llull analysis bar units N-mm-t-s inputHash H meshHash M
*NODE, NSET=NALL
1, 0, 0, 0
2, 2, 0, 0
3, 0, 1, 0
4, 2, 1, 0
5, 0, 0, 1
6, 2, 0, 1
7, 0, 1, 1
8, 2, 1, 1
*ELEMENT, TYPE=C3D4, ELSET=P_box_1_1
1, 1, 2, 4, 8
2, 1, 6, 2, 8
3, 1, 4, 3, 8
4, 1, 3, 7, 8
5, 1, 5, 6, 8
6, 1, 7, 5, 8
*ELSET, ELSET=EALL
P_box_1_1
*NSET, NSET=C_fc_10_1
3
*NSET, NSET=C_fc_8_1
1, 3, 5, 7
*NSET, NSET=C_fc_9_1
1
*NSET, NSET=N_PRB_X
2
*NSET, NSET=S_STP_X
2, 4, 6, 8
** material M_1 = 'steel'
** llull material steel/nl sha256=S unverified=none
*MATERIAL,NAME=M_1
*ELASTIC
210000.,0.3
*PLASTIC,HARDENING=ISOTROPIC
250.,0.
*DENSITY
7.85e-9
*SOLID SECTION, ELSET=P_box_1_1, MATERIAL=M_1
** step STP_X pull
*STEP, NLGEOM, INC=50
*STATIC
0.1, 1, 0.001, 0.25
*BOUNDARY, OP=NEW
C_fc_8_1, 1, 1
C_fc_9_1, 2, 2
C_fc_9_1, 3, 3
C_fc_10_1, 3, 3
*BOUNDARY
S_STP_X, 1, 1, 0.01
*NODE FILE
U, RF
*EL FILE
S, E, PEEQ
*NODE PRINT, NSET=N_PRB_X
U
*NODE PRINT, NSET=C_fc_8_1, TOTALS=ONLY
RF
*END STEP
`);
  });

  it('uses the selected constitutive set instead of the record default', () => {
    const bar = pulledBar();
    const doc = mustRun(bar.doc, 'set_part_constitutive_set', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      constitutiveSetId: 'soft',
    });
    const text = deck(doc, bar.analysisId, meshOf(bar, doc));
    expect(text).toContain('*PLASTIC,HARDENING=ISOTROPIC\n50.,0.\n');
    expect(text).not.toContain('250.,0.');
  });

  it('restates loads per step by multiplier (MOD), keeps the zero that unloads, and omits the boundary block after step 1', () => {
    const bar = pressureBar();
    const text = normalised(deck(bar.doc, bar.analysisId, bar.mesh));
    const steps = text.slice(text.indexOf('** step'));
    expect(steps).toBe(`** step STP_X up
*STEP, INC=20
*STATIC
0.1, 1, 0.01, 0.5
*BOUNDARY, OP=NEW
C_fc_8_1, 1, 1
C_fc_9_1, 2, 2
C_fc_9_1, 3, 3
C_fc_10_1, 3, 3
*DLOAD
1, P3, 50
2, P3, 50
*NODE FILE
U, RF
*EL FILE
S, E, PEEQ
*NODE PRINT, NSET=N_PRB_X
U
*END STEP
** step STP_X down
*STEP, INC=20
*STATIC
0.1, 1, 0.01, 0.5
*DLOAD
1, P3, 0
2, P3, 0
*NODE FILE
U, RF
*EL FILE
S, E, PEEQ
*NODE PRINT, NSET=N_PRB_X
U
*END STEP
`);
    expect(text).not.toContain('NLGEOM');
  });

  it('references a named amplitude from loads when a step asks for the full value at once', () => {
    const bar = pressureBar({ amplitude: 'step' });
    const text = normalised(deck(bar.doc, bar.analysisId, bar.mesh));
    expect(text).toContain('*AMPLITUDE, NAME=A_STP_X\n0, 1, 1, 1\n** step STP_X up');
    expect(text).toContain('*DLOAD, AMPLITUDE=A_STP_X\n1, P3, 50');
    expect(text).toContain('*DLOAD\n1, P3, 0');
  });

  it('writes *CONTROLS cards only for a custom preset, blank cells keeping the solver default', () => {
    const bar = pressureBar({
      controls: { convergence: { name: 'custom', field: { Rn: 0.01, qu: 1e-3 }, timeIncrementation: { I0: 6, IA: 10 } } },
    });
    const text = deck(bar.doc, bar.analysisId, bar.mesh);
    expect(text).toContain(
      '*STATIC\n0.1, 1, 0.01, 0.5\n*CONTROLS, PARAMETERS=FIELD\n0.01, , , 0.001\n*CONTROLS, PARAMETERS=TIME INCREMENTATION\n6, , , , , , , 10\n',
    );
    expect(deck(pressureBar().doc, bar.analysisId, pressureBar().mesh)).not.toContain('*CONTROLS');
  });

  it('thins the output with FREQUENCY for every-n and last_per_step', () => {
    const every = pressureBar({ controls: { outputIncrements: { every: 4 } } });
    const text = deck(every.doc, every.analysisId, every.mesh);
    expect(text).toContain('*NODE FILE, FREQUENCY=4\nU, RF\n*EL FILE, FREQUENCY=4\nS, E, PEEQ\n*NODE PRINT, NSET=N_prb_');
    expect(text).toMatch(/\*NODE PRINT, NSET=N_prb_\d+_\d+, FREQUENCY=4\n/);
    const last = pressureBar({ controls: { outputIncrements: 'last_per_step' } });
    expect(deck(last.doc, last.analysisId, last.mesh)).toContain('*NODE FILE, FREQUENCY=21\n');
  });

  it('is byte-deterministic', () => {
    const bar = pulledBar();
    expect(deck(bar.doc, bar.analysisId, meshOf(bar))).toBe(deck(bar.doc, bar.analysisId, meshOf(bar)));
  });
});

describe('nonlinear_static deck refusals', () => {
  const codeOf = (doc: CadDocument, analysisId: string, mesh: ReturnType<typeof meshOf>): string => {
    const written = writeInp(doc, analysisId, mesh);
    return 'code' in written ? written.code : 'written';
  };

  it('needs nlgeom and at least one step', () => {
    const bar = nonlinearBar();
    const meshFor = (doc: CadDocument): ReturnType<typeof barMesh> => barMesh(doc, bar.analysisId, bar.boxId, bar.sets);
    expect(codeOf(bar.doc, bar.analysisId, meshFor(bar.doc))).toBe('NLS_NLGEOM_UNSET');
    const selected = mustRun(bar.doc, 'set_part_constitutive_set', { analysisId: bar.analysisId, entityId: bar.boxId });
    expect(codeOf(selected, bar.analysisId, meshFor(selected))).toBe('NLS_NLGEOM_UNSET');
    const controlled = mustRun(bar.doc, 'set_nonlinear_controls', { analysisId: bar.analysisId, nlgeom: true });
    expect(codeOf(controlled, bar.analysisId, meshFor(controlled))).toBe('NLS_NO_STEPS');
  });

  it('refuses a step target or probe node the mesh did not resolve', () => {
    const bar = pulledBar();
    const without = (key: string): Record<string, number[]> =>
      Object.fromEntries(Object.entries(bar.meshSets).filter(([name]) => name !== key));
    const withoutStep = without(`S_${bar.stepId}`);
    expect(codeOf(bar.doc, bar.analysisId, meshOf({ ...bar, meshSets: withoutStep }))).toBe('FEA_TARGET_UNRESOLVED');
    const withoutProbe = without(`N_${bar.probeId}`);
    expect(codeOf(bar.doc, bar.analysisId, meshOf({ ...bar, meshSets: withoutProbe }))).toBe('FEA_TARGET_UNRESOLVED');
  });

  it('refuses a probe whose constraint or load was deleted afterwards', () => {
    const bar = pulledBar();
    const gone = mustRun(bar.doc, 'delete_fea_constraint', { analysisId: bar.analysisId, constraintId: bar.constraints['x0'] });
    expect(codeOf(gone, bar.analysisId, meshOf({ ...bar, doc: gone }, gone))).toBe('NLS_PROBE_REFERENCE_UNKNOWN');
    const pressure = pressureBar();
    const noLoad = mustRun(pressure.doc, 'delete_fea_load', { analysisId: pressure.analysisId, loadId: pressure.loadId });
    expect(codeOf(noLoad, pressure.analysisId, { ...pressure.mesh, inputHash: pressure.mesh.inputHash })).toMatch(
      /NLS_PROBE_REFERENCE_UNKNOWN|FEA_MESH_STALE/,
    );
  });

  it('refuses parts that share a material but select different sets, and an elastic-only override', () => {
    const bar = pulledBar();
    const analysis = caseOf(bar.doc, bar.analysisId);
    const second = step(bar.doc, 'add_box', { size: [1, 1, 1], position: [5, 0, 0] });
    const secondId = Object.keys(second.doc.entities).find((id) => id !== bar.boxId) ?? '';
    let doc = mustRun(second.doc, 'assign_material', { materialName: 'steel', entityIds: [secondId] });
    doc = mustRun(doc, 'set_part_idealization', { analysisId: bar.analysisId, entityId: secondId });
    doc = mustRun(doc, 'set_part_constitutive_set', { analysisId: bar.analysisId, entityId: secondId, constitutiveSetId: 'soft' });
    expect(analysis).toBeDefined();
    const mesh = {
      ...meshOf(bar, doc),
      blocks: [...meshOf(bar, doc).blocks, { type: 'C3D4' as const, entityId: secondId, elements: [[7, 1, 2, 3, 4]] }],
    };
    expect(codeOf(doc, bar.analysisId, mesh)).toBe('NLS_MATERIAL_SET_CONFLICT');

    const elasticOnly = mustRun(bar.doc, 'set_part_constitutive_set', {
      analysisId: bar.analysisId,
      entityId: bar.boxId,
      constitutiveSetId: 'linear',
    });
    expect(codeOf(elasticOnly, bar.analysisId, meshOf(bar, elasticOnly))).toBe('NLS_MATERIAL_SET_CONFLICT');
  });

  it('refuses an arc_length step found in a loaded document', () => {
    const bar = pulledBar();
    const analysis = caseOf(bar.doc, bar.analysisId);
    const nonlinear = analysis?.nonlinear;
    expect(analysis !== undefined && nonlinear !== undefined).toBe(true);
    if (analysis === undefined || nonlinear === undefined) return;
    const stepId = nonlinear.stepOrder[0] ?? '';
    const forced = withCase(bar.doc, {
      ...analysis,
      nonlinear: {
        ...nonlinear,
        steps: {
          [stepId]: {
            id: stepId,
            name: 'riks',
            multipliers: {},
            amplitude: 'ramp',
            control: { kind: 'arc_length', initialArcLength: 1, maxSteps: 5 },
          },
        },
      },
    });
    expect(codeOf(forced, bar.analysisId, meshOf(bar, forced))).toBe('NLS_ARC_LENGTH_UNSUPPORTED');
  });
});
