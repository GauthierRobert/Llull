/**
 * Live OpenCascade: import_step_exact (aerospace 01 M4 MVP, TR-KRN-20..24). STEP files come from the kernel's own exporter (box 100x50x20, cylinder)
 * and from the committed 07-pack parts with analytic volumes; the blob keeps the exact shape across save, load and replay.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type Entity, type MeshSolidEntity, type Vec3 } from '@core/model/types';
import { EXIT_OK, runCli } from '../src/cli/main';
import { liveKernels, createNativeTestKernel, describeNative } from './kernelTestSupport';

const kernels = liveKernels();
afterAll(() => setGeometryKernel(null));

const PACK = path.resolve(__dirname, '../../docs/aerospace/07-sheet-metal-machined-features/validation/data');
const ctxOf = (kernel: GeometryKernel): ExecutionContext => ({ ...defaultContext(), kernel });
const base = { layerId: 'layer-default', color: '#888888', position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 };
const box: Entity = { id: 'box', kind: 'box', size: [100, 50, 20], ...base } as Entity;
const cylinder: Entity = { id: 'cyl', kind: 'cylinder', radius: 10, height: 40, ...base } as Entity;
const BOX_VOLUME = 100 * 50 * 20;
const CYLINDER_VOLUME = Math.PI * 10 * 10 * 40;

interface Report {
  census: { roots: number; solids: number; shells: number; openShells: number; faces: number };
  solids: Array<{
    id: string;
    blob: string;
    validAsRead: boolean;
    validAfterHeal: boolean;
    freeEdges: number;
    faces: number;
    faceted: boolean;
    maxToleranceMm: number;
  }>;
  warnings: unknown[];
}
const reportOf = (result: CommandResult): Report => (result.data as { report: Report }).report;

function stepOf(kernel: GeometryKernel, ...entities: Entity[]): string {
  const handles = entities.map((entity) => kernel.evaluate({ op: 'solid', entity }));
  expect(handles.every((handle) => handle !== null)).toBe(true);
  const step = kernel.exportStep(handles as never);
  expect(step).toContain('ISO-10303-21');
  return step ?? '';
}

/** Exact volume of the entity's recipe on `kernel` (document in mm). */
function volumeOf(kernel: GeometryKernel, doc: CadDocument, id: string): number {
  const shape = kernel.evaluate(recipeOf(doc.entities[id] as Entity));
  expect(shape).not.toBeNull();
  return kernel.topology(shape!)?.volume ?? Number.NaN;
}

const importStep = (
  kernel: GeometryKernel,
  text: string,
  params: Record<string, unknown> = {},
  doc = createEmptyDocument(),
): CommandResult => execute(doc, 'import_step_exact', { text, ...params }, ctxOf(kernel));

describeNative('import_step_exact on the live OCC kernel', () => {
  it('describes itself (kernel_info) with the importShapes and brepBlobs ports', () => {
    const info = execute(createEmptyDocument(), 'kernel_info', {}, ctxOf(kernels.occt)).data as {
      active: string;
      occtVersion: string;
      build: string;
      capabilities: string[];
    };
    expect(info).toMatchObject({ active: 'occt', occtVersion: '7.9.2', build: expect.stringContaining('llull-kernel@') });
    expect(info.capabilities).toEqual(expect.arrayContaining(['importShapes', 'brepBlobs', 'topology']));
  });

  it('imports an exported box and cylinder with exact volumes and a clean report', () => {
    const result = importStep(kernels.occt, stepOf(kernels.occt, box, cylinder), { fileName: 'pair.step' });
    expect(result.error).toBeUndefined();
    expect(result.affected).toHaveLength(2);
    const report = reportOf(result);
    expect(report.census).toMatchObject({ solids: 2 });
    // a plain OCC export carries no validation properties: each part is reported as not checkable (04 XCH), nothing else
    expect((report.warnings as { code: string }[]).map((warning) => warning.code)).toEqual([
      'XCH_GVP_NOT_CHECKABLE',
      'XCH_GVP_NOT_CHECKABLE',
    ]);
    for (const solid of report.solids) {
      expect(solid).toMatchObject({ validAsRead: true, validAfterHeal: true, freeEdges: 0, faceted: false });
      expect(solid.maxToleranceMm).toBeLessThan(1e-3);
    }
    const volumes = result.affected.map((id) => volumeOf(kernels.occt, result.document, id)).sort((a, b) => a - b);
    const [small, large] = [Math.min(BOX_VOLUME, CYLINDER_VOLUME), Math.max(BOX_VOLUME, CYLINDER_VOLUME)];
    expect(Math.abs(volumes[0]! / small - 1)).toBeLessThan(1e-9);
    expect(Math.abs(volumes[1]! / large - 1)).toBeLessThan(1e-9);
    const entity = result.document.entities[result.affected[0] ?? ''] as MeshSolidEntity;
    expect(entity.brep).toMatchObject({ op: 'brep', format: 'occt-brep-v1' });
    expect(report.solids.map((solid) => solid.faces).sort()).toEqual([3, 6]);
  }, 120_000);

  it('scales into the document unit', () => {
    const inches = { ...createEmptyDocument(), units: 'in' as const };
    const result = importStep(kernels.occt, stepOf(kernels.occt, box), {}, inches);
    expect(volumeOf(kernels.occt, result.document, result.affected[0] ?? '')).toBeCloseTo(BOX_VOLUME / 25.4 ** 3, 6);
  }, 120_000);

  it('keeps the exact shape through save, load into a fresh kernel and replay_history (same ids, same blobs)', async () => {
    const step = stepOf(kernels.occt, box, cylinder);
    const imported = importStep(kernels.occt, step, { keepOriginal: true });
    const shas = Object.keys(imported.document.blobs ?? {}).sort();
    expect(shas).toHaveLength(3);
    const text = serializeDocument(imported.document);
    expect(JSON.parse(text)).toMatchObject({ version: 3, document: { kernelSettings: { kernel: 'occt', occtVersion: '7.9.2' } } });

    const fresh = createNativeTestKernel();
    const loaded = deserializeDocument(text);
    const touched = execute(loaded, 'describe_scene', {}, ctxOf(fresh));
    expect(touched.rejected).toBeUndefined();
    for (const id of imported.affected) {
      const shape = fresh.evaluate(recipeOf(loaded.entities[id] as Entity));
      expect(shape).not.toBeNull();
      expect(fresh.tessellate(shape!)?.indices.length).toBeGreaterThan(0);
      expect(volumeOf(fresh, loaded, id)).toBeCloseTo(volumeOf(kernels.occt, imported.document, id), 6);
    }

    const replayed = execute(imported.document, 'replay_history', {}, ctxOf(kernels.occt));
    expect(replayed.document.order).toEqual(imported.document.order);
    expect(Object.keys(replayed.document.blobs ?? {}).sort()).toEqual(shas);
    expect(replayed.document.entities).toEqual(imported.document.entities);
  }, 180_000);

  it('writes identical B-rep text for two imports of one file (blob determinism)', () => {
    const step = stepOf(kernels.occt, box, cylinder);
    const [first, second] = [importStep(kernels.occt, step), importStep(kernels.occt, step)];
    expect(Object.keys(second.document.blobs ?? {}).sort()).toEqual(Object.keys(first.document.blobs ?? {}).sort());
  }, 120_000);

  it('refuses unreadable and solid-less input with stable codes, leaving the document untouched', () => {
    const doc = createEmptyDocument();
    const garbage = importStep(kernels.occt, 'this is not a STEP file', {}, doc);
    expect(garbage.error?.code).toBe('KRN_STEP_UNREADABLE');
    expect(garbage.document).toBe(doc);
    const truncated = importStep(kernels.occt, stepOf(kernels.occt, box).slice(0, 400), {}, doc);
    expect(truncated.error?.code).toBe('KRN_STEP_UNREADABLE');
    const empty = importStep(
      kernels.occt,
      "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
      {},
      doc,
    );
    expect(empty.error?.code).toBe('KRN_STEP_UNREADABLE');
    expect(empty.document).toBe(doc);
  }, 120_000);

  it('reports an AP242 file that only holds tessellated geometry', () => {
    const tessellated = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));",
      'ENDSEC;',
      'DATA;',
      "#1 = COORDINATES_LIST('',3,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));",
      "#2 = TRIANGULATED_FACE('',#1,3,((0.,0.,1.)),$,((1,2,3)),());",
      "#3 = TESSELLATED_SHELL('',(#2),$);",
      'ENDSEC;',
      'END-ISO-10303-21;',
    ].join('\n');
    const result = importStep(kernels.occt, tessellated);
    expect(result.affected).toEqual([]);
    expect(result.error?.code).toBe('KRN_STEP_TESSELLATED_ONLY');
  }, 120_000);

  describe('shell-only files (a box turned into a shell-based surface model)', () => {
    const shellOnly = (): string =>
      stepOf(kernels.occt, box).replace(/MANIFOLD_SOLID_BREP\('([^']*)',#(\d+)\)/, "SHELL_BASED_SURFACE_MODEL('$1',(#$2))");

    it('sews the closed shell into a solid with the exact volume', () => {
      const result = importStep(kernels.occt, shellOnly());
      expect(result.error).toBeUndefined();
      const report = reportOf(result);
      expect(report.census).toMatchObject({ solids: 0, shells: 1, openShells: 0 });
      expect(report.solids[0]).toMatchObject({ validAsRead: false, validAfterHeal: true, actions: expect.arrayContaining(['sewn']) });
      expect(Math.abs(volumeOf(kernels.occt, result.document, result.affected[0] ?? '') / BOX_VOLUME - 1)).toBeLessThan(1e-9);
    }, 120_000);

    it('refuses with KRN_STEP_NO_SOLID when sewing is off or the shell stays open', () => {
      const doc = createEmptyDocument();
      const noSew = importStep(kernels.occt, shellOnly(), { sew: false }, doc);
      expect(noSew.error?.code).toBe('KRN_STEP_NO_SOLID');
      expect(noSew.document).toBe(doc);
      const text = shellOnly();
      const faces = /CLOSED_SHELL\('',\(([^)]*)\)\)/.exec(text);
      const opened = text.replace(faces?.[0] ?? '', `OPEN_SHELL('',(${(faces?.[1] ?? '').split(',').slice(1).join(',')}))`);
      const open = importStep(kernels.occt, opened, {}, doc);
      expect(open.error?.code).toBe('KRN_STEP_NO_SOLID');
      expect(open.summary).toMatch(/open shell with 4 free edges/);
      expect(open.document).toBe(doc);
    }, 120_000);
  });

  it('imports the NIST CTC-01 AP242 part (117 faces) as one valid solid', () => {
    const result = importStep(kernels.occt, readFileSync(path.join(PACK, 'nist_ctc_01_asme1_ap242.stp'), 'utf8'));
    expect(result.error).toBeUndefined();
    expect(reportOf(result)).toMatchObject({
      census: { solids: 1, faces: 117 },
      solids: [{ validAfterHeal: true, faces: 117, faceted: false }],
    });
    expect(volumeOf(kernels.occt, result.document, result.affected[0] ?? '')).toBeGreaterThan(0);
  }, 120_000);

  describe.each([
    ['ftr_machined_plate.step', 55978.529152795934, 1],
    ['ftr_bracket_L.step', 5279.716754404115, 1],
    ['ftr_joggle_strip.step', 2184.347213509194, 1],
  ])('committed 07-pack part %s', (file, analyticVolume, solids) => {
    it('imports as valid exact solids with the analytic volume (rel 1e-6)', () => {
      const result = importStep(kernels.occt, readFileSync(path.join(PACK, file), 'utf8'), { fileName: file });
      expect(result.error).toBeUndefined();
      expect(result.affected).toHaveLength(solids);
      const report = reportOf(result);
      expect(report.solids.every((solid) => solid.validAfterHeal && !solid.faceted && solid.freeEdges === 0)).toBe(true);
      expect(Math.abs(volumeOf(kernels.occt, result.document, result.affected[0] ?? '') / analyticVolume - 1)).toBeLessThan(1e-6);
    }, 120_000);
  });

  it('is reachable from the CLI: llull import_step_exact file=part.step --doc', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'llull-step-exact-'));
    const step = path.join(dir, 'part.step');
    const docPath = path.join(dir, 'a.llull');
    writeFileSync(step, stepOf(kernels.occt, box));
    const out: string[] = [];
    const io = {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => out.push(text),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => {
        setGeometryKernel(kernels.occt);
        return Promise.resolve();
      },
      exchangeOptions: () => ({ port: null, dwg: null, allowCodeExecution: false }),
    };
    expect(await runCli(['import_step_exact', `file=${step}`, '--doc', docPath], io)).toBe(EXIT_OK);
    expect(out.join('\n')).toMatch(/1 exact solid/);
    const saved = deserializeDocument(readFileSync(docPath, 'utf8'));
    expect(Object.keys(saved.blobs ?? {})).toHaveLength(1);
    expect(Object.keys(saved.entities)).toHaveLength(1);
  }, 120_000);
});
