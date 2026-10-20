import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { BASE, ROSETTE, T300, panelPart, withMaterials } from './fixtures';

const part = panelPart();

describe('create_lamina_material (VC-CMP-31)', () => {
  it('stores the record, replaces by name and keeps source and basis through save and load', () => {
    const doc = withMaterials();
    const model = doc.composites?.materials['T300_5208'];
    expect(model).toMatchObject({ E1: 181000, basis: 'b_basis', source: T300.source });
    const replaced = ok(doc, 'create_lamina_material', { ...T300, E1: 182000 });
    expect(replaced.summary).toContain('replaced');
    expect(replaced.affected).toEqual(['T300_5208']);
    const loaded = deserializeDocument(serializeDocument(replaced.document));
    expect(loaded.composites?.materials['T300_5208']).toMatchObject({ E1: 182000, basis: 'b_basis', source: T300.source });
  });

  it('rejects nu12 beyond the positive-definite bound and accepts it below', () => {
    const base = { name: 'iso', form: 'ud_tape', E1: 10000, E2: 10000, G12: 4000, plyThickness: 0.1, source: 'test' };
    expectRefusal(
      createEmptyDocument(),
      'create_lamina_material',
      { ...base, nu12: 1.1 },
      'CMP_MATERIAL_NOT_POSITIVE_DEFINITE',
      'params.nu12',
    );
    expect(execute(createEmptyDocument(), 'create_lamina_material', { ...base, nu12: 0.9 }).rejected).toBeUndefined();
    expect(execute(createEmptyDocument(), 'create_lamina_material', { ...base, E2: 10.3, E1: 181, nu12: 4.1 }).rejected).toBeUndefined();
  });

  it('rejects non-positive values and a Tsai-Wu F12* out of range', () => {
    const doc = createEmptyDocument();
    const refused = expectRefusal(doc, 'create_lamina_material', { ...T300, E2: 0, plyThickness: -1 }, 'CMP_MATERIAL_NOT_POSITIVE');
    expect(refused.error?.paths).toEqual(['params.E2', 'params.plyThickness']);
    expectRefusal(doc, 'create_lamina_material', { ...T300, tsaiWuF12Star: 0.5 }, 'CMP_F12_RANGE');
    expect(execute(doc, 'create_lamina_material', { ...T300, tsaiWuF12Star: -1 }).rejected).toBeUndefined();
  });

  it('defaults basis to unknown, which marks the record unverified in analyses', () => {
    const rest = Object.fromEntries(Object.entries(T300).filter(([key]) => key !== 'basis'));
    const doc = apply(createEmptyDocument(), 'create_lamina_material', { ...rest, name: 'mystery' });
    expect(doc.composites?.materials['mystery']?.basis).toBe('unknown');
    expect(data<{ unverified: boolean }>(doc, 'analyze_laminate', { angles: [0, 90], material: 'mystery' }).unverified).toBe(true);
  });

  it('is pure', () => {
    const doc = createEmptyDocument();
    expectPure(doc, () => execute(doc, 'create_lamina_material', T300));
  });
});

describe('define_rosette', () => {
  it('stores unit vectors and re-orthogonalises the 0-degree axis against the normal', () => {
    const result = ok(createEmptyDocument(), 'define_rosette', { ...ROSETTE, axis0: [3, 0, 4] });
    const rosette = result.document.composites?.rosettes[result.affected[0] as string];
    expect(rosette?.normal).toEqual([0, 0, 1]);
    expect(rosette?.axis0).toEqual([1, 0, 0]);
    expect(rosette?.method).toBe('translational');
  });

  it('refuses a degenerate frame', () => {
    const doc = createEmptyDocument();
    expectRefusal(doc, 'define_rosette', { ...ROSETTE, axis0: [0, 0, 5] }, 'CMP_ROSETTE_DEGENERATE');
    expectRefusal(doc, 'define_rosette', { ...ROSETTE, axis0: [0, 0, 0] }, 'CMP_ROSETTE_DEGENERATE');
    expectRefusal(doc, 'define_rosette', { ...ROSETTE, normal: [0, 0, 0] }, 'CMP_ROSETTE_DEGENERATE');
  });
});

describe('create_composite_part', () => {
  const tool = (doc: CadDocument, id: string): string => (doc.entities[id] ? id : '');

  it('puts the part frame on the top face of a block: zone coordinates equal world x, y', () => {
    const created = part.doc.composites?.parts[part.part];
    expect(created?.surface.type).toBe('plane');
    expect(created?.outline).toEqual([
      [0, 0],
      [600, 0],
      [600, 400],
      [0, 400],
    ]);
    expect(created?.toolFaces[0]).toMatchObject({ entityId: tool(part.doc, part.tool), faceNear: [300, 200, 0] });
    expect(created?.laminateSide).toBe('positive_normal');
  });

  it('re-bases the frame on a rotated rosette and on a side face', () => {
    const turned = apply(part.doc, 'define_rosette', { name: 'R90', origin: [10, 20, 0], axis0: [0, 1, 0], normal: [0, 0, 1] });
    const next = ok(turned, 'create_composite_part', {
      name: 'Turned',
      toolSurface: { entityId: part.tool, faceNear: [300, 200, 0] },
      rosette: 'R90',
    });
    const outline = next.document.composites?.parts[next.affected[0] as string]?.outline;
    // frame x = world +y, y = n x x = -world x, origin (10, 20): world corner (0, 0) -> (-20, 10)
    expect(outline?.[0]?.[0]).toBeCloseTo(-20, 9);
    expect(outline?.[0]?.[1]).toBeCloseTo(10, 9);
    const withZ = apply(part.doc, 'define_rosette', { name: 'Rz', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0] });
    const side = ok(withZ, 'create_composite_part', {
      name: 'Side',
      rosette: 'Rz',
      toolSurface: { entityId: part.tool, faceNear: [600, 200, -5] },
    });
    expect(side.document.composites?.parts[side.affected[0] as string]?.surface.type).toBe('plane');
  });

  it('resolves a rotated block through its entity frame', () => {
    let doc = apply(withMaterials(), 'define_rosette', { name: 'Rz', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0] });
    const box = ok(doc, 'add_box', { size: [10, 20, 30], position: [0, 0, 0], rotation: [0, Math.PI / 2, 0] });
    doc = box.document;
    // Rotating +z to +x about y: the old top face now looks along +x at x = 15.
    const made = ok(doc, 'create_composite_part', {
      name: 'Rot',
      rosette: 'Rz',
      toolSurface: { entityId: box.affected[0], faceNear: [15, 0, 0] },
    });
    const surface = made.document.composites?.parts[made.affected[0] as string]?.surface;
    expect(surface?.type).toBe('plane');
    expect(surface?.type === 'plane' ? surface.normal.map((c) => Math.round(c) + 0) : null).toEqual([1, 0, 0]);
  });

  it('refuses missing references, unresolvable points and duplicate names', () => {
    const { doc, tool: toolId } = part;
    const face = { entityId: toolId, faceNear: [300, 200, 0] };
    expectRefusal(
      doc,
      'create_composite_part',
      { name: 'X', toolSurface: { ...face, entityId: 'nope' }, rosette: 'R0' },
      'CMP_REF_MISSING',
    );
    expectRefusal(doc, 'create_composite_part', { name: 'X', toolSurface: face, rosette: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(
      doc,
      'create_composite_part',
      { name: 'X', toolSurface: { ...face, faceNear: [300, 200, 500] }, rosette: 'R0' },
      'CMP_FACE_NOT_FOUND',
    );
    expectRefusal(
      doc,
      'create_composite_part',
      { name: 'X', toolSurface: { ...face, faceNear: [0, 0, 0] }, rosette: 'R0' },
      'CMP_FACE_AMBIGUOUS',
    );
    expectRefusal(doc, 'create_composite_part', { name: 'Skin panel', toolSurface: face, rosette: 'R0' }, 'CMP_NAME_TAKEN');
    expectRefusal(doc, 'create_composite_part', { name: 'X', toolSurface: face, rosette: 'R0', arcTolerance: 0 }, 'CMP_PARAM_INVALID');
    const vertical = apply(doc, 'define_rosette', { name: 'Rz', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0] });
    expectRefusal(vertical, 'create_composite_part', { name: 'X', toolSurface: face, rosette: 'Rz' }, 'CMP_ROSETTE_DEGENERATE');
  });

  it('refuses solids that need the OCC kernel on a mesh kernel', () => {
    let doc = apply(withMaterials(), 'define_rosette', ROSETTE);
    const sphere = ok(doc, 'add_torus', { ringRadius: 10, tubeRadius: 3 });
    doc = sphere.document;
    expectRefusal(
      doc,
      'create_composite_part',
      { name: 'S', rosette: 'R0', toolSurface: { entityId: sphere.affected[0], faceNear: [0, 0, 10] } },
      'CMP_FACE_UNSUPPORTED',
    );
  });

  it('is pure', () => {
    expectPure(part.doc, () =>
      execute(part.doc, 'create_composite_part', {
        name: 'P2',
        rosette: 'R0',
        toolSurface: { entityId: part.tool, faceNear: [300, 200, 0] },
      }),
    );
  });
});

describe('zones', () => {
  const zoned = apply(part.doc, 'define_zone', { part: part.part, ...BASE });
  const zoneId = Object.keys(zoned.composites?.zones ?? {})[0] as string;

  it('defines, edits and deletes a zone', () => {
    const zone = zoned.composites?.zones[zoneId];
    expect(zone?.angles).toEqual([45, -45, 0, 90, 90, 0, -45, 45]);
    expect(zone?.priority).toBe(0);
    const edited = ok(zoned, 'edit_zone', {
      part: 'Skin panel',
      zone: 'Z-base',
      name: 'Z-1',
      laminate: '[0/90]s',
      priority: 3,
      boundary: [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
    });
    expect(edited.affected).toEqual([zoneId]);
    expect(edited.document.composites?.zones[zoneId]).toMatchObject({ name: 'Z-1', angles: [0, 90, 90, 0], priority: 3 });
    const removed = ok(edited.document, 'delete_zone', { part: part.part, zone: 'Z-1' });
    expect(Object.keys(removed.document.composites?.zones ?? {})).toEqual([]);
    const bare = ok(zoned, 'edit_zone', { part: part.part, zone: zoneId });
    expect(bare.document.composites?.zones[zoneId]).toEqual(zone);
  });

  it('refuses invalid stacks and boundaries with the offending token / vertex', () => {
    const base = {
      part: part.part,
      name: 'Z2',
      boundary: [
        [10, 10],
        [50, 10],
        [50, 50],
      ],
      laminate: '[0/90]s',
    };
    expect(expectRefusal(part.doc, 'define_zone', { ...base, laminate: '[45/-45/0/9O]s' }, 'CMP_NOTATION_PARSE').summary).toContain('9O');
    expect(
      expectRefusal(
        part.doc,
        'define_zone',
        {
          ...base,
          boundary: [
            [0, 0],
            [10, 10],
          ],
        },
        'CMP_ZONE_BOUNDARY_INVALID',
      ).summary,
    ).toContain('3 vertices');
    expect(
      expectRefusal(
        part.doc,
        'define_zone',
        {
          ...base,
          boundary: [
            [0, 0],
            [10, 0],
            [20, 0],
          ],
        },
        'CMP_ZONE_BOUNDARY_INVALID',
      ).summary,
    ).toContain('zero area');
    expect(
      expectRefusal(
        part.doc,
        'define_zone',
        {
          ...base,
          boundary: [
            [0, 0],
            [10, 0],
            [0, 10],
            [8, 10],
          ],
        },
        'CMP_ZONE_BOUNDARY_INVALID',
      ).summary,
    ).toContain('crosses');
    expect(
      expectRefusal(
        part.doc,
        'define_zone',
        {
          ...base,
          boundary: [
            [0, 0],
            [700, 0],
            [700, 10],
          ],
        },
        'CMP_ZONE_BOUNDARY_INVALID',
      ).summary,
    ).toContain('outside');
    expectRefusal(part.doc, 'define_zone', { ...base, part: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(zoned, 'define_zone', { ...base, name: 'Z-base' }, 'CMP_NAME_TAKEN');
  });

  it('refuses edits and deletions of unknown zones and bad values', () => {
    expectRefusal(zoned, 'edit_zone', { part: 'nope', zone: 'x' }, 'CMP_REF_MISSING');
    expectRefusal(zoned, 'edit_zone', { part: part.part, zone: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(zoned, 'edit_zone', { part: part.part, zone: zoneId, laminate: '[x]s' }, 'CMP_NOTATION_PARSE');
    expectRefusal(
      zoned,
      'edit_zone',
      {
        part: part.part,
        zone: zoneId,
        boundary: [
          [0, 0],
          [1, 0],
        ],
      },
      'CMP_ZONE_BOUNDARY_INVALID',
    );
    const two = apply(zoned, 'define_zone', {
      part: part.part,
      name: 'Z2',
      boundary: [
        [10, 10],
        [50, 10],
        [50, 50],
      ],
      laminate: '[0/90]s',
    });
    expectRefusal(two, 'edit_zone', { part: part.part, zone: 'Z2', name: 'Z-base' }, 'CMP_NAME_TAKEN');
    expectRefusal(zoned, 'delete_zone', { part: 'nope', zone: 'x' }, 'CMP_REF_MISSING');
    expectRefusal(zoned, 'delete_zone', { part: part.part, zone: 'nope' }, 'CMP_REF_MISSING');
  });

  it('is pure', () => {
    expectPure(zoned, () => execute(zoned, 'edit_zone', { part: part.part, zone: zoneId, laminate: '[0/90]s' }));
  });
});

describe('part rules', () => {
  it('stores ply drop rules with named defaults and validates them', () => {
    const set = ok(part.doc, 'set_ply_drop_rules', { part: part.part, rampRatio: 30 });
    expect(set.document.composites?.parts[part.part]?.plyDropRules).toEqual({
      rampRatio: 30,
      minStagger: 3,
      staggerUnit: 'dropped_thickness',
      dropOrder: 'inner_first',
      coverPlies: 1,
    });
    expectRefusal(part.doc, 'set_ply_drop_rules', { part: part.part, rampRatio: 0.5 }, 'CMP_PARAM_INVALID');
    expectRefusal(part.doc, 'set_ply_drop_rules', { part: part.part, coverPlies: 1.5 }, 'CMP_PARAM_INVALID');
    expectRefusal(part.doc, 'set_ply_drop_rules', { part: 'nope' }, 'CMP_REF_MISSING');
  });

  it('stores laminate rules, requires a known rule key for disabling and a part', () => {
    const set = ok(part.doc, 'set_laminate_rules', {
      part: part.part,
      minFraction: 0.2,
      disable: [{ rule: 'R5', justification: 'cover ply is 0 for stiffness' }],
    });
    expect(set.document.composites?.parts[part.part]?.rules).toMatchObject({
      minFraction: 0.2,
      maxConsecutive: 4,
      disabled: [{ rule: 'R5' }],
    });
    expectRefusal(part.doc, 'set_laminate_rules', { part: part.part, disable: [{ rule: 'R9', justification: 'x' }] }, 'CMP_PARAM_INVALID');
    expectRefusal(part.doc, 'set_laminate_rules', { part: part.part, minFraction: 2 }, 'CMP_PARAM_INVALID');
    expectRefusal(part.doc, 'set_laminate_rules', { part: 'nope' }, 'CMP_REF_MISSING');
  });
});
