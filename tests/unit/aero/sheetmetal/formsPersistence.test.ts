import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { sheetMetalErrors } from '@aero/sheetmetal/validate';
import { folded, meshVolume } from './helpers';
import { apply } from '../../../helpers/commandAssertions';
import { plate } from './plates';

type Json = Record<string, unknown>;

/** A part with a flanged hole, a bead, a corner relief and a hem. */
function formedPart(): { doc: ReturnType<typeof plate>['doc']; part: string } {
  const { doc, part } = plate(120, 90);
  let next = apply(doc, 'add_flanged_hole', {
    id: part,
    face: { near: [40, 45, 0] },
    center: [40, 45, 0],
    holeDiameter: 30,
    flangeHeight: 4,
    flangeAngle: 90,
    lipRadius: 2,
  });
  next = apply(next, 'add_bead', {
    id: part,
    face: { near: [90, 45, 0] },
    path: [
      [90, 20, 0],
      [90, 70, 0],
    ],
    radius: 4,
    depth: 2,
    endShape: 'round',
  });
  next = apply(next, 'add_corner_relief', { id: part, corner: { near: [0, 0, 0] }, size: 5 });
  next = apply(next, 'add_hem', {
    id: part,
    edge: { near: [60, 90, 0] },
    hemType: 'open',
    gap: 3,
    length: 8,
    widthStart: 10,
    widthEnd: 10,
  });
  return { doc: next, part };
}

describe('persistence and validation of formed features', () => {
  it('round-trips flanged holes, beads, corner reliefs and hems and re-derives the identical folded solid', () => {
    const { doc, part } = formedPart();
    const text = serializeDocument(doc);
    const loaded = deserializeDocument(text);
    expect(loaded.sheetMetal).toEqual(doc.sheetMetal);
    expect(folded(loaded, part).brep).toEqual(folded(doc, part).brep);
    expect(meshVolume(loaded, part)).toBeCloseTo(meshVolume(doc, part), 9);
    expect(serializeDocument(loaded)).toBe(text);
    const types = Object.values((doc.sheetMetal?.parts[part] as { nodes: Record<string, { type: string }> }).nodes).map(
      (node) => node.type,
    );
    expect(types).toEqual(expect.arrayContaining(['form', 'corner_relief', 'hem']));
  });

  it.each<[string, string, string | undefined, (node: Json) => void, string]>([
    ['corner size', 'corner_relief', undefined, (node) => (node['size'] = 0), 'malformed corner relief'],
    ['corner point', 'corner_relief', undefined, (node) => (node['corner'] = 'x'), 'malformed corner relief'],
    ['hem type', 'hem', undefined, (node) => (node['hemType'] = 'teardrop'), 'malformed hem'],
    ['hem gap', 'hem', undefined, (node) => (node['gap'] = -1), 'malformed hem'],
    ['hem leg', 'hem', undefined, (node) => (node['length'] = 0), 'malformed hem'],
    ['form direction', 'form', 'bead', (node) => ((node['form'] as Json)['direction'] = 'left'), 'malformed form'],
    ['form kind', 'form', 'bead', (node) => ((node['form'] as Json)['kind'] = 'louver'), 'malformed form'],
    ['flanged hole angle', 'form', 'flanged_hole', (node) => ((node['form'] as Json)['angle'] = 3), 'malformed form'],
    ['bead end shape', 'form', 'bead', (node) => ((node['form'] as Json)['endShape'] = 'square'), 'malformed form'],
    ['form flat', 'form', 'bead', (node) => (node['on'] = 'b1'), 'malformed form'],
  ])('reports a malformed %s', (_label, type, kind, edit, message) => {
    const { doc } = formedPart();
    const slice = JSON.parse(JSON.stringify(doc.sheetMetal)) as Json;
    const nodes = (Object.values(slice['parts'] as Json)[0] as Json)['nodes'] as Record<string, Json>;
    const target = Object.values(nodes).find(
      (node) => node['type'] === type && (kind === undefined || (node['form'] as Json | undefined)?.['kind'] === kind),
    );
    expect(target).toBeDefined();
    expect(sheetMetalErrors(slice)).toEqual([]);
    edit(target as Json);
    expect(sheetMetalErrors(slice).join('\n')).toContain(message);
  });
});
