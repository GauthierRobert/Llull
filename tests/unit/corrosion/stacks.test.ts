/** VC-COR-12: contacts of fastener stacks from the read-only list_fastener_stacks answer (no geometry). */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { stackContacts, stackContactsOf, stackPairsOf } from '@cae/corrosion/stacks';
import { ctxWith, docWith, inchDocument, ok, sampleCatalogFile } from '../aero/fasteners/fixtures';
import { check, expected, withEnvironment } from './fixtures';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

function placed(): { doc: ReturnType<typeof inchDocument>; plates: string[]; entry: Record<string, unknown> } {
  const first = ok(docWith(sampleCatalogFile(), inchDocument()), 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
  const second = ok(first.document, 'add_box', { size: [2, 1, 0.26], anchor: 'min', position: [0, 0, 0.25] });
  const plates = [first.affected[0] as string, second.affected[0] as string];
  const result = ok(
    second.document,
    'insert_fastener_stack',
    {
      family: 'NAS6203-6220',
      diameterDash: '3',
      stackIds: plates,
      axisPoint: [1, 0.5, 0],
      axis: [0, 0, 1],
      nut: 'MS21042',
      washer: 'NAS1149',
      holeMode: 'cut_close_tolerance',
      holeDiameter: { value: 0.19, unit: 'in' },
    },
    ctxWith(kernel),
  );
  const [entry] = (execute(result.document, 'list_fastener_stacks', {}).data as { stacks: Record<string, unknown>[] }).stacks;
  return { doc: result.document, plates, entry: entry ?? {} };
}

describe('stack contacts from list_fastener_stacks (VC-COR-12)', () => {
  it('the answer names the placed parts, and the pairs are fastener-layers, layer-layer, washer-last layer, nut-washer', () => {
    const { doc, plates, entry } = placed();
    const fastener = entry['fastenerInstanceId'] as string;
    const [washer] = entry['washers'] as { instanceId: string; side: string }[];
    const nut = entry['nutInstanceId'] as string;
    const [a, b] = plates as [string, string];
    const order = (x: string, y: string): string => (x < y ? `${x}|${y}` : `${y}|${x}`);
    const oracle = (expected.cases.find((item) => item.id === 'VC-COR-12')?.value as { pairs: string[][] }).pairs.length;
    const { pairs, skipped } = stackContacts(doc);
    expect(skipped).toEqual([]);
    expect(pairs.map((pair) => pair.join('|'))).toEqual(
      [
        order(fastener, a),
        order(fastener, b),
        order(a, b),
        order(washer?.instanceId ?? '', washer?.side === 'nut' ? b : a),
        order(nut, washer?.instanceId ?? ''),
      ].sort(),
    );
    expect(pairs).toHaveLength(oracle);
  });

  it('the check turns the stack pairs into items without geometry (the parts have no material: unknown, never pass)', () => {
    const { doc } = placed();
    const result = check(withEnvironment(doc, 'normal'), { includeStacks: true });
    expect(result.items.some((item) => item.contact.source === 'stack')).toBe(true);
    expect(result.items.every((item) => item.status !== 'pass')).toBe(true);
    expect(check(withEnvironment(doc, 'normal'), { includeStacks: false }).items.some((item) => item.contact.source === 'stack')).toBe(
      false,
    );
  });

  it('a document without stacks has none, and a hostile answer is skipped by entry, never thrown', () => {
    expect(stackContacts(withEnvironment(inchDocument(), 'normal'))).toEqual({ pairs: [], skipped: [] });
    for (const hostile of [
      undefined,
      null,
      5,
      'x',
      {},
      [null, 7, 'x'],
      [{ id: 's', layers: 'x', washers: {}, fastenerInstanceId: 3 }],
      [{ id: 't', layers: [], washers: [], fastenerInstanceId: 'f' }],
      [{ id: 'u', layers: [{ entityId: 'p' }], washers: [{ instanceId: 'w', side: 'top' }], fastenerInstanceId: 'f' }],
      [{ id: 'v', layers: [{ entityId: 'p' }], washers: [], fastenerInstanceId: 'f', nutInstanceId: 4 }],
    ]) {
      const answer = stackPairsOf(hostile);
      expect(answer.pairs).toEqual([]);
      expect(answer.skipped.length).toBe(Array.isArray(hostile) ? hostile.length : 0);
    }
  });

  it('a head washer sits on the first layer; a nut without washer on the last layer; duplicates merge; ids sort', () => {
    const base = {
      layers: [{ entityId: 'plate1' }, { entityId: 'plate2' }],
      fastenerInstanceId: 'bolt',
      washers: [{ instanceId: 'hw', side: 'head' }],
      nutInstanceId: 'nut',
    };
    const { pairs } = stackPairsOf([
      { id: 'a', ...base },
      { id: 'b', ...base },
    ]);
    expect(pairs.map((pair) => pair.join('|'))).toEqual(['bolt|plate1', 'bolt|plate2', 'hw|plate1', 'nut|plate2', 'plate1|plate2']);
  });

  it('10^4 stacks resolve to contacts well inside the 1 s budget', () => {
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      id: `s${index}`,
      layers: [{ entityId: `p${index}` }, { entityId: `q${index}` }],
      fastenerInstanceId: `b${index}`,
      washers: [{ instanceId: `w${index}`, side: 'nut' }],
      nutInstanceId: `n${index}`,
    }));
    const started = performance.now();
    expect(stackPairsOf(entries).pairs.length).toBe(50_000);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('stackContactsOf: an unreadable answer is not an empty one', () => {
  const base = { document: {} as never, summary: 'boom', affected: [] };
  it('only an unregistered command means no stacks', () => {
    expect(stackContactsOf({ ...base, rejected: true, error: { code: 'CMD_UNKNOWN', ids: [], paths: [], remediation: '' } })).toEqual({
      pairs: [],
      skipped: [],
    });
  });
  it.each([
    ['another rejection', { rejected: true as const, error: { code: 'KERNEL_REQUIRED', ids: [], paths: [], remediation: '' } }],
    ['a rejection without error', { rejected: true as const }],
    ['no data', {}],
    ['non-object data', { data: 5 }],
  ])('%s is a skipped entry', (_label, extra) => {
    const answer = stackContactsOf({ ...base, ...extra });
    expect(answer.pairs).toEqual([]);
    expect(answer.skipped).toEqual([{ id: 'list_fastener_stacks', reason: expect.stringContaining('boom') }]);
  });
});
