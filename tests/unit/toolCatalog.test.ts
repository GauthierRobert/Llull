/** The CLI tool catalog (`@protocol`): command tools from the registry, tool search (`llull search`), toolsets, guide text. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { listCommands } from '@core/commands/registry';
import {
  buildAllTools,
  buildCommandTools,
  buildExchangeToolDefinitions,
  buildFeaToolDefinitions,
  buildLibraryToolDefinitions,
  searchTools,
  toolsetOf,
  TOOLSET_NAMES,
  TOOLSETS,
} from '@protocol/index';
import { CONVENTIONS_GUIDE } from '@protocol/conventions';
import { applyToolCall } from '../helpers/applyToolCall';
import { expectPure } from '../helpers/expectNoOp';

describe('buildCommandTools()', () => {
  it('one tool per command, in registry order', () => {
    const tools = buildCommandTools();
    expect(tools.map((t) => t.name)).toEqual(listCommands().map((c) => c.name));
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect('input_schema' in tool).toBe(false);
    }
  });
});

describe('applyToolCall()', () => {
  it('runs a known command: new document, affected ids, summary + affected content blocks', () => {
    const doc = createEmptyDocument();
    const r = applyToolCall(doc, 'add_box', { size: [2, 2, 2] });
    expect(r.isError).toBe(false);
    expect(r.document).not.toBe(doc);
    expect(r.document.order).toEqual(r.affected);
    expect(r.document.entities[r.affected[0]!]!.kind).toBe('box');
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/box/i) });
    expect(r.content[1]!.text).toMatch(/Affected entity ids:/);
    expectPure(doc, () => applyToolCall(doc, 'add_box', { size: [3, 3, 3] }));
  });

  it('reports an unknown tool as an error, unchanged and purely', () => {
    const doc = createEmptyDocument();
    const r = applyToolCall(doc, 'nonexistent_tool', {});
    expect([r.isError, r.document, r.affected]).toEqual([true, doc, []]);
    expect(r.content[0]!.text).toMatch(/unknown command/i);
    expectPure(doc, () => applyToolCall(doc, 'unknown_xyz', {}));
  });
});

const ranked = (query: string, count = 3): string[] => searchTools(query, count).map((hit) => hit.name);

describe('searchTools on natural phrasing', () => {
  it.each([
    ['cut a hole', 'boolean'],
    ['make a hole in a plate', 'add_hole'],
    ['round the edges', 'fillet_edge'],
    ['bevel the edges', 'chamfer_edge'],
    ['how heavy is it', 'mass_properties'],
    ['take a picture', 'render_view'],
    ['copy an entity many times in a row', 'duplicate_entities'],
    ['export to STEP', 'export_step'],
    ['measure distance between two points', 'measure_distance'],
  ])('"%s" finds %s in the top results', (query, expected) => {
    expect(ranked(query, 4)).toContain(expected);
  });
  it('ignores stopwords and one-letter words, so filler cannot match tools', () => {
    expect(ranked('a the of to')).toEqual([]);
    expect(ranked('a')).toEqual([]);
  });
  it('is plural-insensitive', () => {
    expect(ranked('fillets')).toEqual(ranked('fillet'));
    expect(ranked('edges')[0]).toBe(ranked('edge')[0]);
  });
});

describe('searchTools ranking regression table', () => {
  it.each<[string, string, string[]]>([
    ['pressure drop', 'pipe_hydraulics', []],
    ['pipe pressure drop', 'pipe_hydraulics', []],
    ['cut and fill', 'platform_earthworks', []],
    ['cut fill volume', 'platform_earthworks', []],
    ['stress plot', 'render_fea_results', []],
    ['natural frequency', 'create_analysis', []],
    ['export step', 'export_step', []],
    ['fillet', 'fillet_edge', ['fillet_2d']],
    ['wall', 'draw_walls', []],
    ['make a hole in a plate', 'add_hole', []],
    ['how heavy is it', 'mass_properties', []],
    ['take a picture', 'render_view', []],
    ['measure distance between two points', 'measure_distance', []],
    ['simulate a pendulum', 'simulate_motion', []],
    ['hydraulic', 'pipe_hydraulics', []],
  ])('"%s" ranks %s first (and keeps %j in the top 3)', (query, first, alsoTop) => {
    const top = ranked(query);
    expect(top[0]).toBe(first);
    for (const name of alsoTop) expect(top).toContain(name);
  });

  it('does not let "fill" match "fillet" tools', () => {
    expect(ranked('cut fill volume', 10)).not.toContain('fillet_edge');
    expect(ranked('cut and fill', 10)).not.toContain('fillet_2d');
  });

  it('keeps pressure-drop hits out of unrelated pressure tools first', () => {
    expect(ranked('pressure drop', 2)[0]).toBe('pipe_hydraulics');
  });

  it('does not rank natural-frequency queries onto animation or surface tools above the analysis tools', () => {
    // sdof_response (PHY-09 quick check: natural frequency fnHz) is an analysis tool too.
    expect(ranked('natural frequency', 2)).toEqual(['create_analysis', 'sdof_response']);
  });
});

describe('searchTools', () => {
  it('ranks name matches first and reports the toolset', () => {
    const results = searchTools('wall', 5);
    expect(results[0]?.name).toMatch(/wall/);
    const wall = results.find((r) => r.name === 'draw_walls');
    expect(wall).toMatchObject({ toolset: 'building' });
    expect(wall?.description.length).toBeGreaterThan(0);
  });
  it('covers exchange tools', () => {
    expect(searchTools('export step', 5).find((r) => r.name === 'export_step')).toMatchObject({ toolset: 'exchange' });
  });
  it('honours limit and returns nothing for unmatched queries', () => {
    expect(searchTools('add', 3)).toHaveLength(3);
    expect(searchTools('zzzqqq', 5)).toEqual([]);
    expect(searchTools('!!!', 5)).toEqual([]);
  });
});

const allToolNames = [
  ...listCommands().map((command) => command.name),
  ...buildExchangeToolDefinitions().map((tool) => tool.name),
  ...buildFeaToolDefinitions().map((tool) => tool.name),
  ...buildLibraryToolDefinitions().map((tool) => tool.name),
  // server-side native transport listed in the analysis toolset (server/src/native/tools.ts; covered by server/tests/topologySolve.test.ts)
  'topology_solve',
  // server-side native transport listed in the piping toolset (server/src/native/autoRoute.ts; covered by server/tests/routeNativeParity.test.ts)
  'auto_route',
  // point-cloud host transports listed in the scan toolset (server/src/scan/scanTools.ts; covered by server/tests/scanImport.test.ts)
  'scan_import',
  'scan_list',
];

describe('TOOLSETS', () => {
  it('assigns every tool to exactly one toolset', () => {
    for (const name of allToolNames) {
      const owners = TOOLSET_NAMES.filter((toolset) => TOOLSETS[toolset].includes(name));
      expect(owners, name).toHaveLength(1);
    }
  });
  it('lists only real tool names', () => {
    const known = new Set(allToolNames);
    for (const toolset of TOOLSET_NAMES) {
      for (const name of TOOLSETS[toolset]) expect(known.has(name), name).toBe(true);
    }
  });
  it('places building commands in the building toolset and leaves unknown names unplaced', () => {
    expect(toolsetOf('draw_walls')).toBe('building');
    expect(toolsetOf('import_step')).toBe('exchange');
    expect(toolsetOf('not_a_tool')).toBeUndefined();
  });
  it('puts industrial piping in its own toolset (add_hole stays with the FTR manufacturing set)', () => {
    expect(toolsetOf('add_hole')).toBe('manufacturing');
    for (const name of ['pipe_hydraulics', 'add_pipe_run', 'add_pipe_support', 'check_pipe_supports', 'add_cable_tray']) {
      expect(toolsetOf(name)).toBe('piping');
    }
    expect(TOOLSETS.building).not.toContain('pipe_hydraulics');
  });
});

describe('backticked names in the conventions guide', () => {
  it('mentions only real tools and parameters (or document fields)', () => {
    const tools = buildAllTools();
    const known = new Set<string>(tools.map((tool) => tool.name));
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      Object.keys(schema.properties ?? {}).forEach((name) => known.add(name));
    }
    // Plan fields, result fields and document-level literals the guide explains, which are not command parameters.
    const explained = new Set(['actions', 'as', 'command', 'params', 'affected', 'summary', 'data', 'units', 'mm', 'cm', 'm', 'in', 'ft']);
    const stale = [...CONVENTIONS_GUIDE.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)]
      .map((match) => match[1] ?? '')
      .filter((word) => !known.has(word) && !explained.has(word));
    expect([...new Set(stale)]).toEqual([]);
  });
});
