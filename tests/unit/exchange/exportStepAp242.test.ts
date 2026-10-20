/** export_step_ap242 / export_step_exact (XDE path) / geometric_validation_properties over a scripted XDE kernel (no OpenCascade). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExchangeWriteRequest } from '@core/geometry/kernelExchange';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { summarizeStep21 } from '@lib/step21/summary';
import { fakeExactKernel } from '../../helpers/fakeExactKernel';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { TETRA } from '../../helpers/fakeKernel';
import { type FakeXdeKernel, fakeStepText, fakeXdeKernel, type XdeFakeSpec } from '../../helpers/fakeXdeKernel';

const ctxOf = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });
const run = (
  doc: CadDocument,
  name: string,
  params: Record<string, unknown>,
  spec: XdeFakeSpec = {},
): { result: CommandResult; fake: FakeXdeKernel } => {
  const fake = fakeXdeKernel(spec);
  return { result: execute(doc, name, params, ctxOf(fake.kernel)), fake };
};

function boxes(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [10, 20, 30], position: [5, 0, 0], color: '#ff0000' }).document;
  doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [100, 0, 0] }).document;
  const [first, second] = doc.order;
  doc = execute(doc, 'set_entity_name', { id: first, name: 'Plate' }).document;
  doc = execute(doc, 'set_entity_name', { id: second, name: 'Cube' }).document;
  return doc;
}

/** One component of two boxes, instanced at x = 0 and 50, plus a loose box. */
function assemblyDoc(): { doc: CadDocument; instances: string[]; loose: string } {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
  doc = execute(doc, 'add_box', { size: [4, 4, 4], position: [0, 0, 10] }).document;
  const [a, b] = doc.order as [string, string];
  doc = execute(doc, 'set_entity_name', { id: a, name: 'Head' }).document;
  doc = execute(doc, 'set_entity_name', { id: b, name: 'Shank' }).document;
  doc = execute(doc, 'create_component', { name: 'Bolt', entityIds: [a, b], componentId: 'comp-bolt' }).document;
  const first = doc.order[0] as string;
  const second = execute(doc, 'insert_instance', { componentId: 'comp-bolt', position: [50, 0, 0] });
  doc = second.document;
  doc = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, -20] }).document;
  const loose = doc.order[doc.order.length - 1] as string;
  doc = execute(doc, 'set_entity_name', { id: loose, name: 'Washer' }).document;
  return { doc, instances: [first, ...second.affected], loose };
}

const dataOf = <T>(result: CommandResult): T => result.data as T;

describe('export_step_ap242: flat document', () => {
  it('writes one product per solid with its validation properties and a green self-check', () => {
    const doc = boxes();
    const { result, fake } = run(doc, 'export_step_ap242', { timestamp: '2026-10-20T00:00:00', fileName: 'p.stp' });
    const request = fake.requests[0] as ExchangeWriteRequest;
    expect(request).toMatchObject({
      format: 'step',
      schema: 'ap242',
      unit: 'mm',
      occurrences: [],
      header: { fileName: 'p.stp', timestamp: '2026-10-20T00:00:00' },
    });
    expect(request.products.map((product) => product.name)).toEqual(['Plate', 'Cube']);
    expect(request.products[0]?.validation).toEqual({ volume: 6000, area: 2 * (200 + 600 + 300), centroid: [5, 0, 0] });
    expect(request.products[0]?.solids[0]).toMatchObject({ name: 'Plate', color: '#ff0000' });
    const data = dataOf<{
      step: string;
      schemaName: string;
      selfCheck: { band: string; missing: string[] };
      gvp: { product: string; volume: number }[];
      entityIds: string[];
      assembly?: unknown;
    }>(result);
    expect(data.selfCheck).toMatchObject({ band: 'green', missing: [], products: 2 });
    expect(data.gvp.map((entry) => entry.product)).toEqual(['Plate', 'Cube']);
    expect(data.entityIds).toEqual(doc.order);
    expect(data.assembly).toBeUndefined();
    expect(data.schemaName).toContain('AP242');
    expect(summarizeStep21(data.step).products).toEqual(['Plate', 'Cube']);
    expect(result.summary).toContain('STEP AP242');
    expect(result.summary).toContain('self-check green');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expectPure(doc, () => run(doc, 'export_step_ap242', {}));
  });

  it('honours schema, includeValidationProperties and the default header', () => {
    const doc = boxes();
    const ap214 = run(doc, 'export_step_ap242', { schema: 'ap214', includeValidationProperties: false });
    expect(ap214.fake.requests[0]).toMatchObject({ schema: 'ap214', header: { fileName: 'llull.stp', timestamp: '1970-01-01T00:00:00' } });
    expect(ap214.fake.requests[0]?.products.every((product) => product.validation === undefined)).toBe(true);
    const data = dataOf<{ selfCheck?: unknown; gvp: unknown[]; summary?: string }>(ap214.result);
    expect(data.selfCheck).toBeUndefined();
    expect(data.gvp).toEqual([]);
    expect(ap214.result.summary).toContain('validation properties not written');
    const ids = execute(doc, 'export_step_ap242', { entityIds: [doc.order[1] as string] }, ctxOf(fakeXdeKernel().kernel));
    expect(dataOf<{ entityIds: string[] }>(ids).entityIds).toEqual([doc.order[1]]);
  });

  it('writes the solids in world space as separate products with assembly: flat', () => {
    const { doc } = assemblyDoc();
    const { fake, result } = run(doc, 'export_step_ap242', { assembly: 'flat' });
    expect(fake.requests[0]?.occurrences).toEqual([]);
    expect(fake.requests[0]?.products).toHaveLength(5);
    expect(dataOf<{ assembly?: unknown }>(result).assembly).toBeUndefined();
  });
});

describe('export_step_ap242: assembly structure', () => {
  it('writes one product per component, one occurrence per instance and the assembly validation properties', () => {
    const { doc, instances, loose } = assemblyDoc();
    const { result, fake } = run(doc, 'export_step_ap242', {});
    const request = fake.requests[0] as ExchangeWriteRequest;
    expect(request.products.map((product) => product.name)).toEqual(['Bolt', 'Washer']);
    const bolt = request.products[0];
    expect(bolt?.solids.map((solid) => solid.name)).toEqual(['Head', 'Shank']);
    expect(bolt?.validation?.volume).toBe(1000 + 64);
    expect(request.occurrences.filter((occurrence) => occurrence.parent === null)).toHaveLength(3);
    expect(request.occurrences.map((occurrence) => occurrence.name)).toEqual(expect.arrayContaining(['Bolt 1', 'Bolt 2', 'Washer']));
    expect(request.occurrences.find((occurrence) => occurrence.name === 'Bolt 2')?.position).toEqual([50, 0, 0]);
    expect(request.rootName).toBe('Assembly');
    expect(request.rootValidation?.volume).toBeCloseTo(2 * 1064 + 1, 9);
    const data = dataOf<{
      assembly: { products: number; occurrences: number };
      entityIds: string[];
      selfCheck: { band: string; products: number };
    }>(result);
    expect(data.assembly).toEqual({ products: 2, occurrences: 3 });
    expect(data.entityIds).toEqual(expect.arrayContaining([...instances, loose]));
    expect(data.selfCheck).toMatchObject({ band: 'green', products: 3 });
    expect(result.summary).toContain('2 product(s), 3 occurrence(s)');
  });

  it('nests sub-assemblies: a pair of bolts as one component, validation properties composed through the placements', () => {
    let { doc } = assemblyDoc();
    doc = execute(doc, 'create_component', {
      name: 'Pair',
      entityIds: doc.order.filter((id) => doc.entities[id]?.kind === 'instance'),
      componentId: 'comp-pair',
    }).document;
    doc = execute(doc, 'insert_instance', { componentId: 'comp-pair', position: [0, 100, 0], rotation: [0, 0, Math.PI / 2] }).document;
    const { fake, result } = run(doc, 'export_step_ap242', {});
    const request = fake.requests[0] as ExchangeWriteRequest;
    const pair = request.products.find((product) => product.name === 'Pair');
    expect(pair?.validation?.volume).toBeCloseTo(2 * 1064, 9);
    const inner = request.occurrences.filter((occurrence) => occurrence.parent !== null);
    expect(inner.map((occurrence) => occurrence.name).sort()).toEqual(['Bolt 1', 'Bolt 2']);
    expect(dataOf<{ selfCheck: { band: string } }>(result).selfCheck.band).toBe('green');
  });

  it('writes surface sheets as products without validation properties', () => {
    const sheet = execute(createEmptyDocument(), 'create_nurbs_surface', {
      degreeU: 1,
      degreeV: 1,
      poles: [
        [
          [0, 0, 0],
          [0, 4, 0],
        ],
        [
          [4, 0, 0],
          [4, 4, 0],
        ],
      ],
    });
    const { result, fake } = run(sheet.document, 'export_step_ap242', {});
    expect(dataOf<{ sheetCount: number; solidCount: number }>(result)).toMatchObject({ sheetCount: 1, solidCount: 0 });
    expect(fake.requests[0]?.products[0]?.validation).toBeUndefined();
  });
});

describe('export_step_ap242: refusals', () => {
  it('refuses without a kernel, with a mesh kernel and with an empty selection, leaving the document alone', () => {
    const doc = boxes();
    const none = execute(doc, 'export_step_ap242', {}, ctxOf(null));
    expect(none.rejected).toBe(true);
    expect(none.document).toBe(doc);
    const mesh = execute(doc, 'export_step_ap242', {}, ctxOf(fakeExactKernel({ exact: false }).kernel));
    expectNoOp(mesh, doc);
    expect(mesh.error?.code).toBe('XCH_WRITER_UNAVAILABLE');
    const empty = run(createEmptyDocument(), 'export_step_ap242', {}).result;
    expect(empty.error?.code).toBe('XCH_NO_SOLIDS');
    expect(empty.data).toBeUndefined();
    const missing = run(doc, 'export_step_ap242', { entityIds: ['nope'] }).result;
    expect(missing.error?.code).toBe('XCH_NO_SOLIDS');
    expect(missing.summary).toContain('nope (not found)');
  });

  it('refuses a kernel that cannot write, cannot build a solid or writes a file that disagrees with the model', () => {
    const doc = boxes();
    expect(run(doc, 'export_step_ap242', {}, { writeStep: () => null }).result.error?.code).toBe('XCH_WRITER_UNAVAILABLE');
    expect(run(doc, 'export_step_ap242', {}, { writeStep: () => '' }).result.document).toBe(doc);
    const wrongVolume = run(
      doc,
      'export_step_ap242',
      {},
      {
        writeStep: (request) =>
          fakeStepText(
            request.products.map((product) => ({
              name: product.name,
              volume: 1,
              area: product.validation!.area,
              centroid: product.validation!.centroid,
            })),
          ),
      },
    );
    expect(wrongVolume.result.error?.code).toBe('XCH_SELFCHECK_RED');
    expect(wrongVolume.result.summary).toContain('XCH_SELFCHECK_RED');
    expect(wrongVolume.result.data).toBeUndefined();
    const noProperties = run(
      doc,
      'export_step_ap242',
      {},
      {
        writeStep: (request) =>
          fakeStepText(
            request.products.map((product) => ({ name: product.name, volume: 1, area: 1, centroid: [0, 0, 0] })),
            { withProperties: false },
          ),
      },
    );
    expect(noProperties.result.error?.code).toBe('XCH_SELFCHECK_RED');
    expect(noProperties.result.summary).toContain('no validation property for Plate');
  });

  it('writes without validation properties when the kernel cannot integrate a solid', () => {
    const { result } = run(boxes(), 'export_step_ap242', {}, { noMass: true });
    expect(dataOf<{ gvp: unknown[] }>(result).gvp).toEqual([]);
  });

  it('refuses a solid the kernel cannot build', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_cylinder', { radius: 2, height: 5 }).document;
    const fake = fakeXdeKernel();
    const refusing = { ...fake.kernel, evaluate: () => null } as GeometryKernel;
    const result = execute(doc, 'export_step_ap242', {}, ctxOf(refusing));
    expect(result.error?.code).toBe('XCH_NO_SOLIDS');
    expect(result.summary).toContain("could not build 'cyl");
  });
});

describe('export_step_ap242: unverified imported bodies (TR-XCH-26)', () => {
  const flagged = (): { doc: CadDocument; id: string } => {
    const doc = boxes();
    const id = doc.order[0] as string;
    return {
      doc: {
        ...doc,
        exchange: {
          provenance: {
            [id]: {
              format: 'step',
              schemaName: null,
              fileName: 'x.stp',
              sha256: 'abc',
              productName: 'Plate',
              sourceUnit: 'mm',
              unverified: { value: true, reasons: ['import_gvp_red'] },
            },
          },
        },
      },
      id,
    };
  };

  it('refuses until a human signs: XCH_UNVERIFIED_BODIES, then XCH_HUMAN_GATE for an agent', () => {
    const { doc, id } = flagged();
    const refused = run(doc, 'export_step_ap242', {}).result;
    expect(refused.rejected).toBe(true);
    expect(refused.error).toMatchObject({ code: 'XCH_UNVERIFIED_BODIES', ids: [id] });
    const agent = run(doc, 'export_step_ap242', { acceptUnverified: true }).result;
    expect(agent.error?.code).toBe('XCH_HUMAN_GATE');
    expect(agent.data).toBeUndefined();
    expect(agent.document).toBe(doc);
  });

  it('exports and asks for review when the signing port verifies the human signature', () => {
    const { doc } = flagged();
    const fake = fakeXdeKernel();
    const ctx: ExecutionContext = { ...ctxOf(fake.kernel), humanSignature: { verify: () => ({ signer: 'reviewer', signatureId: 's1' }) } };
    const accepted = execute(doc, 'export_step_ap242', { acceptUnverified: { nonce: 'n1' } }, ctx);
    expect(accepted.data).toBeDefined();
    expect(dataOf<{ reviewRequired: { value: boolean; reasons: string[] } }>(accepted).reviewRequired).toEqual({
      value: true,
      reasons: ['unverified_bodies_accepted'],
    });
    expect(accepted.summary).toContain('Review required');
    const rejectedSignature = execute(
      doc,
      'export_step_ap242',
      { acceptUnverified: { nonce: 'n1' } },
      { ...ctx, humanSignature: { verify: () => null } },
    );
    expect(rejectedSignature.error?.code).toBe('XCH_HUMAN_GATE');
  });
});

describe('export_step_exact through the XDE writer (TR-XCH-19)', () => {
  it('keeps the legacy data shape in AP214 without validation properties', () => {
    const { doc } = assemblyDoc();
    const { result, fake } = run(doc, 'export_step_exact', {});
    expect(fake.requests[0]).toMatchObject({ schema: 'ap214' });
    expect(fake.requests[0]?.products.every((product) => product.validation === undefined)).toBe(true);
    const data = dataOf<{
      format: string;
      step: string;
      solidCount: number;
      sheetCount: number;
      assembly?: { products: number; occurrences: number };
      entityIds: string[];
    }>(result);
    expect(data).toMatchObject({ format: 'step', solidCount: 5, sheetCount: 0, assembly: { products: 2, occurrences: 3 } });
    expect(result.summary).toContain('STEP AP214 assembly, 2 product(s), 3 occurrence(s)');
    const flat = run(boxes(), 'export_step_exact', {}).result;
    expect(dataOf<{ assembly?: unknown }>(flat).assembly).toBeUndefined();
    expect(flat.summary).toContain('STEP AP214');
  });

  it('reports nothing exportable and a writer that fails as no-ops', () => {
    const empty = run(createEmptyDocument(), 'export_step_exact', {}).result;
    expect(empty.summary).toContain('nothing exported');
    expect(empty.data).toBeUndefined();
    const doc = boxes();
    const failed = run(doc, 'export_step_exact', {}, { writeStep: () => null }).result;
    expectNoOp(failed, doc);
  });
});

describe('geometric_validation_properties', () => {
  it('reports volume, area, centroid and box per solid, and combined instances under assemblies', () => {
    const { doc } = assemblyDoc();
    const { result } = run(doc, 'geometric_validation_properties', {});
    const data = dataOf<{
      unit: string;
      items: { id: string; volume: number; area: number; centroid: number[]; bbox: number[]; method: string }[];
      assemblies: { id: string; solids: number; volume: number }[];
    }>(result);
    expect(data.unit).toBe('mm');
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({ volume: 1, area: 6, centroid: [0, 0, -20], method: 'brep' });
    expect(data.items[0]?.bbox).toEqual([-0.5, -0.5, -20.5, 0.5, 0.5, -19.5]);
    expect(data.assemblies.map((entry) => entry.volume)).toEqual([1064, 1064]);
    expect(data.assemblies[0]?.solids).toBe(2);
    expect(result.summary).toContain('1 solid(s) and 2 assemblies');
    expect(result.document).toBe(doc);
  });

  it('can leave assemblies out, selects by id and lists what it skipped', () => {
    const { doc, instances } = assemblyDoc();
    const only = run(doc, 'geometric_validation_properties', { includeAssemblies: false }).result;
    expect(dataOf<{ assemblies: unknown[] }>(only).assemblies).toEqual([]);
    const picked = run(doc, 'geometric_validation_properties', { entityIds: [instances[0] as string, 'nope'] }).result;
    expect(dataOf<{ assemblies: unknown[]; skipped: string[] }>(picked)).toMatchObject({ skipped: ['nope (not found)'] });
    expect(picked.summary).toContain('Skipped nope (not found)');
  });

  it('falls back to closed forms without an exact kernel and refuses when nothing has a volume', () => {
    const doc = boxes();
    const bare = execute(doc, 'geometric_validation_properties', {}, ctxOf(null));
    const items = dataOf<{ items: { volume: number; method: string }[] }>(bare).items;
    expect(items[0]?.volume).toBeCloseTo(6000, 6);
    expect(items[0]?.method).toBe('closed-form');
    const none = execute(createEmptyDocument(), 'geometric_validation_properties', {}, ctxOf(null));
    expectNoOp(none, none.document);
    expect(none.summary).toContain('no 3D solid with a volume');
    const text = execute(
      execute(createEmptyDocument(), 'draw_line', { start: [0, 0], end: [1, 1] }).document,
      'geometric_validation_properties',
      { entityIds: ['x'] },
      ctxOf(null),
    );
    expect(text.data).toBeUndefined();
  });
});

describe('ply solids carrying a stepSlab (step-sheets behaviour through the XDE path)', () => {
  it('lists a ply solid whose exact slab the kernel refuses in data.faceted, and still writes it from its triangles', () => {
    const base = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 2] }).document;
    const id = base.order[0] as string;
    const box = base.entities[id] as unknown as Record<string, unknown>;
    const doc = {
      ...base,
      entities: {
        ...base.entities,
        [id]: {
          ...box,
          kind: 'mesh',
          mesh: TETRA,
          stepSlab: {
            op: 'faceSlab',
            surface: { type: 'plane', data: [0, 0, 0, 0, 0, 1] },
            loops: [4, 0, 0, 10, 0, 10, 10, 0, 10],
            from: 0,
            to: 2,
            direction: [0, 0, 1],
            tolerance: 1e-6,
          },
        },
      },
    } as unknown as CadDocument;
    const { result } = run(doc, 'export_step_exact', {});
    const data = result.data as { faceted: string[]; solidCount: number } | undefined;
    expect(data?.solidCount).toBe(1);
    expect(data?.faceted).toEqual([id]);
    expect(result.summary).toContain('written from triangles');
  });
});
