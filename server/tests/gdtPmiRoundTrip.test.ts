/**
 * 03 GDT M6 round trip on the real native kernel (VC-GDT-21, 25): the validation plate is toleranced with the pmi commands, written to AP242 with
 * `export_step_ap242 { includePmi }` (census of the Part 21 text), read back with `import_step_exact` and the semantic PMI is compared
 * item by item with what was authored (ids, placements and review state aside). Accepting the imported items stays a signed human act.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { PmiItem } from '@core/model/pmi';
import { summarizeStep21 } from '@lib/step21/summary';
import { describeNative, liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
const PLAN = path.resolve(__dirname, '../../docs/aerospace/03-gdt-mbd-pmi/validation/draft_plan_gdt_plate.json');
const ctx = (): ExecutionContext => ({ ...defaultContext(), kernel: kernels.occt });
const run = (doc: CadDocument, name: string, params: Record<string, unknown> = {}): CommandResult => execute(doc, name, params, ctx());

/** The plate plan up to check_pmi (the sheet and the export are driven by the test). */
function toleranced(): CadDocument {
  const steps = (JSON.parse(readFileSync(PLAN, 'utf8')) as { command: string }[]).slice(0, 25);
  const result = execute(createEmptyDocument(), 'build_project', { actions: steps }, ctx());
  const data = result.data as { ok: boolean; steps: { ok: boolean; command: string; summary: string }[] };
  expect(data.steps.filter((step) => !step.ok).map((step) => `${step.command}: ${step.summary}`)).toEqual([]);
  return result.document;
}

const items = (doc: CadDocument): PmiItem[] => (doc.pmi?.order ?? []).map((id) => doc.pmi!.items[id]!);
const round = (value: number): number => Number(value.toPrecision(9));

/** What the transport carries of an item (the semantic content; the rest is listed as lossy). */
function carried(item: PmiItem): unknown {
  switch (item.kind) {
    case 'datum_feature':
      return { kind: item.kind, label: item.label, surface: item.feature.surface };
    case 'geometric_tolerance':
      return {
        kind: item.kind,
        characteristic: item.characteristic,
        value: round(item.zone.value),
        diametral: item.zone.diametral === true,
        spherical: item.zone.spherical === true,
        materialCondition: item.materialCondition,
        modifiers: [...item.modifiers].sort(),
        datums: item.datums.map((datum) => `${datum.label}${datum.boundary ?? ''}`),
      };
    case 'size_dimension': {
      const measured = item.feature.ofSize?.measured ?? 0;
      const tolerance = item.tolerance;
      const [lower, upper] =
        tolerance.type === 'limits'
          ? [tolerance.lower - (item.sizeKind === 'radius' ? measured / 2 : measured), tolerance.upper - measured]
          : tolerance.type === 'basic'
            ? [0, 0]
            : [tolerance.lower, tolerance.upper];
      return {
        kind: item.kind,
        sizeKind: item.sizeKind,
        measured: round(measured),
        lower: round(lower),
        upper: round(upper),
        count: item.count,
        fit: tolerance.type === 'fit' ? tolerance.code : null,
        sizeModifiers: [...(item.sizeModifiers ?? [])].filter((code) => code !== 'E').sort(),
      };
    }
    default:
      return { kind: item.kind };
  }
}

const canonical = (values: unknown[]): string[] => values.map((value) => JSON.stringify(value)).sort();

describeNative('AP242 PMI round trip on the native kernel (VC-GDT-21, 25)', () => {
  it('writes the authored PMI by face, reads it back as the same semantic PMI, review-required, and keeps acceptance human-only', () => {
    const doc = toleranced();
    const authored = items(doc);
    const part = authored[0]?.kind === 'datum_feature' ? authored[0].feature.entityId : '';
    expect(part).not.toBe('');
    const exported = run(doc, 'export_step_ap242', { entityIds: [part], includePmi: true, timestamp: '2026-10-20T00:00:00' });
    expect(exported.rejected, exported.summary).toBeUndefined();
    const data = exported.data as {
      step: string;
      reviewRequired: { value: boolean; reasons: string[] };
      pmi: { requested: number; written: string[]; skipped: { id: string; reason: string }[]; lossy: { id: string; lost: string[] }[] };
    };
    // 3 datums + 2 size dimensions + 4 frames written; the surface texture has no semantic form and is listed
    expect(data.pmi.written).toHaveLength(9);
    expect(data.pmi.skipped.map((entry) => entry.reason)).toEqual(['a surface texture has no semantic AP242 transport form']);
    expect(data.pmi.lossy).toEqual([]);
    expect(data.reviewRequired).toEqual({ value: true, reasons: ['pmi_review_required'] });
    const census = summarizeStep21(data.step).entityCensus;
    expect(census['FLATNESS_TOLERANCE']).toBe(1);
    expect(census['PERPENDICULARITY_TOLERANCE']).toBe(1);
    expect(census['POSITION_TOLERANCE']).toBe(2);
    expect(census['DATUM']).toBeGreaterThanOrEqual(3);
    expect(census['DIMENSIONAL_SIZE']).toBeGreaterThanOrEqual(2);

    const back = run(createEmptyDocument(), 'import_step_exact', { text: data.step, fileName: 'plate-roundtrip.stp' });
    expect(back.rejected, back.summary).toBeUndefined();
    const imported = items(back.document);
    const wanted = authored.filter((item) => item.kind !== 'surface_texture');
    expect(canonical(imported.map(carried))).toEqual(canonical(wanted.map(carried)));
    expect(back.document.pmi?.import).toMatchObject({ source: 'plate-roundtrip.stp', items: 9, unresolved: 0, unmapped: 0 });
    expect(imported.every((item) => item.review.required && item.review.reason?.includes('imported from plate-roundtrip.stp'))).toBe(true);
    expect((back.data as { report: { pmi: { items: number }; reviewRequired: { reasons: string[] } } }).report.pmi.items).toBe(9);
    expect((back.data as { report: { reviewRequired: { reasons: string[] } } }).report.reviewRequired.reasons).toContain(
      'pmi_review_required',
    );
    expect(back.summary).toContain('PMI: 9 semantic item(s) attached (review required)');
    // the imported items resolve on the imported solid: faces found, no unverified flag
    expect(imported.filter((item) => item.unverified !== undefined)).toEqual([]);
    // the position frames follow their holes: the imported model passes the same checks
    const checked = run(back.document, 'check_pmi', {});
    expect((checked.data as { errors?: unknown[] }).errors ?? []).toEqual([]);

    // an agent cannot clear the review of imported PMI: accept_pmi_review needs a verified human signature
    const accept = run(back.document, 'accept_pmi_review', {
      pmiIds: [imported[0]!.id],
      decision: 'accept',
      comment: 'ok',
      at: '2026-10-20T00:00:00Z',
    });
    expect(accept.error?.code).toBe('GDT_REVIEW_HUMAN_ONLY');
    expect(accept.document).toBe(back.document);
  }, 300_000);

  it('round-trips MMC / LMC, a spherical-free zone, modifiers, the MMB boundary, size modifiers and a fit class; reports what the writer refuses', () => {
    let doc = toleranced();
    const part = items(doc)[0]!.kind === 'datum_feature' ? (items(doc)[0] as { feature: { entityId: string } }).feature.entityId : '';
    const exec = (name: string, params: Record<string, unknown>): string[] => {
      const result = run(doc, name, params);
      expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
      doc = result.document;
      return result.affected;
    };
    const ids = Object.fromEntries(
      items(doc).map((item) => [item.kind === 'geometric_tolerance' ? `${item.characteristic}:${item.datums.length}` : item.id, item.id]),
    );
    const holeFrame = ids['position:3'] as string;
    // datum B is MMB on every frame that references it, so the one boundary a transport datum carries is exact
    for (const item of items(doc))
      if (item.kind === 'geometric_tolerance' && item.datums.some((datum) => datum.label === 'B'))
        exec('update_pmi', {
          pmiId: item.id,
          datums: item.datums.map((datum) => ({ label: datum.label, ...(datum.label === 'B' ? { boundary: 'MMB' } : {}) })),
        });
    exec('update_pmi', { pmiId: holeFrame, modifiers: ['tangent_plane', 'statistical'] });
    const [bore] = exec('add_size_dimension', {
      entityId: part,
      facesNear: [[50, 40, 6]],
      sizeKind: 'diameter',
      tolerance: { type: 'fit', code: 'H7', upper: 0.021, lower: 0 },
      sizeModifiers: ['LP', 'SX', 'E'],
    });
    exec('add_geometric_tolerance', {
      characteristic: 'position',
      targetPmiId: bore,
      zone: { value: 0.05, diametral: true },
      materialCondition: 'LMC',
      modifiers: ['free_state'],
      datums: [{ label: 'A' }, { label: 'B', boundary: 'MMB' }],
    });
    exec('add_geometric_tolerance', {
      characteristic: 'profile_surface',
      entityId: part,
      facesNear: [[30, 10, 0]],
      zone: { value: 0.2, projectedLength: 5, maxValue: 0.3 },
      modifiers: ['all_around', 'not_convex'],
    });
    const authored = items(doc);
    const exported = run(doc, 'export_step_ap242', { entityIds: [part], includePmi: true, timestamp: '2026-10-20T00:00:00' });
    expect(exported.rejected, exported.summary).toBeUndefined();
    const data = exported.data as { step: string; pmi: { written: string[]; skipped: { reason: string }[]; lossy: { lost: string[] }[] } };
    const lost = data.pmi.lossy.flatMap((entry) => entry.lost).map((entry) => entry.split(' (')[0]);
    expect(lost.sort()).toEqual(['modifiers.all_around', 'sizeModifiers.E', 'zone.maxValue', 'zone.projectedLength']);
    expect(data.pmi.written).toHaveLength(authored.length - 1);

    const back = run(createEmptyDocument(), 'import_step_exact', { text: data.step, fileName: 'plate-v2.stp' });
    expect(back.rejected, back.summary).toBeUndefined();
    const withoutLost = (item: PmiItem): unknown => {
      const view = carried(item) as Record<string, unknown>;
      if (item.kind === 'geometric_tolerance')
        return { ...view, modifiers: (view['modifiers'] as string[]).filter((m) => m !== 'all_around') };
      return view;
    };
    const wanted = authored.filter((item) => item.kind !== 'surface_texture');
    expect(canonical(items(back.document).map(carried))).toEqual(canonical(wanted.map(withoutLost)));
    const frames = items(back.document).filter((item) => item.kind === 'geometric_tolerance');
    expect(frames.some((f) => f.kind === 'geometric_tolerance' && f.materialCondition === 'MMC')).toBe(true);
    expect(
      frames.some((f) => f.kind === 'geometric_tolerance' && f.materialCondition === 'LMC' && f.modifiers.includes('free_state')),
    ).toBe(true);
    expect(frames.some((f) => f.kind === 'geometric_tolerance' && f.datums.some((d) => d.label === 'B' && d.boundary === 'MMB'))).toBe(
      true,
    );
    expect(
      items(back.document).some((item) => item.kind === 'size_dimension' && item.tolerance.type === 'fit' && item.tolerance.code === 'H7'),
    ).toBe(true);
  }, 300_000);

  it('a file without PMI imports with no pmi model, and includePmi on a document without PMI writes none', () => {
    const plain = run(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const exported = run(plain.document, 'export_step_ap242', { includePmi: true, timestamp: '2026-10-20T00:00:00' });
    const data = exported.data as { step: string; pmi: { requested: number }; reviewRequired: { value: boolean } };
    expect(data.pmi.requested).toBe(0);
    expect(data.reviewRequired.value).toBe(false);
    const back = run(createEmptyDocument(), 'import_step_exact', { text: data.step });
    expect(back.document.pmi).toBeUndefined();
  }, 120_000);
});
