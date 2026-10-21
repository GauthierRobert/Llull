/**
 * 12 CFD M1: create_cfd_case, update_cfd_case, delete_cfd_case, set_cfd_boundary (TECHNICAL_SPEC §4) — VC-CFD-16 boundary tags survive replay
 * and a forced LBM solver at Mach 0.5 is refused with CFD_REGIME_MISMATCH.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CfdCase } from '@aero/cfd/types';
import type { CadDocument } from '@core/model/types';
import { expectPure } from '../../../helpers/expectNoOp';
import { expectRefusal } from '../../../helpers/commandAssertions';
import { addBody, caseParams, metreDocument, ok, withCase } from './fixtures';

const body = addBody(metreDocument(), 'add_box', { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' });
const cap = addBody(body.doc, 'add_cylinder', { radius: 0.2, height: 0.1, position: [3, 0, 0] });
const base = cap.doc;
const caseOfDoc = (doc: CadDocument, id = 'c1'): CfdCase => doc.cfd?.cases[id] as CfdCase;

describe('create_cfd_case', () => {
  it('creates a case with named defaults, the centre of the bodies as moment point and the case id in affected', () => {
    const result = ok(base, 'create_cfd_case', caseParams([body.id], { freestream: { mach: 2, altitudeM: 20000, alphaDeg: 2 } }));
    expect(result.affected).toEqual(['c1']);
    const created = caseOfDoc(result.document);
    expect(created).toMatchObject({
      id: 'c1',
      entityIds: [body.id],
      regime: 'auto',
      flowAxis: [1, 0, 0],
      upAxis: [0, 0, 1],
      quality: 'standard',
      domain: { rule: 'external_aero' },
      ground: { enabled: false, moving: false },
      freestream: { mach: 2, altitudeM: 20000, alphaDeg: 2, betaDeg: 0 },
      reference: { areaM2: 1, lengthM: 1, momentPointM: [0.5, 0.5, 0.5] },
      outputs: { surfaceFields: [], slices: [], probes: [] },
    });
    const data = result.data as { defaults: Array<{ path: string }>; solver: string; machNumber: number; caseHash: string };
    expect(data.solver).toBe('euler');
    expect(data.machNumber).toBe(2);
    expect(data.caseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.defaults.map((entry) => entry.path)).toEqual(expect.arrayContaining(['regime', 'upAxis', 'domain.rule', 'quality']));
    expect(result.document.order).toEqual(base.order);
    expect(result.summary).toContain('solver euler');
  });

  it('keeps what is given and converts nothing: explicit moment point, Mach from speed, air state', () => {
    const result = ok(
      base,
      'create_cfd_case',
      caseParams([body.id], {
        freestream: { speedMS: 100, air: { densityKgM3: 1.2, temperatureK: 300, viscosityPaS: 1.8e-5 }, alphaDeg: 1, betaDeg: -1 },
        reference: { areaM2: 2, lengthM: 3, momentPointM: [1, 2, 3] },
        domain: { rule: 'buildings', symmetryPlane: 'xz' },
        ground: { enabled: true, moving: true },
        quality: 'fine',
        solver: 'lbm',
        outputs: { surfaceFields: ['cp'], slices: [{ origin: [0, 0, 0], normal: [0, 1, 0], field: 'mach' }], probes: [[1, 1, 1]] },
        excludedEntityIds: [cap.id],
        flowAxis: [0, 1, 0],
        upAxis: [0, 0, 1],
        regime: 'low_speed',
        cellsPerReferenceLength: 200,
      }),
    );
    const created = caseOfDoc(result.document);
    expect(created.reference.momentPointM).toEqual([1, 2, 3]);
    expect(created).toMatchObject({
      solver: 'lbm',
      cellsPerReferenceLength: 200,
      ground: { enabled: true, moving: true },
      regime: 'low_speed',
    });
    expect(created.domain).toEqual({ rule: 'buildings', symmetryPlane: 'xz' });
    expect(created.outputs.slices).toHaveLength(1);
    expect(created.freestream.air?.temperatureK).toBe(300);
  });

  it('is pure', () => {
    expectPure(base, () => execute(base, 'create_cfd_case', caseParams([body.id])));
  });

  it('refuses a duplicate id, a bad id and unknown entities', () => {
    const doc = withCase(base, [body.id]);
    expectRefusal(doc, 'create_cfd_case', caseParams([body.id]), 'CFD_CASE_EXISTS', 'id');
    expectRefusal(base, 'create_cfd_case', caseParams([body.id], { id: 'bad id!' }), 'CFD_PARAM_INVALID', 'id');
    expectRefusal(base, 'create_cfd_case', caseParams(['ghost']), 'CFD_ENTITY_NOT_FOUND', 'entityIds');
    expectRefusal(base, 'create_cfd_case', caseParams([body.id], { excludedEntityIds: ['ghost'] }), 'CFD_ENTITY_NOT_FOUND');
  });

  it('refuses invalid numbers and combinations with CFD_PARAM_INVALID', () => {
    const bad = (overrides: Record<string, unknown>, path: string): void => {
      expectRefusal(base, 'create_cfd_case', caseParams([body.id], overrides), 'CFD_PARAM_INVALID', path);
    };
    bad({ freestream: { mach: 0.5, speedMS: 10 } }, 'freestream');
    bad({ freestream: {} }, 'freestream');
    bad({ freestream: { speedMS: -5 } }, 'freestream');
    bad({ freestream: { speedMS: 5, altitudeM: 0, air: { densityKgM3: 1, temperatureK: 300, viscosityPaS: 1e-5 } } }, 'freestream');
    bad({ freestream: { speedMS: 5, air: { densityKgM3: -1, temperatureK: 300, viscosityPaS: 1e-5 } } }, 'freestream');
    bad({ freestream: { speedMS: 5, altitudeM: 200000 } }, 'freestream');
    bad({ freestream: { speedMS: 5, alphaDeg: 95 } }, 'freestream');
    bad({ reference: { areaM2: 0, lengthM: 1 } }, 'reference');
    bad({ flowAxis: [0, 0, 0] }, 'flowAxis');
    bad({ flowAxis: [1, 0, 0], upAxis: [2, 0, 0] }, 'flowAxis');
    bad({ cellsPerReferenceLength: 3 }, 'cellsPerReferenceLength');
    bad({ cellsPerReferenceLength: 5000 }, 'cellsPerReferenceLength');
    bad({ domain: { rule: 'custom' } }, 'domain.box');
    bad({ domain: { rule: 'custom', box: { min: [0, 0, 0], max: [0, 1, 1] } } }, 'domain.box');
    bad({ domain: { rule: 'buildings', box: { min: [0, 0, 0], max: [1, 1, 1] } } }, 'domain.box');
    bad({ outputs: { slices: [{ origin: [0, 0, 0], normal: [0, 0, 0], field: 'p' }] } }, 'outputs');
    bad({ entityIds: [] }, 'entityIds');
  });

  it('refuses a regime or solver outside its Mach range with CFD_REGIME_MISMATCH', () => {
    const mismatch = (overrides: Record<string, unknown>): void => {
      expectRefusal(base, 'create_cfd_case', caseParams([body.id], overrides), 'CFD_REGIME_MISMATCH', 'regime');
    };
    mismatch({ freestream: { mach: 0.5 }, solver: 'lbm' });
    mismatch({ freestream: { mach: 0.1 }, solver: 'euler' });
    mismatch({ freestream: { mach: 0.1 }, regime: 'compressible' });
    mismatch({ freestream: { mach: 2 }, regime: 'low_speed' });
    mismatch({ freestream: { mach: 6 } });
    expect(ok(base, 'create_cfd_case', caseParams([body.id], { freestream: { mach: 0.3 }, solver: 'euler' })).affected).toEqual(['c1']);
  });
});

describe('update_cfd_case', () => {
  const doc = withCase(base, [body.id]);

  it('changes only the given members and keeps the case order', () => {
    const second = ok(doc, 'create_cfd_case', caseParams([body.id], { id: 'c2' })).document;
    const result = ok(second, 'update_cfd_case', {
      caseId: 'c1',
      quality: 'draft',
      reference: { areaM2: 4 },
      ground: { moving: true },
      domain: { symmetryPlane: 'xz' },
      outputs: { probes: [[0, 0, 0]] },
      freestream: { speedMS: 20, alphaDeg: 3 },
    });
    const next = caseOfDoc(result.document);
    expect(next.quality).toBe('draft');
    expect(next.reference).toEqual({ areaM2: 4, lengthM: 1, momentPointM: [0.5, 0.5, 0.5] });
    expect(next.ground).toEqual({ enabled: false, moving: true });
    expect(next.domain).toEqual({ rule: 'external_aero', symmetryPlane: 'xz' });
    expect(next.outputs.probes).toEqual([[0, 0, 0]]);
    expect(next.freestream).toEqual({ speedMS: 20, alphaDeg: 3, betaDeg: 0 });
    expect(Object.keys(result.document.cfd?.cases ?? {})).toEqual(['c1', 'c2']);
    expect(result.affected).toEqual(['c1']);
    expect((result.data as { changed: string[] }).changed).toEqual(expect.arrayContaining(['quality', 'reference']));
  });

  it('drops a custom box when the rule moves away from custom, and flags a recorded result stale', () => {
    const custom = ok(doc, 'update_cfd_case', {
      caseId: 'c1',
      domain: { rule: 'custom', box: { min: [-1, -1, -1], max: [3, 3, 3] } },
    }).document;
    const back = ok(custom, 'update_cfd_case', { caseId: 'c1', domain: { rule: 'buildings' } }).document;
    expect(caseOfDoc(back).domain).toEqual({ rule: 'buildings' });
    const kept = ok(custom, 'update_cfd_case', { caseId: 'c1', domain: { symmetryPlane: null } }).document;
    expect(caseOfDoc(kept).domain).toEqual({ rule: 'custom', box: { min: [-1, -1, -1], max: [3, 3, 3] }, symmetryPlane: null });
    const recorded: CadDocument = {
      ...doc,
      cfd: {
        cases: doc.cfd?.cases ?? {},
        results: { c1: { caseId: 'c1', caseHash: 'old', geometryHash: 'g', resultsHash: 'r', solver: 'lbm' } as never },
      },
    };
    const stale = ok(recorded, 'update_cfd_case', { caseId: 'c1', quality: 'fine' });
    expect((stale.data as { resultStale: boolean }).resultStale).toBe(true);
    expect(stale.summary).toContain('stale');
    expect(stale.document.cfd?.results['c1']).toBeDefined();
  });

  it('replaces the boundary list and validates it', () => {
    const tagged = ok(doc, 'update_cfd_case', { caseId: 'c1', boundaries: [{ kind: 'wall', entityId: body.id }] }).document;
    expect(caseOfDoc(tagged).boundaries).toEqual([{ kind: 'wall', entityId: body.id }]);
    expect(caseOfDoc(ok(tagged, 'update_cfd_case', { caseId: 'c1', boundaries: [] }).document).boundaries).toEqual([]);
    expectRefusal(
      doc,
      'update_cfd_case',
      {
        caseId: 'c1',
        boundaries: [
          { kind: 'inlet', entityId: body.id },
          { kind: 'outlet', entityId: body.id },
        ],
      },
      'CFD_BOUNDARY_CONFLICT',
      'boundaries',
    );
    expectRefusal(doc, 'update_cfd_case', { caseId: 'c1', boundaries: [{ kind: 'wall', entityId: 'ghost' }] }, 'CFD_ENTITY_NOT_FOUND');
    expectRefusal(
      doc,
      'update_cfd_case',
      { caseId: 'c1', boundaries: [{ kind: 'wall', entityId: cap.id }] },
      'CFD_ENTITY_NOT_FOUND',
      'boundaries',
    );
  });

  it('is pure and refuses an unknown case, an empty change and invalid values', () => {
    expectPure(doc, () => execute(doc, 'update_cfd_case', { caseId: 'c1', quality: 'fine' }));
    expectRefusal(doc, 'update_cfd_case', { caseId: 'nope', quality: 'fine' }, 'CFD_CASE_NOT_FOUND', 'caseId');
    expectRefusal(doc, 'update_cfd_case', { caseId: 'c1' }, 'CFD_PARAM_INVALID', 'caseId');
    expectRefusal(doc, 'update_cfd_case', { caseId: 'c1', freestream: { mach: 0.5 }, solver: 'lbm' }, 'CFD_REGIME_MISMATCH');
    expectRefusal(doc, 'update_cfd_case', { caseId: 'c1', entityIds: ['ghost'] }, 'CFD_ENTITY_NOT_FOUND');
  });
});

describe('delete_cfd_case', () => {
  it('removes the case and its result, keeps the bodies', () => {
    const doc = withCase(base, [body.id]);
    const withResult: CadDocument = { ...doc, cfd: { cases: doc.cfd?.cases ?? {}, results: { c1: { caseId: 'c1' } as never } } };
    const result = ok(withResult, 'delete_cfd_case', { caseId: 'c1' });
    expect(result.affected).toEqual(['c1']);
    expect(result.document.cfd).toEqual({ cases: {}, results: {} });
    expect(result.document.entities).toBe(withResult.entities);
    expectPure(withResult, () => execute(withResult, 'delete_cfd_case', { caseId: 'c1' }));
  });

  it('refuses an unknown case', () => {
    expectRefusal(base, 'delete_cfd_case', { caseId: 'nope' }, 'CFD_CASE_NOT_FOUND', 'caseId');
  });
});

describe('set_cfd_boundary / VC-CFD-16', () => {
  const doc = withCase(base, [body.id, cap.id], { freestream: { speedMS: 5 } });

  it('tags an end-cap entity as inlet and merges the same kind again', () => {
    const inlet = ok(doc, 'set_cfd_boundary', { caseId: 'c1', kind: 'inlet', entityId: cap.id });
    expect(caseOfDoc(inlet.document).boundaries).toEqual([{ kind: 'inlet', entityId: cap.id }]);
    expect(inlet.affected).toEqual(['c1']);
    const faces = ok(inlet.document, 'set_cfd_boundary', { caseId: 'c1', kind: 'wall', entityId: body.id, faceRefs: ['f1'] }).document;
    const more = ok(faces, 'set_cfd_boundary', { caseId: 'c1', kind: 'wall', entityId: body.id, faceRefs: ['f2', 'f1'] }).document;
    expect(caseOfDoc(more).boundaries[1]).toEqual({ kind: 'wall', entityId: body.id, faceRefs: ['f1', 'f2'] });
    const otherFace = ok(more, 'set_cfd_boundary', { caseId: 'c1', kind: 'outlet', entityId: body.id, faceRefs: ['f3'] }).document;
    expect(caseOfDoc(otherFace).boundaries).toHaveLength(3);
    const again = ok(inlet.document, 'set_cfd_boundary', { caseId: 'c1', kind: 'inlet', entityId: cap.id });
    expect(caseOfDoc(again.document).boundaries).toHaveLength(1);
  });

  it('tags survive a build_project replay identically', () => {
    const plan = [
      { command: 'set_units', params: { units: 'm' } },
      { command: 'add_cylinder', params: { radius: 0.2, height: 0.1, position: [3, 0, 0] }, as: 'cap' },
      { command: 'add_box', params: { size: [1, 1, 1], position: [0, 0, 0], anchor: 'min' }, as: 'body' },
      { command: 'create_cfd_case', params: caseParams(['$body', '$cap']) },
      { command: 'set_cfd_boundary', params: { caseId: 'c1', kind: 'inlet', entityId: '$cap' } },
      { command: 'set_cfd_boundary', params: { caseId: 'c1', kind: 'wall', entityId: '$body', faceRefs: ['top'] } },
    ];
    const first = execute(metreDocument(), 'build_project', { actions: plan });
    const second = execute(metreDocument(), 'build_project', { actions: plan });
    expect((first.data as { ok: boolean }).ok).toBe(true);
    expect(caseOfDoc(first.document).boundaries).toHaveLength(2);
    expect(caseOfDoc(second.document).boundaries).toEqual(caseOfDoc(first.document).boundaries);
    const saved = JSON.parse(JSON.stringify(first.document)) as CadDocument;
    expect(caseOfDoc(saved).boundaries).toEqual(caseOfDoc(first.document).boundaries);
  });

  it('a forced lbm solver at Mach 0.5 is CFD_REGIME_MISMATCH', () => {
    expectRefusal(base, 'create_cfd_case', caseParams([body.id], { freestream: { mach: 0.5 }, solver: 'lbm' }), 'CFD_REGIME_MISMATCH');
  });

  it('refuses a different kind on a tagged entity, a foreign entity, an unknown case and bad face refs', () => {
    const tagged = ok(doc, 'set_cfd_boundary', { caseId: 'c1', kind: 'inlet', entityId: cap.id }).document;
    expectRefusal(tagged, 'set_cfd_boundary', { caseId: 'c1', kind: 'outlet', entityId: cap.id }, 'CFD_BOUNDARY_CONFLICT', 'kind');
    expectRefusal(
      tagged,
      'set_cfd_boundary',
      { caseId: 'c1', kind: 'outlet', entityId: cap.id, faceRefs: ['f1'] },
      'CFD_BOUNDARY_CONFLICT',
    );
    expectRefusal(doc, 'set_cfd_boundary', { caseId: 'c1', kind: 'wall', entityId: 'ghost' }, 'CFD_ENTITY_NOT_FOUND', 'entityId');
    const single = withCase(base, [body.id]);
    expectRefusal(single, 'set_cfd_boundary', { caseId: 'c1', kind: 'wall', entityId: cap.id }, 'CFD_ENTITY_NOT_FOUND', 'entityId');
    expectRefusal(doc, 'set_cfd_boundary', { caseId: 'nope', kind: 'wall', entityId: cap.id }, 'CFD_CASE_NOT_FOUND', 'caseId');
    expectRefusal(doc, 'set_cfd_boundary', { caseId: 'c1', kind: 'wall', entityId: cap.id, faceRefs: [] }, 'CFD_PARAM_INVALID', 'faceRefs');
    expectPure(doc, () => execute(doc, 'set_cfd_boundary', { caseId: 'c1', kind: 'wall', entityId: cap.id }));
  });
});
