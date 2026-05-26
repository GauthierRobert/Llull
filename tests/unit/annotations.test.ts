/**
 * Unit tests for EN1 — MCP tool annotations.
 *
 * Covers:
 *   1. CommandDefinition.annotations fields are present on the right commands.
 *   2. toToolSchemas() emits `annotations` with the correct MCP hint names.
 *   3. buildMcpTools() mirrors toToolSchemas() annotations.
 *   4. readOnly commands return the SAME document reference (smoke test, table-driven).
 *   5. Unannotated commands produce no `annotations` field in toToolSchemas().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { listCommands, toToolSchemas, execute } from '@core/commands/registry';
import { buildMcpTools } from '@core/mcp/tools';
import { __resetIdCounter } from '@lib/id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSchema(name: string): ReturnType<typeof toToolSchemas>[number] {
  const schema = toToolSchemas().find((s) => s.name === name);
  if (!schema) throw new Error(`toToolSchemas: command '${name}' not found`);
  return schema;
}

function findTool(name: string): ReturnType<typeof buildMcpTools>[number] {
  const tool = buildMcpTools().find((t) => t.name === name);
  if (!tool) throw new Error(`buildMcpTools: tool '${name}' not found`);
  return tool;
}

function findCommand(name: string): ReturnType<typeof listCommands>[number] {
  const cmd = listCommands().find((c) => c.name === name);
  if (!cmd) throw new Error(`listCommands: command '${name}' not found`);
  return cmd;
}

// ---------------------------------------------------------------------------
// 1. CommandDefinition.annotations — presence and correctness
// ---------------------------------------------------------------------------

describe('CommandDefinition.annotations — readOnly commands', () => {
  const READ_ONLY_NAMES = [
    'measure_distance',
    'measure_angle',
    'measure_area',
    'measure_perimeter',
    'measure_bounding_box',
    'measure_volume',
    'mass_properties',
    'describe_scene',
    'check_model',
    'find_entities',
    'render_view',
  ] as const;

  for (const name of READ_ONLY_NAMES) {
    it(`${name} has annotations.readOnly === true`, () => {
      const cmd = findCommand(name);
      expect(cmd.annotations?.readOnly).toBe(true);
    });

    it(`${name} does not set destructive`, () => {
      const cmd = findCommand(name);
      expect(cmd.annotations?.destructive).toBeUndefined();
    });
  }
});

describe('CommandDefinition.annotations — destructive commands', () => {
  const DESTRUCTIVE_NAMES = ['delete_entity', 'delete_layer', 'delete_parameter'] as const;

  for (const name of DESTRUCTIVE_NAMES) {
    it(`${name} has annotations.destructive === true`, () => {
      const cmd = findCommand(name);
      expect(cmd.annotations?.destructive).toBe(true);
    });

    it(`${name} does not set readOnly`, () => {
      const cmd = findCommand(name);
      expect(cmd.annotations?.readOnly).toBeUndefined();
    });
  }
});

describe('CommandDefinition.annotations — idempotent commands', () => {
  const IDEMPOTENT_NAMES = [
    'set_units',
    'set_parameter',
    'rename_layer',
    'set_layer_visibility',
    'set_layer_lock',
    'set_entity_layer',
    'set_entity_name',
    'stop_animation',
  ] as const;

  for (const name of IDEMPOTENT_NAMES) {
    it(`${name} has annotations.idempotent === true`, () => {
      const cmd = findCommand(name);
      expect(cmd.annotations?.idempotent).toBe(true);
    });
  }
});

describe('CommandDefinition.annotations — unannotated command', () => {
  it('add_box has no annotations field', () => {
    const cmd = findCommand('add_box');
    expect(cmd.annotations).toBeUndefined();
  });

  it('move_entity has no annotations field', () => {
    const cmd = findCommand('move_entity');
    expect(cmd.annotations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. toToolSchemas() — annotations surfaced as MCP hint names
// ---------------------------------------------------------------------------

describe('toToolSchemas() — annotations on readOnly command', () => {
  it('measure_distance schema has annotations.readOnlyHint === true', () => {
    const schema = findSchema('measure_distance');
    expect(schema.annotations?.readOnlyHint).toBe(true);
  });

  it('measure_distance schema does not have destructiveHint', () => {
    const schema = findSchema('measure_distance');
    expect(schema.annotations?.destructiveHint).toBeUndefined();
  });

  it('describe_scene schema has annotations.readOnlyHint === true', () => {
    expect(findSchema('describe_scene').annotations?.readOnlyHint).toBe(true);
  });
});

describe('toToolSchemas() — annotations on destructive command', () => {
  it('delete_entity schema has annotations.destructiveHint === true', () => {
    const schema = findSchema('delete_entity');
    expect(schema.annotations?.destructiveHint).toBe(true);
  });

  it('delete_entity schema does not have readOnlyHint', () => {
    expect(findSchema('delete_entity').annotations?.readOnlyHint).toBeUndefined();
  });

  it('delete_layer schema has annotations.destructiveHint === true', () => {
    expect(findSchema('delete_layer').annotations?.destructiveHint).toBe(true);
  });
});

describe('toToolSchemas() — annotations on idempotent command', () => {
  it('set_units schema has annotations.idempotentHint === true', () => {
    expect(findSchema('set_units').annotations?.idempotentHint).toBe(true);
  });

  it('set_entity_name schema has annotations.idempotentHint === true', () => {
    expect(findSchema('set_entity_name').annotations?.idempotentHint).toBe(true);
  });
});

describe('toToolSchemas() — no annotations on plain command', () => {
  it('add_box schema has no annotations field', () => {
    const schema = findSchema('add_box');
    expect(schema.annotations).toBeUndefined();
  });

  it('extrude_profile schema has no annotations field', () => {
    const schema = findSchema('extrude_profile');
    expect(schema.annotations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. buildMcpTools() — mirrors toToolSchemas() annotations
// ---------------------------------------------------------------------------

describe('buildMcpTools() — annotations on readOnly command', () => {
  it('measure_distance tool has annotations.readOnlyHint === true', () => {
    expect(findTool('measure_distance').annotations?.readOnlyHint).toBe(true);
  });

  it('check_model tool has annotations.readOnlyHint === true', () => {
    expect(findTool('check_model').annotations?.readOnlyHint).toBe(true);
  });
});

describe('buildMcpTools() — annotations on destructive command', () => {
  it('delete_entity tool has annotations.destructiveHint === true', () => {
    expect(findTool('delete_entity').annotations?.destructiveHint).toBe(true);
  });

  it('delete_parameter tool has annotations.destructiveHint === true', () => {
    expect(findTool('delete_parameter').annotations?.destructiveHint).toBe(true);
  });
});

describe('buildMcpTools() — annotations on idempotent command', () => {
  it('set_units tool has annotations.idempotentHint === true', () => {
    expect(findTool('set_units').annotations?.idempotentHint).toBe(true);
  });

  it('rename_layer tool has annotations.idempotentHint === true', () => {
    expect(findTool('rename_layer').annotations?.idempotentHint).toBe(true);
  });
});

describe('buildMcpTools() — no annotations on plain command', () => {
  it('add_box tool has no annotations field', () => {
    expect(findTool('add_box').annotations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. readOnly commands return the SAME document reference (smoke, table-driven)
// ---------------------------------------------------------------------------

describe('readOnly commands — document reference unchanged', () => {
  beforeEach(() => __resetIdCounter());

  const READ_ONLY_CASES: Array<[string, Record<string, unknown>]> = [
    ['describe_scene', {}],
    ['check_model', {}],
    ['find_entities', {}],
    ['measure_distance', { point1: [0, 0, 0], point2: [1, 0, 0] }],
    ['measure_angle', { points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }],
    ['measure_bounding_box', {}],
  ];

  for (const [name, params] of READ_ONLY_CASES) {
    it(`${name}: result.document === input doc (same reference)`, () => {
      const doc = createEmptyDocument();
      const result = execute(doc, name, params);
      expect(result.document).toBe(doc);
    });

    it(`${name}: affected is empty`, () => {
      const doc = createEmptyDocument();
      const result = execute(doc, name, params);
      expect(result.affected).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Annotation count invariant — every annotated command has at least one hint
// ---------------------------------------------------------------------------

describe('annotations invariant', () => {
  it('every command with annotations has at least one flag set to true', () => {
    for (const cmd of listCommands()) {
      if (!cmd.annotations) continue;
      const { readOnly, destructive, idempotent } = cmd.annotations;
      const atLeastOne = readOnly === true || destructive === true || idempotent === true;
      expect(atLeastOne, `${cmd.name} has an annotations object but no flag is true`).toBe(true);
    }
  });

  it('no command is both readOnly and destructive', () => {
    for (const cmd of listCommands()) {
      if (!cmd.annotations) continue;
      expect(
        cmd.annotations.readOnly === true && cmd.annotations.destructive === true,
        `${cmd.name} is marked both readOnly and destructive`,
      ).toBe(false);
    }
  });

  it('toToolSchemas() annotation keys map correctly from CommandDefinition flags', () => {
    const schemas = toToolSchemas();
    for (const cmd of listCommands()) {
      const schema = schemas.find((s) => s.name === cmd.name)!;
      if (cmd.annotations?.readOnly) {
        expect(schema.annotations?.readOnlyHint).toBe(true);
      }
      if (cmd.annotations?.destructive) {
        expect(schema.annotations?.destructiveHint).toBe(true);
      }
      if (cmd.annotations?.idempotent) {
        expect(schema.annotations?.idempotentHint).toBe(true);
      }
    }
  });
});
