/** VIS-M8f: the viewport's appearance resolution equals render_view's precedence (core applyReviewStyle) on a table of cases. */
import { describe, expect, it } from 'vitest';
import { applyReviewStyle } from '@core/commands/render/reviewStyle';
import { execute } from '@core/commands/registry';
import { findProfile } from '@core/model/display';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { entityPbrMaterial } from '@ui/viewport/3d/review/materialClassAppearance';
import { profileTints } from '@ui/viewport/3d/review/profileTints';

const run = (doc: CadDocument, name: string, params: unknown): CadDocument => execute(doc, name, params).document;

/** box A (rule 'kind=box' matches boxes only), box B, sphere C, a 2D line D; every case assigns classes and optionally a profile. */
function scene(): { doc: CadDocument; ids: Record<'A' | 'B' | 'C' | 'D', string> } {
  let doc = createEmptyDocument();
  doc = run(doc, 'add_box', { position: [0, 0, 0], size: [1, 1, 1], color: '#111111' });
  doc = run(doc, 'add_box', { position: [3, 0, 0], size: [1, 1, 1], color: '#222222' });
  doc = run(doc, 'add_sphere', { position: [6, 0, 0], radius: 1, color: '#333333' });
  doc = run(doc, 'draw_polyline', {
    points: [
      [0, 0],
      [1, 1],
    ],
  });
  const [A, B, C, D] = doc.order as [string, string, string, string];
  return { doc, ids: { A, B, C, D } };
}

const withProfile = (doc: CadDocument, defaultColour: string | undefined): CadDocument => {
  let next = run(doc, 'define_colour_profile', {
    id: 'p',
    name: 'P',
    rules: [{ id: 'r1', when: { property: 'kind', equals: 'sphere' }, colour: '#ff0000', legend: 'Spheres' }],
    ...(defaultColour !== undefined && { defaultColour }),
  });
  next = run(next, 'set_active_colour_profile', { profileId: 'p' });
  return next;
};

const cases: { label: string; profile: boolean; defaultColour?: string; classes: [string, string][] }[] = [
  { label: 'no class, no profile', profile: false, classes: [] },
  { label: 'class colour only', profile: false, classes: [['A', 'stainless_steel']] },
  { label: 'colourless class keeps the entity colour', profile: false, classes: [['A', 'structural_steel_painted']] },
  { label: 'rule beats class', profile: true, classes: [['C', 'concrete']] },
  { label: 'class beats profile default', profile: true, defaultColour: '#00ff00', classes: [['A', 'galvanized_steel']] },
  { label: 'profile default where no class', profile: true, defaultColour: '#00ff00', classes: [['A', 'galvanized_steel']] },
  {
    label: 'colourless class falls to the profile default',
    profile: true,
    defaultColour: '#00ff00',
    classes: [['B', 'carbon_steel_pipe_painted']],
  },
  {
    label: 'mixed',
    profile: true,
    classes: [
      ['A', 'frp'],
      ['B', 'structural_steel_painted'],
      ['C', 'grating'],
    ],
  },
];

describe('profileTints with material classes = render_view colours', () => {
  it.each(cases)('$label', ({ profile, defaultColour, classes }) => {
    const { doc: base, ids } = scene();
    let doc = profile ? withProfile(base, defaultColour) : base;
    for (const [key, classId] of classes) doc = run(doc, 'assign_material_class', { classId, entityIds: [ids[key as keyof typeof ids]] });
    const tints = profileTints(doc, []);
    const style = {
      profile: profile && doc.display !== undefined ? (findProfile(doc.display, 'p') ?? null) : null,
      box: null,
      visibility: null,
      highlight: null,
      notes: [],
    };
    const styled = applyReviewStyle(doc, style, undefined, undefined).scene;
    for (const id of doc.order) {
      const entity = doc.entities[id];
      expect(tints.get(id) ?? entity?.color, id).toBe(styled.entities[id]?.color);
    }
  });
});

describe('entityPbrMaterial', () => {
  it('is the class metalness / roughness, else the document material (same object), else nothing', () => {
    const { doc, ids } = scene();
    expect(entityPbrMaterial(doc, doc.entities[ids.A]!)).toBeUndefined();
    const classed = run(doc, 'assign_material_class', { classId: 'stainless_steel', entityIds: [ids.A] });
    expect(entityPbrMaterial(classed, classed.entities[ids.A]!)).toMatchObject({ color: '#111111', metalness: 0.9, roughness: 0.3 });
    expect(entityPbrMaterial(classed, classed.entities[ids.B]!)).toBeUndefined();
    const line = run(classed, 'assign_material_class', { classId: 'stainless_steel', entityIds: [ids.D] });
    expect(entityPbrMaterial(line, line.entities[ids.D]!)).toBeUndefined();
  });

  it('lays the class surface over a document material and keeps its colour', () => {
    const { doc, ids } = scene();
    const withMaterial = {
      ...doc,
      materials: { m1: { id: 'm1', name: 'M', color: '#abcdef', metalness: 0.1, roughness: 0.9 } },
      entities: { ...doc.entities, [ids.A]: { ...doc.entities[ids.A]!, materialId: 'm1' } },
    } as unknown as CadDocument;
    expect(entityPbrMaterial(withMaterial, withMaterial.entities[ids.A]!)).toBe(withMaterial.materials['m1']);
    const classed = run(withMaterial, 'assign_material_class', { classId: 'concrete', entityIds: [ids.A] });
    expect(entityPbrMaterial(classed, classed.entities[ids.A]!)).toMatchObject({ color: '#abcdef', metalness: 0, roughness: 0.9 });
  });
});
