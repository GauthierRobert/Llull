/** Contract of the `fasteners` plugin (08 MAT): toolset membership, registry/tool-schema 1:1, persistence round trip and load validation. */
import { beforeAll, describe, expect, it } from 'vitest';
import { getCommand, listCommands, toToolSchemas } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { pluginToolNames } from '@core/plugins/host';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { TOOLSETS, toolsetOf } from '@mcp/toolsets';
import { ctxWith, docWith, inchDocument, ok, sampleCatalogFile } from '../aero/fasteners/fixtures';

const NAMES = [
  'import_fastener_catalog',
  'list_fastener_families',
  'decode_part_number',
  'select_fastener',
  'insert_fastener_stack',
  'insert_fastener_row',
  'check_fastener_layout',
  'delete_fastener_stack',
  'joint_capacity',
];

describe('fasteners toolset', () => {
  it('is contributed by the plugin and every command is registered and exposed as a tool', () => {
    expect(pluginToolNames('fasteners')).toEqual(NAMES);
    expect([...TOOLSETS.fasteners]).toEqual(NAMES);
    for (const name of NAMES) {
      expect(getCommand(name), name).toBeDefined();
      expect(toolsetOf(name)).toBe('fasteners');
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    const tools = toToolSchemas().map((tool) => tool.name);
    for (const name of NAMES) expect(tools).toContain(name);
    expect(tools.length).toBe(listCommands().length);
  });

  it('describes units for every quantity param and marks the query / kernel annotations', () => {
    const quantities: Array<[string, string]> = [
      ['select_fastener', 'stack'],
      ['select_fastener', 'maxWasherTotal'],
      ['insert_fastener_stack', 'holeDiameter'],
      ['insert_fastener_row', 'pitch'],
      ['insert_fastener_row', 'edgeDistance'],
    ];
    for (const [name, param] of quantities) {
      const unit = getCommand(name)?.paramsSchema.properties[param]?.properties?.['unit'];
      expect(unit?.description, `${name}.${param}`).toContain('unit');
    }
    for (const name of ['list_fastener_families', 'decode_part_number', 'select_fastener', 'check_fastener_layout'])
      expect(getCommand(name)?.annotations?.readOnly, name).toBe(true);
    for (const name of ['insert_fastener_stack', 'insert_fastener_row'])
      expect(getCommand(name)?.annotations?.requiresKernel, name).toBe(true);
    expect(getCommand('delete_fastener_stack')?.annotations?.destructive).toBe(true);
  });
});

describe('persistence of the fasteners slice', () => {
  let kernel: GeometryKernel;
  let doc: CadDocument;
  beforeAll(async () => {
    kernel = await createManifoldKernel();
    const base = docWith(sampleCatalogFile(), inchDocument());
    const first = ok(base, 'add_box', { size: [2, 1, 0.25], anchor: 'min', position: [0, 0, 0] });
    const second = ok(first.document, 'add_box', { size: [2, 1, 0.26], anchor: 'min', position: [0, 0, 0.25] });
    doc = ok(
      second.document,
      'insert_fastener_stack',
      {
        family: 'NAS6203-6220',
        diameterDash: '3',
        stackIds: [first.affected[0], second.affected[0]],
        axisPoint: [1, 0.5, 0],
        nut: 'MS21042',
        washer: 'NAS1149',
        holeDiameter: { value: 0.19, unit: 'in' },
      },
      ctxWith(kernel),
    ).document;
  });

  it('round-trips catalogues, stacks, components and instances exactly', () => {
    const json = serializeDocument(doc);
    const loaded = deserializeDocument(json);
    expect(loaded.fasteners).toEqual(doc.fasteners);
    expect(loaded.components).toEqual(doc.components);
    expect(Object.keys(loaded.entities).sort()).toEqual(Object.keys(doc.entities).sort());
    expect(serializeDocument(loaded)).toBe(json);
  });

  it('loads documents without a fasteners slice and rejects a corrupt one naming the field', () => {
    const envelope = JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> };
    const withoutSlice = structuredClone(envelope);
    delete withoutSlice.document['fasteners'];
    expect(deserializeDocument(JSON.stringify(withoutSlice)).fasteners).toBeUndefined();

    const mutated = (change: (slice: Record<string, Record<string, Record<string, unknown>>>) => void): string => {
      const copy = structuredClone(envelope);
      change(copy.document['fasteners'] as Record<string, Record<string, Record<string, unknown>>>);
      return JSON.stringify(copy);
    };
    const stackId = Object.keys(doc.fasteners?.stacks ?? {})[0] as string;
    expect(() => deserializeDocument(mutated((slice) => delete slice['catalogs']?.['NAS6203-6220']?.['provenance']))).toThrow(
      /fasteners\.catalogs\.NAS6203-6220/,
    );
    expect(() =>
      deserializeDocument(
        mutated(
          (slice) =>
            (slice['stacks'] as Record<string, Record<string, unknown>>)[stackId] &&
            ((slice['stacks'] as Record<string, Record<string, unknown>>)[stackId]!['holeMode'] = 'drill'),
        ),
      ),
    ).toThrow(/holeMode/);
    expect(() =>
      deserializeDocument(mutated((slice) => ((slice['stacks'] as Record<string, Record<string, unknown>>)[stackId]!['layers'] = []))),
    ).toThrow(/layers/);
    expect(() =>
      deserializeDocument(
        mutated(
          (slice) =>
            ((slice['stacks'] as Record<string, Record<string, Record<string, unknown>>>)[stackId]!['fastener']!['instanceId'] = 'ghost'),
        ),
      ),
    ).toThrow(/missing instance 'ghost'/);
    expect(() =>
      deserializeDocument(
        mutated(
          (slice) =>
            ((slice['catalogs'] as Record<string, Record<string, unknown>>)['other'] = { ...slice['catalogs']?.['HL19'] } as never),
        ),
      ),
    ).toThrow(/must equal its key/);
    expect(() => deserializeDocument(JSON.stringify({ ...envelope, document: { ...envelope.document, fasteners: 'x' } }))).toThrow(
      /fasteners must be/,
    );
    expect(() => deserializeDocument(mutated((slice) => ((slice['stacks'] as Record<string, unknown>)['bad'] = 3 as never)))).toThrow(
      /fasteners\.stacks\.bad must be an object/,
    );
    expect(() =>
      deserializeDocument(mutated((slice) => ((slice['stacks'] as Record<string, unknown>)['fst-9.9'] = { id: 'other' } as never))),
    ).toThrow(/must equal its key/);
  });
});
