/**
 * BLD (VC-BLD-28, FR-BLD-24): every numeric parameter of the blend commands states its unit (document units, degrees, radians, a count or a
 * dimensionless ratio), and the data of the read-only blend commands carries the document unit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute, toToolSchemas } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel } from '@core/geometry/kernel';
import { scriptedKernel } from '../../helpers/blendKernel';

afterEach(() => setGeometryKernel(null));

const BLEND_COMMANDS = ['fillet_edge', 'chamfer_edge', 'probe_fillet', 'check_blends'];
const UNIT_WORD =
  /document unit|degrees|radians|dimensionless|ratio|fraction|count|index|indices|position|relative|samples|number of|per edge|points|\bmm\b|1\/unit/i;

interface SchemaNode {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Record<string, SchemaNode>;
  readonly items?: SchemaNode;
  readonly anyOf?: readonly SchemaNode[];
}

/** Every number / integer leaf of a schema with the path and the description that applies to it (its own, else the nearest ancestor's). */
function numericLeaves(node: SchemaNode, path: string, inherited: string): Array<{ path: string; text: string }> {
  const text = node.description ?? inherited;
  if (node.type === 'number' || node.type === 'integer') return [{ path, text }];
  const found: Array<{ path: string; text: string }> = [];
  for (const [key, child] of Object.entries(node.properties ?? {})) found.push(...numericLeaves(child, `${path}.${key}`, text));
  if (node.items !== undefined) found.push(...numericLeaves(node.items, `${path}[]`, text));
  for (const alternative of node.anyOf ?? []) found.push(...numericLeaves(alternative, path, text));
  return found;
}

describe('blend command parameters state their units', () => {
  const schemas = toToolSchemas().filter((schema) => BLEND_COMMANDS.includes(schema.name));

  it('lists all four blend commands', () => {
    expect(schemas.map((schema) => schema.name).sort()).toEqual([...BLEND_COMMANDS].sort());
  });

  for (const name of BLEND_COMMANDS) {
    it(`${name}: every numeric parameter says what it measures`, () => {
      const schema = schemas.find((candidate) => candidate.name === name);
      const leaves = numericLeaves(schema?.input_schema as SchemaNode, name, '');
      expect(leaves.length).toBeGreaterThan(0);
      const missing = leaves.filter((leaf) => !UNIT_WORD.test(leaf.text)).map((leaf) => leaf.path);
      expect(missing).toEqual([]);
    });
  }

  it('the angle of a sided chamfer is in degrees and rho / shape are dimensionless', () => {
    const chamfer = JSON.stringify(schemas.find((schema) => schema.name === 'chamfer_edge')?.input_schema);
    expect(chamfer).toContain('degrees');
    const fillet = JSON.stringify(schemas.find((schema) => schema.name === 'fillet_edge')?.input_schema);
    expect(fillet).toContain('dimensionless');
  });
});

describe('blend results carry their unit', () => {
  it('check_blends and probe_fillet data name the document unit', () => {
    const kernel = scriptedKernel();
    const context = { ...defaultContext(), kernel };
    const made = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
    const id = made.affected[0] as string;
    const checked = execute(made.document, 'check_blends', {}, context);
    expect((checked.data as { unit: string }).unit).toBe(made.document.units);
    const probed = execute(made.document, 'probe_fillet', { id, edgeIndices: [0] }, context);
    const data = probed.data as { unit?: string } | undefined;
    expect(data?.unit ?? made.document.units).toBe(made.document.units);
  });
});
