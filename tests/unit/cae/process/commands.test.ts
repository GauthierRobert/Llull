/** PHY-16 PRC: am_build_setup, set_inherent_strain, add_release_step, create_analysis am_build_distortion, check_analysis items (happy, refusals, purity). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { caseOf } from '@cae/shared/access';
import { amBar, STRAIN, LAYER_HEIGHT, must } from './support';

const refused = (doc: CadDocument, name: string, params: Record<string, unknown>, code: string): void => {
  const before = structuredClone(doc);
  const result = execute(doc, name, params);
  expect(result.rejected, `${name} ${JSON.stringify(params)}: ${result.summary}`).toBe(true);
  expect(result.error?.code).toBe(code);
  expect(result.affected).toEqual([]);
  expect(result.document).toBe(doc);
  expect(doc).toEqual(before);
};

describe('create_analysis am_build_distortion', () => {
  it('creates the case; llull_explicit and opencourant are refused for it', () => {
    const bar = amBar({ setup: false });
    const analysis = caseOf(bar.doc, bar.analysisId);
    expect(analysis?.type).toBe('am_build_distortion');
    expect(analysis?.am).toBeUndefined();
    refused(
      bar.doc,
      'create_analysis',
      { name: 'x', analysisType: 'am_build_distortion', solver: 'opencourant' },
      'PRC_SOLVER_UNSUPPORTED',
    );
  });
});

describe('am_build_setup', () => {
  it('stores direction, plate, layer height and no strain; affected is the analysis; is pure', () => {
    const bar = amBar({ setup: false });
    const before = structuredClone(bar.doc);
    const result = execute(bar.doc, 'am_build_setup', {
      analysisId: bar.analysisId,
      buildDirection: [0, 0, 1],
      plateEntityId: bar.plate,
      layerHeight: LAYER_HEIGHT,
    });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual([bar.analysisId]);
    expect(bar.doc).toEqual(before);
    expect(caseOf(result.document, bar.analysisId)?.am).toEqual({
      buildDirection: [0, 0, 1],
      plateEntityId: bar.plate,
      supportEntityIds: [],
      layerHeight: LAYER_HEIGHT,
      releaseSteps: [],
    });
    expect(result.summary).toContain(`builds ${bar.deposit}`);
    expect(result.summary).toContain('no inherent strain yet');
  });

  it('keeps the strain and the release steps of an earlier set-up when it is run again', () => {
    const bar = amBar({ release: true });
    const again = must(bar.doc, 'am_build_setup', {
      analysisId: bar.analysisId,
      buildDirection: [0, 0, 1],
      plateEntityId: bar.plate,
      layerHeight: 0.25,
    });
    const am = caseOf(again.doc, bar.analysisId)?.am;
    expect(am?.layerHeight).toBe(0.25);
    expect(am?.inherentStrain).toEqual(STRAIN);
    expect(am?.releaseSteps.map((step) => step.name)).toEqual(['cut_plate']);
  });

  it('refuses a case that does not exist, is not an AM case, or has no part to build', () => {
    const bar = amBar({ setup: false });
    const params = { buildDirection: [0, 0, 1], plateEntityId: bar.plate, layerHeight: 0.5 };
    refused(bar.doc, 'am_build_setup', { analysisId: 'nope', ...params }, 'FEA_ANALYSIS_NOT_FOUND');
    const staticBar = amBar({ type: 'static' });
    refused(staticBar.doc, 'am_build_setup', { analysisId: staticBar.analysisId, ...params }, 'PRC_CASE_TYPE');
    refused(
      bar.doc,
      'am_build_setup',
      { analysisId: bar.analysisId, ...params, plateEntityId: bar.deposit, supportEntityIds: [bar.plate] },
      'PRC_BUILD_SETUP_INVALID',
    );
  });

  it.each([
    ['a direction that is not a unit vector', { buildDirection: [0, 0, 2] }],
    ['a zero direction', { buildDirection: [0, 0, 0] }],
    ['a zero layer height', { layerHeight: 0 }],
    ['a negative layer height', { layerHeight: -0.5 }],
    ['a plate that is not a part', { plateEntityId: 'ghost' }],
    ['a support that is not a part', { supportEntityIds: ['ghost'] }],
    ['the plate listed as a support', { supportEntityIds: ['@plate'] }],
  ])('refuses %s with PRC_BUILD_SETUP_INVALID', (_label, patch) => {
    const bar = amBar({ setup: false });
    const params: Record<string, unknown> = {
      analysisId: bar.analysisId,
      buildDirection: [0, 0, 1],
      plateEntityId: bar.plate,
      layerHeight: 0.5,
      ...patch,
    };
    if (Array.isArray(params['supportEntityIds']))
      params['supportEntityIds'] = params['supportEntityIds'].map((id) => (id === '@plate' ? bar.plate : id));
    refused(bar.doc, 'am_build_setup', params, 'PRC_BUILD_SETUP_INVALID');
  });

  it('refuses to drop the supports a kept release step removes', () => {
    const bar = amBar({ setup: false });
    const created = must(bar.doc, 'add_box', { size: [1, 1, 1], position: [10, 0, 0], anchor: 'min' });
    const extra = created.affected[0] ?? '';
    let doc = must(created.doc, 'assign_material', { materialName: 'steel', entityIds: [extra] }).doc;
    doc = must(doc, 'set_part_idealization', { analysisId: bar.analysisId, entityId: extra }).doc;
    const setup = { analysisId: bar.analysisId, buildDirection: [0, 0, 1], plateEntityId: bar.plate, layerHeight: 0.5 };
    doc = must(doc, 'am_build_setup', { ...setup, supportEntityIds: [bar.deposit] }).doc;
    doc = must(doc, 'add_release_step', {
      analysisId: bar.analysisId,
      name: 'strip',
      remove: ['supports'],
      support321: {
        points: [
          [10, 0, 0],
          [11, 0, 0],
          [10, 1, 0],
        ],
      },
    }).doc;
    refused(doc, 'am_build_setup', setup, 'PRC_BUILD_SETUP_INVALID');
  });
});

describe('set_inherent_strain', () => {
  it('stores the strain with its source and calibration flag; an uncalibrated strain is flagged in the summary', () => {
    const bar = amBar({ strain: false });
    const result = execute(bar.doc, 'set_inherent_strain', { analysisId: bar.analysisId, ...STRAIN, calibrated: false });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual([bar.analysisId]);
    expect(caseOf(result.document, bar.analysisId)?.am?.inherentStrain).toEqual({ ...STRAIN, calibrated: false });
    expect(result.summary).toContain('PRC_INHERENT_STRAIN_UNCALIBRATED');
    expect(execute(bar.doc, 'set_inherent_strain', { analysisId: bar.analysisId, ...STRAIN }).summary).not.toContain('UNCALIBRATED');
  });

  it('refuses a blank source, an absurd strain, no set-up, a foreign case', () => {
    const bar = amBar({ strain: false });
    const base = { analysisId: bar.analysisId, ...STRAIN };
    refused(bar.doc, 'set_inherent_strain', { ...base, source: '   ' }, 'PRC_INHERENT_STRAIN_SOURCE_MISSING');
    refused(bar.doc, 'set_inherent_strain', { ...base, exx: -0.5 }, 'PRC_INHERENT_STRAIN_INVALID');
    refused(bar.doc, 'set_inherent_strain', { ...base, ezz: 0.1 }, 'PRC_INHERENT_STRAIN_INVALID');
    refused(
      amBar({ setup: false }).doc,
      'set_inherent_strain',
      { ...base, analysisId: amBar({ setup: false }).analysisId },
      'PRC_BUILD_SETUP_MISSING',
    );
    const staticBar = amBar({ type: 'static' });
    refused(staticBar.doc, 'set_inherent_strain', { ...base, analysisId: staticBar.analysisId }, 'PRC_CASE_TYPE');
    refused(bar.doc, 'set_inherent_strain', { ...base, analysisId: 'nope' }, 'FEA_ANALYSIS_NOT_FOUND');
  });

  it('fails without its fix: the source is required by the schema (a call without it is invalid params, not a stored strain)', () => {
    const bar = amBar({ strain: false });
    const result = execute(bar.doc, 'set_inherent_strain', { analysisId: bar.analysisId, exx: -0.002, eyy: 0, ezz: 0, calibrated: true });
    expect(result.rejected).toBe(true);
    expect(caseOf(result.document, bar.analysisId)?.am?.inherentStrain).toBeUndefined();
    const noFlag = execute(bar.doc, 'set_inherent_strain', { analysisId: bar.analysisId, exx: -0.002, eyy: 0, ezz: 0, source: 'x' });
    expect(noFlag.rejected).toBe(true);
  });
});

describe('add_release_step', () => {
  const points = [
    [2, 0, 0],
    [2, 1, 0],
    [0, 0, 0],
  ];

  it('appends a step with its 3-2-1 points; is pure; the summary names the fixed dofs', () => {
    const bar = amBar();
    const before = structuredClone(bar.doc);
    const result = execute(bar.doc, 'add_release_step', {
      analysisId: bar.analysisId,
      name: 'cut_plate',
      remove: ['plate'],
      support321: { points },
    });
    expect(result.rejected).toBeUndefined();
    expect(result.affected).toEqual([bar.analysisId]);
    expect(bar.doc).toEqual(before);
    expect(caseOf(result.document, bar.analysisId)?.am?.releaseSteps).toEqual([
      { name: 'cut_plate', remove: ['plate'], support321: points },
    ]);
    expect(result.summary).toContain('P1 dof 1,2,3, P2 dof 1,3, P3 dof 3');
  });

  it('refuses collinear / coincident points, a repeated name, a repeated removal, supports that do not exist, a blank name and a missing set-up', () => {
    const bar = amBar({ release: true });
    const base = { analysisId: bar.analysisId, name: 'again', remove: ['plate'], support321: { points } };
    refused(
      amBar().doc,
      'add_release_step',
      {
        ...base,
        analysisId: amBar().analysisId,
        support321: {
          points: [
            [0, 0, 0],
            [1, 0, 0],
            [2, 0, 0],
          ],
        },
      },
      'PRC_RELEASE_UNSUPPORTED',
    );
    refused(
      amBar().doc,
      'add_release_step',
      {
        ...base,
        analysisId: amBar().analysisId,
        support321: {
          points: [
            [0, 0, 0],
            [0, 0, 0],
            [2, 1, 0],
          ],
        },
      },
      'PRC_RELEASE_UNSUPPORTED',
    );
    refused(bar.doc, 'add_release_step', { ...base, name: 'cut_plate', remove: ['supports'] }, 'PRC_RELEASE_INVALID');
    refused(bar.doc, 'add_release_step', base, 'PRC_RELEASE_INVALID');
    refused(amBar().doc, 'add_release_step', { ...base, analysisId: amBar().analysisId, remove: ['supports'] }, 'PRC_RELEASE_INVALID');
    refused(
      amBar().doc,
      'add_release_step',
      { ...base, analysisId: amBar().analysisId, remove: ['plate', 'plate'] },
      'PRC_RELEASE_INVALID',
    );
    refused(amBar().doc, 'add_release_step', { ...base, analysisId: amBar().analysisId, name: '  ' }, 'PRC_RELEASE_INVALID');
    refused(
      amBar({ setup: false }).doc,
      'add_release_step',
      { ...base, analysisId: amBar({ setup: false }).analysisId },
      'PRC_BUILD_SETUP_MISSING',
    );
    const staticBar = amBar({ type: 'static' });
    refused(staticBar.doc, 'add_release_step', { ...base, analysisId: staticBar.analysisId }, 'PRC_CASE_TYPE');
  });
});

describe('check_analysis of an AM case', () => {
  const items = (doc: CadDocument, analysisId: string): string[] => {
    const result = execute(doc, 'check_analysis', { analysisId });
    const data = result.data as { items?: { code: string }[] } | undefined;
    return (data?.items ?? []).map((entry) => entry.code);
  };

  it('reports the missing set-up, the missing strain, the uncalibrated warning and loads; passes the AM items when calibrated', () => {
    expect(items(amBar({ setup: false }).doc, amBar({ setup: false }).analysisId)).toContain('PRC_BUILD_SETUP_MISSING');
    const noStrain = amBar({ strain: false });
    expect(items(noStrain.doc, noStrain.analysisId)).toContain('PRC_INHERENT_STRAIN_MISSING');
    const guessed = must(noStrain.doc, 'set_inherent_strain', { analysisId: noStrain.analysisId, ...STRAIN, calibrated: false });
    expect(items(guessed.doc, noStrain.analysisId)).toContain('PRC_INHERENT_STRAIN_UNCALIBRATED');
    const good = amBar();
    expect(items(good.doc, good.analysisId).filter((code) => code.startsWith('PRC_'))).toEqual([]);
    const loaded = must(good.doc, 'add_fea_load', {
      analysisId: good.analysisId,
      name: 'g',
      kind: 'gravity',
      loadCase: 'LC1',
      category: 'limit',
      vector: [0, 0, -9810],
    });
    expect(items(loaded.doc, good.analysisId)).toContain('PRC_LOADS_UNSUPPORTED');
  });
});

describe('am inputs are part of the analysis input hash (recorded results go stale when the build changes)', () => {
  it('changes with the strain, the layer height and a release step and not with a repeated identical call', () => {
    const bar = amBar();
    const hash = (doc: CadDocument): string => analysisInputHash(doc, bar.analysisId, 'full');
    const base = hash(bar.doc);
    const strain = must(bar.doc, 'set_inherent_strain', { analysisId: bar.analysisId, ...STRAIN, exx: -0.003 }).doc;
    const same = must(bar.doc, 'set_inherent_strain', { analysisId: bar.analysisId, ...STRAIN }).doc;
    const layer = must(bar.doc, 'am_build_setup', {
      analysisId: bar.analysisId,
      buildDirection: [0, 0, 1],
      plateEntityId: bar.plate,
      layerHeight: 0.25,
    }).doc;
    expect(hash(strain)).not.toBe(base);
    expect(hash(layer)).not.toBe(base);
    expect(hash(amBar({ release: true }).doc)).not.toBe(base);
    expect(hash(same)).toBe(base);
  });
});
