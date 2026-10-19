/** Aerospace 01 KRN: kernel_info, set_modeling_tolerance and the blob hand-off from execute() to the kernel (no WASM). */
import { describe, expect, it, vi } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { makeBlob, withBlob } from '@core/model/blobs';
import { createEmptyDocument, type CadDocument, type DocumentKernelSettings } from '@core/model/types';
import { fakeExactKernel } from '../helpers/fakeExactKernel';

const ctxOf = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });
const OCC_INFO = {
  occtVersion: '7.4.0p1',
  build: 'opencascade.js@1.1.1',
  capabilities: ['topology', 'importShapes'],
  isolation: 'worker',
} as const;
const settings = (extra: Partial<DocumentKernelSettings> = {}): DocumentKernelSettings => ({
  kernel: 'occt',
  modelingTolerance: { linear: 1e-4, angular: 1e-9, maxImportTolerance: 0.01 },
  ...extra,
});

interface InfoData {
  active: string | null;
  occtVersion?: string;
  build?: string;
  capabilities: string[];
  isolation?: string;
  fallbackReason?: string;
  modelingTolerance: Record<
    'linear' | 'angular' | 'maxImportTolerance',
    { value: number; unit: string; source: string; defaulted: boolean }
  >;
  issues: Array<{ code: string; severity: string }>;
}

const infoOf = (doc: CadDocument, kernel: GeometryKernel | null): InfoData =>
  execute(doc, 'kernel_info', {}, ctxOf(kernel)).data as InfoData;

describe('kernel_info', () => {
  it('describes the OCC kernel with named default tolerances', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'kernel_info', {}, ctxOf(fakeExactKernel({ info: OCC_INFO }).kernel));
    const data = result.data as InfoData;
    expect(data).toMatchObject({ active: 'occt', occtVersion: '7.4.0p1', build: 'opencascade.js@1.1.1', isolation: 'worker' });
    expect(data.capabilities).toEqual(expect.arrayContaining(['topology', 'importShapes']));
    expect(data.modelingTolerance.linear).toMatchObject({ value: 1e-4, unit: 'mm', defaulted: true });
    expect(data.modelingTolerance.angular).toMatchObject({ value: 1e-9, unit: 'rad', defaulted: true });
    expect(data.modelingTolerance.maxImportTolerance).toMatchObject({ value: 0.01, unit: 'mm', defaulted: true });
    expect(data.issues).toEqual([]);
    expect(result.summary).toContain('OCCT 7.4.0p1');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('reports a native sidecar kernel isolated in its own process', () => {
    const native = fakeExactKernel({ info: { ...OCC_INFO, occtVersion: '7.9.2', build: 'llull-kernel', isolation: 'process' } }).kernel;
    expect(infoOf(createEmptyDocument(), native)).toMatchObject({ active: 'occt', occtVersion: '7.9.2', isolation: 'process' });
  });

  it('reports a Manifold kernel and no kernel at all', () => {
    const manifold = infoOf(
      createEmptyDocument(),
      fakeExactKernel({ name: 'manifold', info: { capabilities: ['analyze'] }, exact: false }).kernel,
    );
    expect(manifold).toMatchObject({ active: 'manifold', capabilities: ['analyze'] });
    expect(manifold.occtVersion).toBeUndefined();
    const none = infoOf(createEmptyDocument(), null);
    expect(none).toMatchObject({ active: null, capabilities: [] });
  });

  it('warns KRN_KERNEL_FALLBACK when the exact kernel failed to start', () => {
    const fallback = fakeExactKernel({
      name: 'manifold',
      info: { capabilities: [], isolation: 'in-process', fallbackReason: 'worker died on start' },
      exact: false,
    }).kernel;
    const result = execute(createEmptyDocument(), 'kernel_info', {}, ctxOf(fallback));
    const data = result.data as InfoData;
    expect(data).toMatchObject({ active: 'manifold', fallbackReason: 'worker died on start' });
    expect(data.issues.map((issue) => issue.code)).toEqual(['KRN_KERNEL_FALLBACK']);
    expect(result.summary).toContain('KRN_KERNEL_FALLBACK');
  });

  it('warns KRN_KERNEL_MISMATCH when the document came from another OCCT version or kernel', () => {
    const occ = fakeExactKernel({ info: OCC_INFO }).kernel;
    const older = { ...createEmptyDocument(), kernelSettings: settings({ occtVersion: '7.9.3' }) };
    const data = infoOf(older, occ);
    expect(data.issues.map((issue) => issue.code)).toEqual(['KRN_KERNEL_MISMATCH']);
    expect(data.issues[0]?.severity).toBe('warn');
    const sameVersion = { ...createEmptyDocument(), kernelSettings: settings({ occtVersion: '7.4.0p1' }) };
    expect(infoOf(sameVersion, occ).issues).toEqual([]);
    const otherKernel = { ...createEmptyDocument(), kernelSettings: settings({ kernel: 'manifold' }) };
    expect(infoOf(otherKernel, occ).issues.map((issue) => issue.code)).toEqual(['KRN_KERNEL_MISMATCH']);
  });
});

describe('set_modeling_tolerance', () => {
  const run = (doc: CadDocument, params: Record<string, unknown>): CommandResult =>
    execute(doc, 'set_modeling_tolerance', params, ctxOf(fakeExactKernel({ info: OCC_INFO }).kernel));

  it('sets the given tolerances, keeps the others and creates kernelSettings naming the kernel', () => {
    const result = run(createEmptyDocument(), { linear: 1e-5, maxImportTolerance: 0.05 });
    expect(result.document.kernelSettings).toEqual(
      settings({ modelingTolerance: { linear: 1e-5, angular: 1e-9, maxImportTolerance: 0.05 } }),
    );
    expect(result.document.featureHistory.map((step) => step.name)).toEqual(['set_modeling_tolerance']);
    const data = infoOf(result.document, null);
    expect(data.modelingTolerance.linear).toMatchObject({ value: 1e-5, defaulted: false });
    expect(data.modelingTolerance.angular.defaulted).toBe(true);
  });

  it('keeps an existing provenance stamp', () => {
    const stamped = { ...createEmptyDocument(), kernelSettings: settings({ occtVersion: '7.4.0p1', build: 'b' }) };
    const result = run(stamped, { angular: 1e-8 });
    expect(result.document.kernelSettings).toMatchObject({
      occtVersion: '7.4.0p1',
      build: 'b',
      modelingTolerance: { angular: 1e-8, linear: 1e-4 },
    });
  });

  it.each<[Record<string, unknown>, string[]]>([
    [{ linear: 1e-8 }, ['linear']],
    [{ linear: 0.1 }, ['linear']],
    [{ angular: 0.5 }, ['angular']],
    [{ maxImportTolerance: 5 }, ['maxImportTolerance']],
    [{ linear: 1e-2, maxImportTolerance: 1e-3 }, ['maxImportTolerance']],
    [{ linear: 1e-9, angular: 2 }, ['linear', 'angular']],
  ])('refuses %j with KRN_TOLERANCE_OUT_OF_RANGE', (params, paths) => {
    const doc = createEmptyDocument();
    const result = run(doc, params);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.error).toMatchObject({ code: 'KRN_TOLERANCE_OUT_OF_RANGE', paths });
  });

  it('refuses an empty call and is pure', () => {
    const doc = createEmptyDocument();
    const before = structuredClone(doc);
    expect(run(doc, {}).document).toBe(doc);
    run(doc, { linear: 1e-5 });
    expect(doc).toEqual(before);
  });
});

describe('execute hands document blobs to the kernel', () => {
  it('loads each B-rep blob once per kernel, skips STEP blobs, and tells later kernels again', () => {
    const brep = makeBlob('model/x-occt-brep', 'CASCADE Topology V1 a');
    const step = makeBlob('model/step', 'ISO-10303-21;');
    const doc = withBlob(withBlob(createEmptyDocument(), brep), step);
    const first = fakeExactKernel();
    execute(doc, 'describe_scene', {}, ctxOf(first.kernel));
    execute(doc, 'describe_scene', {}, ctxOf(first.kernel));
    expect(first.loaded).toEqual([brep.sha256]);
    const second = fakeExactKernel();
    execute(doc, 'kernel_info', {}, ctxOf(second.kernel));
    expect(second.loaded).toEqual([brep.sha256]);
    expect(first.kernel.evaluate({ op: 'brep', blob: brep.sha256, format: 'occt-brep-v1' })).not.toBeNull();
    expect(first.kernel.evaluate({ op: 'brep', blob: '0'.repeat(64), format: 'occt-brep-v1' })).toBeNull();
  });

  it('does nothing for documents without blobs or kernels without loadBlob', () => {
    const doc = withBlob(createEmptyDocument(), makeBlob('model/x-occt-brep', 'x'));
    const mesh = fakeExactKernel({ exact: false });
    expect(execute(doc, 'describe_scene', {}, ctxOf(mesh.kernel)).rejected).toBeUndefined();
    const idle = fakeExactKernel();
    execute(createEmptyDocument(), 'describe_scene', {}, ctxOf(idle.kernel));
    expect(idle.loaded).toEqual([]);
  });

  it('retries a brep recipe that failed before its blob arrived', () => {
    const { kernel } = fakeExactKernel();
    const blob = makeBlob('model/x-occt-brep', 'late');
    const recipe = { op: 'brep', blob: blob.sha256, format: 'occt-brep-v1' } as const;
    expect(kernel.evaluate(recipe)).toBeNull();
    kernel.loadBlob?.(blob.sha256, 'late');
    expect(kernel.evaluate(recipe)).not.toBeNull();
  });

  it('refuses blob text whose sha256 differs from its key (a forged document cannot poison a shared kernel)', () => {
    const { kernel, loaded } = fakeExactKernel();
    const blob = makeBlob('model/x-occt-brep', 'genuine');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    kernel.loadBlob?.(blob.sha256, 'forged');
    expect(loaded).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('KRN_BLOB_HASH_MISMATCH'));
    warn.mockRestore();
    kernel.loadBlob?.(blob.sha256, 'genuine');
    expect(loaded).toEqual([blob.sha256]);
  });
});
