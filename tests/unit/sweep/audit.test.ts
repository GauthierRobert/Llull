/** VC-SWG-30: every numeric parameter of the SWG commands states its unit (or that it is dimensionless), and their results carry `unit`. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { execute, listCommands, toToolSchemas } from '@core/commands/registry';

const NEW_COMMANDS = ['ruled_surface', 'sweep_surface', 'network_surface'];
const SWG_COMMANDS = [...NEW_COMMANDS, 'check_sweep_loft', 'inspect_sweep', 'loft_sections', 'loft_surface', 'sweep_profile', 'add_helix'];
/** Parameters this pack added to existing commands (their older numeric parameters were audited with their own packs). */
const NEW_PARAMS: Readonly<Record<string, readonly string[]>> = {
  check_sweep_loft: ['endAngleRad'],
  loft_sections: [
    'startCondition',
    'endCondition',
    'seams',
    'vertexPairs',
    'sectionCount',
    'guideTolerance',
    'fitTolerance',
    'endAngleRad',
  ],
  loft_surface: ['startCondition', 'endCondition', 'seams', 'vertexPairs', 'fitTolerance', 'endAngleRad'],
  sweep_profile: ['railTolerance', 'anchors', 'fitTolerance', 'orientation', 'lawParameter'],
};
/** A description names its unit, or says the number is a count, an index, a fraction, a ratio or a factor. */
const UNIT_WORDS =
  /unit|radian|degree|\brad\b|fraction|ratio|dimensionless|integer|count|number of|index|turns|factor|metre|speed|1\/|section coordinates|\[x, y, z\]|\[x, y\]/i;

interface Property {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Record<string, Property>;
  readonly items?: Property;
}

function numbersWithoutUnit(property: Property, path: string, inherited: string): string[] {
  const own = property.description ?? '';
  const missing: string[] = [];
  if (property.type === 'number' && !UNIT_WORDS.test(own) && !UNIT_WORDS.test(inherited)) missing.push(path);
  for (const [name, child] of Object.entries(property.properties ?? {}))
    missing.push(...numbersWithoutUnit(child, `${path}.${name}`, own || inherited));
  if (property.items !== undefined) missing.push(...numbersWithoutUnit(property.items, `${path}[]`, own || inherited));
  return missing;
}

describe('SWG tool surface (VC-SWG-30)', () => {
  const schemas = toToolSchemas();
  it('every numeric parameter of the new commands, and the new parameters of the extended ones, names its unit or its dimensionless nature', () => {
    const missing = SWG_COMMANDS.flatMap((name) => {
      const tool = schemas.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      const input = tool?.input_schema as unknown as Property;
      const fields = NEW_COMMANDS.includes(name) ? Object.keys(input.properties ?? {}) : (NEW_PARAMS[name] ?? []);
      return fields.flatMap((field) => numbersWithoutUnit((input.properties ?? {})[field] ?? {}, `${name}.${field}`, ''));
    });
    expect(missing).toEqual([]);
  });
  it('every SWG tool has a description that is self-sufficient (long, mentions its next step) and every property is described', () => {
    for (const name of SWG_COMMANDS) {
      const tool = schemas.find((t) => t.name === name);
      expect((tool?.description ?? '').length, name).toBeGreaterThan(200);
      const props = (tool?.input_schema as unknown as Property).properties ?? {};
      for (const [prop, spec] of Object.entries(props)) expect(spec.description, `${name}.${prop}`).toBeTruthy();
    }
  });
  it('the registry lists each SWG command once', () => {
    const names = listCommands().map((c) => c.name);
    for (const name of SWG_COMMANDS) expect(names.filter((n) => n === name)).toHaveLength(1);
  });
  it('results that carry numbers carry the document unit', () => {
    const doc = createEmptyDocument();
    const a = execute(doc, 'interpolate_curve', {
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      degree: 1,
    });
    const b = execute(a.document, 'interpolate_curve', {
      points: [
        [0, 1, 0],
        [1, 1, 1],
      ],
      degree: 1,
    });
    const ruled = execute(b.document, 'ruled_surface', { curveIds: [a.affected[0], b.affected[0]] });
    expect((ruled.data as { unit: string }).unit).toBe('mm');
    const helix = execute(doc, 'add_helix', { radius: 10, pitch: 5, turns: 2 });
    const swept = execute(helix.document, 'sweep_surface', {
      pathId: helix.affected[0],
      section: {
        line: [
          [0, 0],
          [2, 0],
        ],
      },
    });
    expect((swept.data as { unit: string }).unit).toBe('mm');
  });
});
